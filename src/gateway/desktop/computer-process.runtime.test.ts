import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createCompiledSdkHost } from "../../plugins/compiled-sdk-host.test-support.js";
import { computerUseSdkEntrypoint } from "../../plugins/loader-sdk-bridge-artifacts.test-support.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
} from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { startComputerHostProcess } from "./computer-process.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["sync", "async", "reject"] as const)(
  "drains %s provider cleanup through the private worker before exiting",
  async (cleanupMode) => {
    const home = tempDirs.make("openclaw-computer-worker-");
    const pluginRoot = path.join(home, "plugin");
    fs.mkdirSync(pluginRoot);
    const pluginId = "fixture-computer";
    const fixture = createColdPluginFixture({
      rootDir: pluginRoot,
      pluginId,
      manifest: { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] },
    });
    const lifecycleFile = path.join(home, "provider-lifecycle.txt");
    fs.writeFileSync(
      fixture.runtimeSource,
      `
const { appendFileSync } = require("node:fs");
const { registerComputerUseProvider } = require("openclaw/plugin-sdk/computer-use");
const record = (event) => appendFileSync(${JSON.stringify(lifecycleFile)}, event + "\\n");
process.once("exit", (code) => record("exit:" + code));
module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    registerComputerUseProvider(api, {
      id: ${JSON.stringify(pluginId)},
      label: "Synthetic computer",
      isAvailable: () => true,
      watchAvailability: () => () => {
        record("watch-stop:start");
        const finish = () => {
          record("watch-stop:done");
          if (${JSON.stringify(cleanupMode)} === "reject") {
            throw new Error("synthetic watcher cleanup failed");
          }
        };
        if (${JSON.stringify(cleanupMode)} === "sync") {
          finish();
          return;
        }
        return require("node:fs/promises").readFile(${JSON.stringify(lifecycleFile)}).then(finish);
      },
      capabilities: () => ({
        contractVersion: 2,
        provider: { id: ${JSON.stringify(pluginId)}, label: "Synthetic computer", generation: "fixture-generation" },
        actions: ["screenshot", "left_click"],
        targets: ["screen"], deliveryModes: ["foreground"], observations: ["image"],
        features: { recording: false, agentCursor: false, multiDisplay: false },
      }),
      async openExecution({ executionId, sessionKey }) {
        record("open:" + executionId);
        return {
          async snapshot() { return JSON.stringify({ format: "png", base64: "c3ludGhldGljLXBpeGVscw==" }); },
          async act(paramsJSON) {
            const params = JSON.parse(paramsJSON);
            return JSON.stringify({ ok: true, action: params.action, details: { executionId, sessionKey } });
          },
          async close(reason) { record("close:" + reason); },
        };
      },
    });
  },
};
`,
    );
    const config = createColdPluginConfig(pluginRoot, pluginId);
    config.plugins!.allow = [pluginId];
    const configPath = path.join(home, "openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify(config));
    const sdkHost = createCompiledSdkHost([computerUseSdkEntrypoint], (prefix) =>
      tempDirs.make(prefix),
    );
    // A non-Node `node` earlier on PATH must not become the host worker runtime.
    const shimDir = path.join(home, "shim");
    fs.mkdirSync(shimDir);
    const shimName = process.platform === "win32" ? "node.cmd" : "node";
    fs.writeFileSync(
      path.join(shimDir, shimName),
      process.platform === "win32" ? "@exit /b 42\r\n" : "#!/bin/sh\nexit 42\n",
      // Windows ignores the exec bit; POSIX needs it for the PATH scan to accept the shim.
      process.platform === "win32" ? {} : { mode: 0o755 },
    );
    const child = startComputerHostProcess({
      env: {
        PATH: `${shimDir}${path.delimiter}${path.dirname(process.execPath)}`,
        HOME: home,
        USERPROFILE: home,
        OPENCLAW_HOME: home,
        OPENCLAW_STATE_DIR: path.join(home, "state"),
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        ...(sdkHost ? { OPENCLAW_DEV_SOURCE_ROOT: sdkHost } : {}),
        NODE_ENV: "test",
      },
      pluginIds: [pluginId],
      assertCurrent: () => {},
    });
    const executionId = "123e4567-e89b-42d3-a456-426614174000";
    try {
      expect((await child.ready).provider).toEqual({
        id: pluginId,
        label: "Synthetic computer",
        generation: "fixture-generation",
      });
      await expect(
        child.invoke({
          command: "screen.snapshot",
          params: { executionId },
          sessionKey: "fixture-session",
          assertCurrent: () => {},
        }),
      ).resolves.toEqual({ format: "png", base64: "c3ludGhldGljLXBpeGVscw==" });
      await expect(
        child.invoke({
          command: "computer.act",
          params: { executionId, action: "left_click", x: 1, y: 2 },
          sessionKey: "fixture-session",
          assertCurrent: () => {},
        }),
      ).resolves.toEqual({
        ok: true,
        action: "left_click",
        details: { executionId, sessionKey: "fixture-session" },
      });
    } finally {
      const closing = child.close({ executionId, reason: "completion" });
      if (cleanupMode === "reject") {
        await expect(closing).rejects.toThrow("Gateway computer helper shutdown failed");
      } else {
        await closing;
      }
    }
    expect(child.isCurrent()).toBe(false);
    expect(fs.readFileSync(lifecycleFile, "utf8").trim().split("\n")).toEqual([
      `open:${executionId}`,
      "close:completion",
      "watch-stop:start",
      "watch-stop:done",
      cleanupMode === "reject" ? "exit:1" : "exit:0",
    ]);
  },
  90_000,
);
