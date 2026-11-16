import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { writeBundledSetupChannelPlugin } from "../channels/plugins/read-only.test-support.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
} from "../plugins/loader.test-fixtures.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { defaultRuntime } from "../runtime.js";
import { agentsListCommand } from "./agents.commands.list.js";
import { channelsListCommand } from "./channels/list.js";

vi.mock("../plugins/bundled-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/bundled-dir.js")>();
  return {
    ...actual,
    resolveBundledPluginsDir: (env: NodeJS.ProcessEnv = process.env) =>
      env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? actual.resolveBundledPluginsDir(env),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetPluginLoaderTestStateForTest();
  resetPluginRuntimeStateForTest();
});

afterAll(cleanupPluginLoaderFixturesForTest);

// Mirrors Matrix (#190243): the legacy sync auth probe goes through a deprecated
// SDK path and emits DEP_PLUGIN_SDK; the async probe does not.
describe("list command deprecation warnings", () => {
  it.each(["channels", "agents"] as const)(
    "%s list emits no DEP_PLUGIN_SDK warning for saved auth",
    async (command) => {
      const stateDir = makePluginLoaderTempDir();
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const persistedAuthPath = path.join(stateDir, "linked-auth");
      const asyncProbePath = path.join(stateDir, "async-probe");
      const { channelId, pluginDir } = writeBundledSetupChannelPlugin({ persistedAuthPath });
      const packagePath = path.join(pluginDir, "package.json");
      const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      pkg.openclaw.channel.persistedAuthState.exportNameAsync = "hasAuthAsync";
      fs.writeFileSync(packagePath, JSON.stringify(pkg));
      fs.writeFileSync(
        path.join(pluginDir, "auth-state.cjs"),
        `const fs = require("node:fs");
  exports.hasAuth = () => {
    process.emitWarning("Plugin ${channelId}: sync auth state is deprecated", { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" });
    return fs.existsSync(${JSON.stringify(persistedAuthPath)});
  };
  exports.hasAuthAsync = async () => {
    fs.writeFileSync(${JSON.stringify(asyncProbePath)}, "called");
    return fs.existsSync(${JSON.stringify(persistedAuthPath)});
  };`,
      );
      fs.writeFileSync(persistedAuthPath, "linked");
      const configPath = path.join(stateDir, "openclaw.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          agents: { ownership: "explicit", entries: { main: { workspace: stateDir } } },
          plugins: { allow: [channelId], entries: { [channelId]: { enabled: true } } },
        }),
      );
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      const warnings: { code?: string; message: string }[] = [];
      const onWarning = (warning: Error & { code?: string }) =>
        warnings.push({ code: warning.code, message: warning.message });
      const emitWarning = vi.spyOn(process, "emitWarning");
      process.on("warning", onWarning);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      vi.spyOn(defaultRuntime, "log").mockReturnValue(undefined);

      try {
        if (command === "channels") {
          await channelsListCommand({ json: true }, runtime as never);
        } else {
          await agentsListCommand({});
        }
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      } finally {
        process.off("warning", onWarning);
      }

      const emittedCodes = emitWarning.mock.calls.map(
        ([, options]) => (options as { code?: string } | undefined)?.code,
      );
      emitWarning.mockRestore();
      if (command === "agents") {
        expect(fs.existsSync(asyncProbePath)).toBe(true);
      }
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(emittedCodes).not.toContain("DEP_PLUGIN_SDK");
      expect(warnings.filter((warning) => warning.code === "DEP_PLUGIN_SDK")).toEqual([]);
    },
  );
});
