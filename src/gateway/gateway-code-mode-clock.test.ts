import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { isRecord } from "../utils.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  createGatewayConfigPath,
  nextGatewayId,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { startGatewayServer } from "./server.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { startClaimedGateway } from "./test-helpers.listener.js";
import { createTrackedProvider } from "./test-helpers.tracked-provider.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

beforeEach(resetGatewayTestState);

afterEach(resetGatewayTestState);

it(
  "preserves a Code Mode approval budget across a wall-clock rollback in a real Gateway",
  { timeout: 120_000 },
  async () => {
    const { envSnapshot, tempHome, workspaceDir } = await setupGatewayTempHome({
      prefix: "openclaw-gw-code-mode-clock-",
    });
    const deviceIdentity = loadOrCreateDeviceIdentity({
      path: path.join(
        tempHome,
        ".openclaw",
        "test-device-identities",
        `${GATEWAY_CLIENT_NAMES.TEST}-${GATEWAY_CLIENT_MODES.TEST}-${process.platform}-none-operator`,
        "client",
        "credentials.sqlite",
      ),
    });
    const token = nextGatewayId("code-mode-clock-token");
    const approvalPluginId = "code-mode-clock-proof";
    const approvalPluginPath = path.join(workspaceDir, ".openclaw", "extensions", approvalPluginId);
    await fs.mkdir(approvalPluginPath, { recursive: true });
    await fs.writeFile(
      path.join(approvalPluginPath, "openclaw.plugin.json"),
      JSON.stringify({
        id: approvalPluginId,
        activation: { onStartup: true },
        contracts: { tools: ["code_mode_clock_approval"] },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(approvalPluginPath, "index.cjs"),
      `module.exports = {
  id: ${JSON.stringify(approvalPluginId)},
  register(api) {
    api.on("before_tool_call", (event) => {
      if (event.toolName !== "code_mode_clock_approval") return;
      return {
        requireApproval: {
          pluginId: ${JSON.stringify(approvalPluginId)},
          title: "Code Mode clock rollback proof",
          description: "Approve the isolated clock rollback proof tool.",
          allowedDecisions: ["allow-once", "deny"],
          timeoutMs: 30_000,
        },
      };
    });
    api.registerTool({
      name: "code_mode_clock_approval",
      label: "Code Mode clock approval",
      description: "A deterministic approval-gated proof tool.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return { content: [{ type: "text", text: "CODE_MODE_APPROVAL_OK" }] };
      },
    });
  },
};
`,
      "utf8",
    );

    const responseBodies: Array<{ input?: unknown[] }> = [];
    let approvalId = "";
    let restoreWallClock = () => {};
    const provider = createTrackedProvider((raw, response, request) => {
      if (request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as { input?: unknown[] };
      responseBodies.push(body);
      const hasToolOutput = body.input?.some(
        (item) => isRecord(item) && item.type === "function_call_output",
      );
      if (!hasToolOutput) {
        const item = {
          type: "function_call",
          id: "fc_code_mode_clock",
          call_id: "call_code_mode_clock",
          name: "exec",
          arguments: JSON.stringify({
            title: "Verify the approval clock budget",
            code: "return await code_mode_clock_approval({});",
          }),
          status: "completed",
        };
        const position = { item_id: item.id, output_index: 0 };
        writeOpenAiResponsesSse(response, [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, status: "in_progress", arguments: "" },
          },
          {
            type: "response.function_call_arguments.delta",
            ...position,
            delta: item.arguments,
          },
          {
            type: "response.function_call_arguments.done",
            ...position,
            arguments: item.arguments,
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "resp_code_mode_clock_call",
              status: "completed",
              output: [item],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ]);
      } else {
        writeOpenAiResponsesText(response, {
          text: "CODE_MODE_APPROVAL_COMPLETE",
          messageId: "msg_code_mode_clock_final",
          responseId: "resp_code_mode_clock_final",
        });
      }
    });
    const openaiBaseUrl = await provider.listen();

    try {
      const configPath = await createGatewayConfigPath(tempHome);
      const mockProvider = buildMockOpenAiResponsesProvider(openaiBaseUrl);
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: workspaceDir,
            model: { primary: mockProvider.modelRef },
            models: {
              [mockProvider.modelRef]: {
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
            skipBootstrap: true,
          },
          entries: { main: {} },
        },
        plugins: { allow: [approvalPluginId] },
        tools: {
          profile: "full",
          codeMode: { enabled: true, timeoutMs: 10_000 },
          alsoAllow: ["code_mode_clock_approval"],
        },
        models: {
          mode: "replace",
          providers: { [mockProvider.providerId]: mockProvider.config },
        },
        gateway: { auth: { mode: "token", token } },
      };
      await fs.writeFile(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
      const { port } = portClaim;
      const server = await startClaimedGateway(portClaim, () =>
        startGatewayServer(port, {
          bind: "loopback",
          auth: { mode: "token", token },
          controlUiEnabled: false,
        }),
      );
      const client = await connectGatewayClient({
        url: "ws://127.0.0.1:" + port,
        token,
        clientName: GATEWAY_CLIENT_NAMES.TUI,
        clientDisplayName: "code-mode-clock-proof",
        mode: GATEWAY_CLIENT_MODES.UI,
        scopes: ["operator.admin", "operator.approvals"],
        caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
        deviceIdentity,
        onEvent: (event) => {
          const payload = event.payload;
          if (
            !isRecord(payload) ||
            (event.event !== "plugin.approval.requested" &&
              event.event !== "plugin.approval.resolved")
          ) {
            return;
          }
          const request = payload.request;
          if (
            event.event === "plugin.approval.requested" &&
            (!isRecord(request) || request.pluginId !== approvalPluginId)
          ) {
            return;
          }
          const id = payload.id;
          if (typeof id === "string") {
            approvalId = id;
          }
          if (event.event === "plugin.approval.resolved" && id === approvalId) {
            restoreWallClock();
          }
        },
      });
      try {
        await server.startupSettled;
        const sessionKey = "agent:main:code-mode-clock";
        const runId = nextGatewayId("code-mode-clock-run");
        const started = await client.request<{ runId?: string; status?: string }>(
          "chat.send",
          {
            sessionKey,
            idempotencyKey: runId,
            message: "Run the Code Mode approval proof once.",
            deliver: false,
            originatingChannel: "tui",
            originatingTo: "clock-proof",
          },
          { expectFinal: false },
        );
        expect(started.status).toBe("started");
        expect(started.runId).toBeTruthy();

        await vi.waitFor(() => expect(approvalId).toBeTruthy(), {
          timeout: 30_000,
          interval: 20,
        });

        const wallClockBeforeRollback = Date.now();
        const wallClock = vi.spyOn(Date, "now").mockReturnValue(wallClockBeforeRollback - 5_000);
        restoreWallClock = () => wallClock.mockRestore();
        try {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 50);
          });
          await expect(
            client.request("plugin.approval.resolve", {
              id: approvalId,
              decision: "allow-once",
            }),
          ).resolves.toEqual({ ok: true });
        } finally {
          restoreWallClock();
        }

        const completed = await client.request<{ status?: string }>(
          "agent.wait",
          { runId: started.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        );
        expect(completed.status).toBe("ok");
        const history = await client.request<{ messages: unknown[] }>("chat.history", {
          sessionKey,
        });
        expect(JSON.stringify(history.messages)).toContain("CODE_MODE_APPROVAL_COMPLETE");
        expect(responseBodies).toHaveLength(2);
        const output = responseBodies[1]?.input?.find(
          (item) => isRecord(item) && item.type === "function_call_output",
        );
        expect(output).toMatchObject({
          type: "function_call_output",
          output: expect.any(String),
        });
        const result = JSON.parse(String((output as { output?: unknown }).output)) as {
          status?: unknown;
        };
        expect(result.status).toBe("completed");
      } finally {
        await disconnectGatewayClient(client);
        await server.close({ reason: "Code Mode clock rollback proof complete" });
      }
    } finally {
      try {
        await provider.close();
      } finally {
        await removeGatewayTempHome(tempHome);
        envSnapshot.restore();
      }
    }
  },
);
