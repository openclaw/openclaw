import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadOpenClawPlugins } from "./loader.js";
import { executeRegisteredPluginCommand } from "./plugin-command-execution.js";
import { listRegisteredPluginCommands } from "./plugin-command-registry.js";

const tempDirectories = useAutoCleanupTempDirTracker(afterEach);

const packagedConsumerSource = `
export default {
  id: "gate-a-fork-workflow",
  register(api) {
    api.registerCommand({
      name: "gate-fork-proof",
      description: "Isolated fork placement and Back proof",
      requireAuth: true,
      handler: async (ctx) => {
        const host = ctx.runtimeContext?.conversationFork;
        if (
          host?.version !== 1 ||
          typeof host.prepare !== "function" ||
          typeof host.execute !== "function" ||
          typeof host.back !== "function"
        ) return { text: "unavailable" };
        if (ctx.args?.trim() === "back") {
          const result = await host.back();
          return { text: result?.status === "returned" ? "returned" : "back-" + String(result?.status) };
        }
        if (ctx.args?.trim() !== "start") return { text: "usage: start|back" };
        const plan = await host.prepare({ title: "Isolated fork proof" });
        if (plan?.status !== "ready" || typeof plan.ticket !== "string") {
          return { text: "prepare-" + String(plan?.status) };
        }
        const placed = await host.execute({ ticket: plan.ticket, placement: "current" });
        return { text: placed?.status === "placed" ? "placed" : "placement-" + String(placed?.status) };
      },
    });
  },
};
`;

describe("isolated packaged conversation-fork registered command", () => {
  it("loads an isolated third-party package without host checkout files", async () => {
    const tempRoot = tempDirectories.make("openclaw-fork-plugin-");
    const packagedPluginPath = path.join(tempRoot, "plugin");
    fs.mkdirSync(packagedPluginPath);
    fs.writeFileSync(path.join(packagedPluginPath, "index.js"), packagedConsumerSource);
    fs.writeFileSync(
      path.join(packagedPluginPath, "package.json"),
      JSON.stringify({
        name: "gate-a-fork-workflow",
        version: "0.0.1",
        type: "module",
        main: "./index.js",
        openclaw: { extensions: ["./index.js"] },
      }),
    );
    fs.writeFileSync(
      path.join(packagedPluginPath, "openclaw.plugin.json"),
      JSON.stringify({
        id: "gate-a-fork-workflow",
        name: "Gate A Isolated Fork Workflow",
        version: "0.0.1",
        description: "Independent fork-invoking proof consumer",
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
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
