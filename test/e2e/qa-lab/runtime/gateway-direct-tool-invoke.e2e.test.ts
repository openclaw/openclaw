import { afterEach, expect, it } from "vitest";
import { createConfigIO } from "../../../../src/config/config.js";
import { WRITE_SCOPE } from "../../../../src/gateway/operator-scopes.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { installGatewayTestHooks, testState } from "../../../../src/gateway/test-helpers.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../../src/plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../../../src/plugins/hooks.test-helpers.js";

installGatewayTestHooks();

const GATEWAY_TOKEN = "qa-direct-tool-invoke-token";
const AGENTS_LIST_ARGS = { name: "agents_list", args: {}, sessionKey: "main" };

type JsonRecord = Record<string, unknown>;

function readToolCallId(value: unknown): string {
  const toolCallId =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { toolCallId?: unknown }).toolCallId
      : undefined;
  if (typeof toolCallId !== "string") {
    throw new Error("before_tool_call event omitted toolCallId");
  }
  return toolCallId;
}

function installHook(handler: (event: unknown) => unknown) {
  initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_tool_call", handler }]));
}

afterEach(resetGlobalHookRunner);

it(
  "bridges real HTTP and RPC invocations to plugin approval hooks with stable call IDs",
  { timeout: 60_000 },
  async () => {
    testState.agentsConfig = { entries: { main: { tools: { allow: ["agents_list"] } } } };

    const observedToolCallIds: string[] = [];
    installHook((event) => {
      observedToolCallIds.push(readToolCallId(event));
    });

    const gateway = await startGatewayWithClient({
      configPath: createConfigIO().configPath,
      cfg: { gateway: { mode: "local", auth: { mode: "token", token: GATEWAY_TOKEN } } },
      token: GATEWAY_TOKEN,
      scopes: [WRITE_SCOPE],
      clientDisplayName: "direct-tool-invoke-writer",
    });
    const invoke = async (body: JsonRecord) => {
      const response = await fetch(`http://127.0.0.1:${gateway.port}/tools/invoke`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${GATEWAY_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as JsonRecord };
    };
    const httpArgs = { tool: "agents_list", args: {}, sessionKey: "main" };

    try {
      expect(await invoke({})).toEqual({
        status: 400,
        body: {
          ok: false,
          error: { type: "invalid_request", message: "tools.invoke requires name" },
        },
      });
      expect(observedToolCallIds).toEqual([]);
      for (const idempotencyKey of [undefined, "qa-http-stable", "qa-http-stable"]) {
        expect(await invoke({ ...httpArgs, idempotencyKey })).toMatchObject({
          status: 200,
          body: { ok: true },
        });
      }

      const rpc = (args: JsonRecord) =>
        gateway.client.request(
          "tools.invoke",
          { ...AGENTS_LIST_ARGS, ...args },
          { timeoutMs: 10_000 },
        );
      for (let index = 0; index < 2; index += 1) {
        expect(await rpc({ idempotencyKey: "qa-rpc-stable" })).toMatchObject({
          ok: true,
          toolName: "agents_list",
        });
      }

      // Repeated calls still traverse the hook; this asserts stable IDs, not deduplication.
      expect(observedToolCallIds).toEqual([
        expect.stringMatching(/^http-direct-operator-\d+$/),
        "http-direct-operator-qa-http-stable",
        "http-direct-operator-qa-http-stable",
        "rpc-delegated-qa-rpc-stable",
        "rpc-delegated-qa-rpc-stable",
      ]);

      const approvalToolCallIds: string[] = [];
      installHook((event) => {
        const toolCallId = readToolCallId(event);
        approvalToolCallIds.push(toolCallId);
        return toolCallId.startsWith("rpc-")
          ? {
              requireApproval: {
                title: "Direct invoke approval",
                description: "Operator approval required by QA policy",
              },
            }
          : {
              block: true,
              blockReason: "Blocked by QA policy",
            };
      });

      expect(await rpc({ confirm: false, idempotencyKey: "qa-rpc-approval" })).toEqual({
        ok: false,
        toolName: "agents_list",
        requiresApproval: true,
        error: {
          code: "requires_approval",
          message: "Operator approval required by QA policy",
        },
      });

      expect(await invoke({ ...httpArgs, idempotencyKey: "qa-http-blocked" })).toEqual({
        status: 403,
        body: {
          ok: false,
          error: {
            type: "tool_call_blocked",
            message: "Blocked by QA policy",
            requiresApproval: false,
          },
        },
      });
      expect(approvalToolCallIds).toEqual([
        "rpc-delegated-qa-rpc-approval",
        "http-direct-operator-qa-http-blocked",
      ]);
    } finally {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "Gateway direct tool invoke QA proof complete" });
    }
  },
);
