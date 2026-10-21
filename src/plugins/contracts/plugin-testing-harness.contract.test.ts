import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginRegistryFixture,
  describePluginRegistrationContract,
  pluginRegistrationContractCases,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";

function echoTool(prefix: string, home: string) {
  return {
    name: "fixture_echo",
    label: "Fixture Echo",
    description: "Echo a fixture value",
    parameters: {},
    execute: async (_toolCallId: string, params: unknown) => {
      const message = (params as { message: string }).message;
      return {
        content: [{ type: "text" as const, text: `${prefix}:${message}` }],
        details: { home, message },
      };
    },
  };
}

describePluginRegistrationContract(pluginRegistrationContractCases.brave);

describe("plugin testing harness contracts", () => {
  it("executes declared tools and reports missing tool contracts", async () => {
    const previousHome = process.env.HOME;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;

    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      await expect(
        fs.stat(path.join(stateDir, "agents", "main", "sessions")),
      ).resolves.toBeDefined();
      expect(process.env.HOME).toBe(home);
      expect(process.env.OPENCLAW_STATE_DIR).toBe(stateDir);

      const { config, registry } = createPluginRegistryFixture({
        plugins: { entries: { "fixture-echo": { config: { prefix: "scoped" } } } },
      });

      registerVirtualTestPlugin({
        registry,
        config,
        id: "fixture-echo",
        name: "Fixture Echo",
        contracts: { tools: ["fixture_echo"] },
        register(api) {
          const prefix = api.config.plugins?.entries?.["fixture-echo"]?.config?.prefix;
          if (typeof prefix !== "string") {
            throw new Error("fixture prefix missing");
          }
          api.registerTool(echoTool(prefix, home));
        },
      });

      expect(registry.registry.tools).toHaveLength(1);
      const registration = registry.registry.tools[0];
      expect(registration).toMatchObject({ pluginId: "fixture-echo", names: ["fixture_echo"] });
      const tool = registration?.factory({ workspaceDir: home });
      if (!tool || Array.isArray(tool)) {
        throw new Error("expected one registered fixture tool");
      }
      expect(tool.name).toBe("fixture_echo");

      for (const [message, expected] of [
        ["alpha", "scoped:alpha"],
        ["beta", "scoped:beta"],
      ]) {
        await expect(tool.execute("fixture-call", { message })).resolves.toEqual({
          content: [{ type: "text", text: expected }],
          details: { home, message },
        });
      }
      expect(registry.registry.diagnostics).toEqual([]);

      const missingContract = createPluginRegistryFixture();
      registerVirtualTestPlugin({
        registry: missingContract.registry,
        config: missingContract.config,
        id: "missing-contract",
        name: "Missing Contract",
        register(api) {
          api.registerTool(echoTool("unused", home));
        },
      });

      expect(missingContract.registry.registry.tools).toEqual([]);
      expect(missingContract.registry.registry.diagnostics).toContainEqual({
        level: "error",
        pluginId: "missing-contract",
        source: "/virtual/missing-contract/index.ts",
        message: "plugin must declare contracts.tools before registering agent tools",
      });
    });

    expect(process.env.HOME).toBe(previousHome);
    expect(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
  });
});
