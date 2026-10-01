import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadOpenClawPlugins } from "./loader.js";
import { executeRegisteredPluginCommand } from "./plugin-command-execution.js";
import { listRegisteredPluginCommands } from "./plugin-command-registry.js";

const packageSource = path.resolve(
  import.meta.dirname,
  "../../test/fixtures/conversation-fork-workflow",
);
const tempDirectories = useAutoCleanupTempDirTracker(afterEach);

describe("isolated packaged conversation-fork registered command", () => {
  it("loads a committed third-party package fixture without host checkout files", async () => {
    const tempRoot = tempDirectories.make("openclaw-fork-plugin-");
    const packagedPluginPath = path.join(tempRoot, "plugin");
    fs.mkdirSync(packagedPluginPath);
    for (const name of ["index.js", "package.json", "openclaw.plugin.json"]) {
      fs.copyFileSync(path.join(packageSource, name), path.join(packagedPluginPath, name));
    }
    const config = {
      plugins: {
        enabled: true,
        load: { paths: [packagedPluginPath] },
        allow: ["gate-a-fork-workflow"],
      },
    };
    const registry = loadOpenClawPlugins({
      cache: false,
      config,
      onlyPluginIds: ["gate-a-fork-workflow"],
      installRecords: {},
      workspaceDir: path.join(tempRoot, "workspace"),
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    });
    const command = listRegisteredPluginCommands(registry).find(
      (entry) => entry.name === "gate-fork-proof",
    );
    expect(registry.plugins.find((entry) => entry.id === "gate-a-fork-workflow")?.status).toBe(
      "loaded",
    );
    expect(command?.pluginId).toBe("gate-a-fork-workflow");
    expect(command).toBeDefined();
    const result = await executeRegisteredPluginCommand(registry, {
      command: command!,
      args: "start",
      commandBody: "/gate-fork-proof start",
      config,
      channel: "telegram",
      isAuthorizedSender: true,
      senderId: "isolated-operator",
      agentId: "main",
    });
    expect(result.text).toBe("unavailable");
  });
});
