import { afterEach, expect, it } from "vitest";
import { createConfigIO, resetConfigRuntimeState } from "../../../../src/config/config.js";
import { READ_SCOPE, WRITE_SCOPE } from "../../../../src/gateway/operator-scopes.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import {
  getGatewayTestPort,
  installGatewayTestHooks,
  startTestGatewayServer,
  testState,
} from "../../../../src/gateway/test-helpers.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../../src/plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../../../src/plugins/hooks.test-helpers.js";
import { writeJsonFile } from "../../../helpers/temp-repo.js";

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

async function postInvoke(params: {
  port: number;
  body: string | JsonRecord;
  token?: string;
  scopes?: string;
}) {
  const response = await fetch(`http://127.0.0.1:${params.port}/tools/invoke`, {
    method: "POST",
    headers: {
      ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
      "content-type": "application/json",
      ...(params.scopes ? { "x-openclaw-scopes": params.scopes } : {}),
    },
    body: typeof params.body === "string" ? params.body : JSON.stringify(params.body),
  });
  return { status: response.status, body: (await response.json()) as JsonRecord };
}

function installHook(handler: (event: unknown) => unknown) {
  initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_tool_call", handler }]));
}

function expectAgentsListResult(value: unknown): void {
  expect(value).toMatchObject({
    details: {
      requester: "main",
      allowAny: false,
      agents: [expect.objectContaining({ id: "main", configured: true })],
    },
  });
}

afterEach(() => {
  resetGlobalHookRunner();
});

it(
  "enforces public auth, invocation, approval, and call-id contracts",
  { timeout: 60_000 },
  async () => {
    const port = await getGatewayTestPort();
    const configPath = createConfigIO().configPath;
    writeJsonFile(configPath, {
      gateway: {
        mode: "local",
        port,
        auth: { mode: "token", token: GATEWAY_TOKEN },
        tools: { allow: ["nodes"] },
      },
    });
    resetConfigRuntimeState();

    testState.agentsConfig = {
      entries: {
        main: { tools: { allow: ["agents_list", "nodes"] } },
      },
    };

    const observedToolCallIds: string[] = [];
    installHook((event) => {
      observedToolCallIds.push(readToolCallId(event));
    });

    let gateway: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
    let readOnlyClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    let writeClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    const invoke = (body: string | JsonRecord, scopes?: string) =>
      postInvoke({ port, token: GATEWAY_TOKEN, body, scopes });
    const connect = (scope: string, name: string) =>
      connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token: GATEWAY_TOKEN,
        scopes: [scope],
        clientDisplayName: name,
        deviceFamily: name,
        requestTimeoutMs: 10_000,
        timeoutMs: 10_000,
      });
    const httpArgs = { tool: "agents_list", args: {}, sessionKey: "main" };

    try {
      gateway = await startTestGatewayServer(port, {
        host: "127.0.0.1",
        auth: { mode: "token", token: GATEWAY_TOKEN },
        controlUiEnabled: false,
      });

      for (const token of [undefined, "wrong-token"]) {
        expect(await postInvoke({ port, token, body: httpArgs })).toEqual({
          status: 401,
          body: { error: { message: "Unauthorized", type: "unauthorized" } },
        });
      }
      for (const [body, status, expected] of [
        [
          "{",
          400,
          expect.objectContaining({
            error: expect.objectContaining({ type: "invalid_request_error" }),
          }),
        ],
        [
          {},
          400,
          {
            ok: false,
            error: { type: "invalid_request", message: "tools.invoke requires name" },
          },
        ],
        [
          { ...httpArgs, tool: "qa_missing_tool" },
          404,
          {
            ok: false,
            error: { type: "not_found", message: "Tool not available: qa_missing_tool" },
          },
        ],
      ] as const) {
        expect(await invoke(body)).toEqual({ status, body: expected });
      }
      expect(observedToolCallIds).toEqual([]);

      readOnlyClient = await connect(READ_SCOPE, "direct-tool-invoke-read-only");
      await expect(readOnlyClient.request("tools.invoke", AGENTS_LIST_ARGS)).rejects.toMatchObject({
        message: "missing scope: operator.write",
        details: {
          missingScope: "operator.write",
          requiredScopes: ["operator.write"],
        },
      });
      expect(observedToolCallIds).toEqual([]);

      const ownerRestored = await invoke(
        { ...httpArgs, tool: "nodes", action: "status" },
        "operator.approvals",
      );
      expect(ownerRestored.status).toBe(200);
      expect(ownerRestored.body.ok).toBe(true);
      expect(ownerRestored.body.result).toBeDefined();

      for (let index = 0; index < 2; index += 1) {
        const httpResult = await invoke({ ...httpArgs, idempotencyKey: "qa-http-stable" });
        expect(httpResult.status).toBe(200);
        expect(httpResult.body.ok).toBe(true);
        expectAgentsListResult(httpResult.body.result);
      }

      writeClient = await connect(WRITE_SCOPE, "direct-tool-invoke-writer");
      const writer = writeClient;
      const rpc = (args: JsonRecord) =>
        writer.request<{ output?: unknown }>("tools.invoke", { ...AGENTS_LIST_ARGS, ...args });
      const unavailableRpc = await rpc({ name: "qa_missing_tool" });
      expect(unavailableRpc).toEqual({
        ok: false,
        toolName: "qa_missing_tool",
        error: {
          code: "not_found",
          message: "Tool not available: qa_missing_tool",
        },
      });

      for (let index = 0; index < 2; index += 1) {
        const rpcResult = await rpc({ idempotencyKey: "qa-rpc-stable" });
        expect(rpcResult).toMatchObject({
          ok: true,
          toolName: "agents_list",
          source: "core",
        });
        expectAgentsListResult(rpcResult.output);
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

      const approvalRpc = await rpc({
        confirm: false,
        idempotencyKey: "qa-rpc-approval",
      });
      expect(approvalRpc).toEqual({
        ok: false,
        toolName: "agents_list",
        requiresApproval: true,
        error: {
          code: "requires_approval",
          message: "Operator approval required by QA policy",
        },
      });

      const blockedHttp = await invoke({ ...httpArgs, idempotencyKey: "qa-http-blocked" });
      expect(blockedHttp.status).toBe(403);
      expect(blockedHttp.body).toEqual({
        ok: false,
        error: {
          type: "tool_call_blocked",
          message: "Blocked by QA policy",
          requiresApproval: false,
        },
      });
      expect(approvalToolCallIds).toEqual([
        "rpc-delegated-qa-rpc-approval",
        "http-direct-operator-qa-http-blocked",
      ]);
    } finally {
      for (const client of [writeClient, readOnlyClient]) {
        if (client) {
          await disconnectGatewayClient(client);
        }
      }
      await gateway?.close({ reason: "Gateway direct tool invoke QA proof complete" });
    }
  },
);
