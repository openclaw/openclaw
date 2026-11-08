/** A path-loaded plugin explains tool availability through a real in-process Gateway. */
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { ToolAvailabilityReport } from "../agents/tool-availability-explanation.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createStartupTestState } from "./server-startup.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const PLUGIN_ID = "tool-availability-gateway-proof";

it("serves api.runtime.agent.explainToolAvailability from a plugin Gateway method", async () => {
  await using state = await createStartupTestState("tool-availability-gateway", {
    OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
  });
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  await runQaGatewayFixture(
    async () => {
      const pluginDir = state.path("plugin");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: PLUGIN_ID,
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        }),
      );
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: PLUGIN_ID,
          activation: { onStartup: true },
          configSchema: { type: "object" },
        }),
      );
      await fs.writeFile(
        path.join(pluginDir, "index.cjs"),
        `module.exports = { id: ${JSON.stringify(PLUGIN_ID)}, register(api) {
          api.registerGatewayMethod("toolprobe.explain", async ({ params, respond }) => {
            respond(true, await api.runtime.agent.explainToolAvailability({
              agentId: params.agentId,
              sessionKey: params.sessionKey,
              toolNames: params.toolNames,
              pluginId: params.pluginId,
            }));
          }, { scope: "operator.read" });
        } };`,
      );
      const token = "tool-availability-gateway-token";
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            model: { primary: "openai/gpt-5.5" },
          },
          entries: { main: {} },
        },
        tools: {
          allow: ["read", "browser", PLUGIN_ID],
          deny: ["browser"],
          byProvider: { openai: { deny: ["web_search"] } },
        },
        plugins: {
          allow: [PLUGIN_ID],
          load: { paths: [pluginDir] },
          slots: { memory: "none" },
        },
        gateway: { auth: { mode: "token", token } },
      };
      state.applyEnv();
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token,
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      await gateway.server.startupSettled;
      const { client } = gateway;

      const agentReport = await client.request<ToolAvailabilityReport>("toolprobe.explain", {
        agentId: "main",
        toolNames: ["read", "browser", "web_search", "exec"],
      });
      expect(agentReport).toEqual({
        agentId: "main",
        sandbox: { mode: "off", source: "agents.defaults.sandbox.mode" },
        tools: [
          { name: "read", available: true },
          {
            name: "browser",
            available: false,
            block: expect.objectContaining({ stage: "deny", source: "tools.deny" }),
          },
          {
            name: "web_search",
            available: false,
            block: expect.objectContaining({
              stage: "deny",
              source: 'tools.byProvider["openai"].deny',
            }),
          },
          {
            name: "exec",
            available: false,
            block: expect.objectContaining({
              stage: "allowlist",
              source: "tools.allow",
              fix: 'Add "exec" to tools.allow.',
            }),
          },
        ],
      });

      const sessionKey = "agent:main:dashboard:tool-availability";
      await client.request("sessions.create", { key: sessionKey, label: "Tool availability" });
      const sessionReport = await client.request<ToolAvailabilityReport>("toolprobe.explain", {
        sessionKey,
        toolNames: ["probe_tool"],
        pluginId: PLUGIN_ID,
      });
      expect(sessionReport).toEqual({
        agentId: "main",
        sandbox: { mode: "off", source: "agents.defaults.sandbox.mode", sandboxed: false },
        tools: [{ name: "probe_tool", available: true }],
      });
    },
    () => gateway && disconnectGatewayClient(gateway.client),
    () => gateway?.server.close({ reason: "tool availability proof complete" }),
  );
}, 120_000);
