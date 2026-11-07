import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMcpLifecycleServer } from "../agents/agent-bundle-mcp-lifecycle.test-support.js";
import {
  runWithSessionMcpRequestSignal,
  runWithSessionMcpToolCallAuthority,
} from "../agents/agent-bundle-mcp-request-context.js";
import { createSessionMcpRuntime } from "../agents/agent-bundle-mcp-runtime.js";
import type { SessionMcpRuntime } from "../agents/agent-bundle-mcp-types.js";
import { jsonResult } from "../agents/tools/common.js";
import {
  callSessionsSendGateway,
  startSessionsSendAgentRun,
} from "../agents/tools/sessions-send-tool.delivery.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";
import { prepareInProcessAgentExecution } from "./server-plugin-in-process-dispatch.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

const startTurn = vi.hoisted(() => vi.fn());
// mock-isolation: Replace model execution; keep real bridge, delivery, admission and MCP I/O.
vi.mock("./agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ startTurn }),
}));

let server: Awaited<ReturnType<typeof startMcpLifecycleServer>>;
let calls = 0;
beforeAll(async () => {
  server = await startMcpLifecycleServer({
    toolName: "read",
    text: () => {
      calls++;
      return "recipient read";
    },
  });
});
afterAll(async () => server.close());

async function configuredRuntime(sessionId: string): Promise<SessionMcpRuntime> {
  const runtime = createSessionMcpRuntime({
    sessionId,
    workspaceDir: "/synthetic/mcp-authority",
    cfg: {
      plugins: { enabled: false },
      mcp: { servers: { probe: { transport: "streamable-http", url: server.url } } },
    },
  });
  await runtime.getCatalog();
  return runtime;
}

const request = () => ({
  jsonrpc: "2.0" as const,
  id: 1,
  method: "tools/call",
  params: { name: "sessions_send", arguments: {} },
});

describe("sessions_send MCP authority handoff (#185303)", () => {
  it.each(["completed", "recipient canceled", "recipient grant revoked"])(
    "keeps recipient authority independent after the sender completed: %s",
    async (outcome) => {
      const runtime = await configuredRuntime(`recipient-${outcome}`);
      const release = createDeferredCore();
      const finished = createDeferredCore<unknown>();
      const recipient = new AbortController();
      let recipientGrant = true;
      let senderGrant = true;
      const before = calls;
      startTurn.mockImplementation(async ({ io }) => {
        io.emitAcceptance([true, { runId: "recipient-run", status: "accepted" }]);
        try {
          await release.promise;
          finished.resolve(
            await runWithSessionMcpRequestSignal(recipient.signal, () =>
              outcome === "recipient grant revoked"
                ? runWithSessionMcpToolCallAuthority(
                    () => {
                      if (!recipientGrant) {
                        throw new Error("recipient grant revoked");
                      }
                    },
                    () => runtime.callTool("probe", "read", {}),
                  )
                : runtime.callTool("probe", "read", {}),
            ),
          );
        } catch (error) {
          finished.resolve(error);
        }
      });
      const context = createContext();
      try {
        const response = await withPluginRuntimeGatewayRequestScope(
          { context, isWebchatConnect: () => false },
          () =>
            handleMcpJsonRpc({
              message: request(),
              toolSchema: [
                { name: "sessions_send", description: undefined, inputSchema: { type: "object" } },
              ],
              authorizeToolCall: () => senderGrant,
              tools: [
                {
                  name: "sessions_send",
                  label: "Session send",
                  description: "Send a message to another session",
                  parameters: Type.Object({}),
                  execute: async () =>
                    jsonResult(
                      await startSessionsSendAgentRun({
                        cfg: {},
                        admissionConfig: {},
                        callGateway: callSessionsSendGateway,
                        runId: "recipient-run",
                        sessionKey: "agent:main:mcp-recipient",
                        sessionStoreTarget: {
                          agentId: "main",
                          canonicalKey: "agent:main:mcp-recipient",
                          storePath: "/synthetic/sessions",
                        },
                        sendParams: {
                          message: "read configured MCP",
                          agentId: "main",
                          sessionKey: "agent:main:mcp-recipient",
                          idempotencyKey: "recipient-run",
                          sourceReplyDeliveryMode: "message_tool_only",
                          inputProvenance: {
                            kind: "inter_session",
                            sourceSessionKey: "agent:main:mcp-sender",
                            sourceTool: "sessions_send",
                          },
                        },
                      }),
                    ),
                },
              ],
            }),
        );
        expect(response, JSON.stringify(response)).toMatchObject({ result: { isError: false } });
        expect(startTurn).toHaveBeenCalled();
        senderGrant = false; // Normal sender completion closes only its per-call grant.
        if (outcome === "recipient canceled") {
          recipient.abort(new Error("recipient canceled"));
        }
        if (outcome === "recipient grant revoked") {
          recipientGrant = false;
        }
        release.resolve();
        const result = await finished.promise;
        if (outcome === "completed") {
          expect(result).toMatchObject({ content: [{ text: "recipient read" }] });
          expect(calls).toBe(before + 1);
        } else {
          expect(result).toMatchObject({ message: outcome });
          expect(calls).toBe(before);
        }
      } finally {
        release.resolve();
        await runtime.dispose();
        startTurn.mockReset();
      }
    },
  );

  it("does not retain the caller's grant in prepared sessionless execution", async () => {
    const runtime = await configuredRuntime("sessionless-recipient");
    const release = createDeferredCore();
    const context = createContext();
    let senderGrant = true;
    const execution = await prepareInProcessAgentExecution({
      agentId: "main",
      pluginRuntimeOwnerId: "mcp-proof",
      resolveGatewayContext: () => context,
    });
    try {
      await execution.authorize();
      const result = runWithSessionMcpToolCallAuthority(
        () => {
          if (!senderGrant) {
            throw new Error("sender grant closed");
          }
        },
        () =>
          execution.run(async () => {
            await release.promise;
            return runtime.callTool("probe", "read", {});
          }),
      );
      senderGrant = false;
      release.resolve();
      await expect(result).resolves.toMatchObject({ content: [{ text: "recipient read" }] });
    } finally {
      release.resolve();
      execution.release();
      await runtime.dispose();
    }
  });

  it("still rejects direct calls under a revoked bridge grant", async () => {
    const runtime = await configuredRuntime("direct-revoked");
    const before = calls;
    try {
      await expect(
        runWithSessionMcpToolCallAuthority(
          () => {
            throw new Error("Tool call authorization expired");
          },
          () => runtime.callTool("probe", "read", {}),
        ),
      ).rejects.toThrow("Tool call authorization expired");
      expect(calls).toBe(before);
      await expect(runtime.callTool("probe", "read", {})).resolves.toMatchObject({
        content: [{ text: "recipient read" }],
      });
      expect(calls).toBe(before + 1);
    } finally {
      await runtime.dispose();
    }
  });
});
