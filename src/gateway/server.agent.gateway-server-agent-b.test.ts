// Gateway agent integration tests cover channel routing, session context,
// WebSocket requests, agent event delivery, and provider/runtime error handling.
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { AcpRuntimeError } from "../acp/runtime/errors.js";
import {
  listSessionPendingInputs,
  loadSessionEntry,
  loadTranscriptEventsSync,
} from "../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import { readAgentCommandCall } from "./agent-command.test-helpers.js";
import { refusePendingInputCommit } from "./pending-input-commit.test-support.js";
import {
  agentCommandMock,
  connectOk,
  connectWebchatClient,
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  startConnectedServerWithClient,
  startServerWithClient,
  testState,
  trackConnectChallengeNonce,
  withGatewayServer,
  writeSessionStore,
} from "./test-helpers.js";
import { releaseGatewaySessionStoreFixture } from "./test/server-sessions-resources.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];

let port: number;

beforeAll(async () => {
  const started = await startConnectedServerWithClient();
  server = started.server;
  ws = started.ws;
  port = started.port;
});

afterAll(async () => {
  ws.close();
  await server.close();
});

async function writeMainSessionEntry(params: { sessionId: string }) {
  await useTempSessionStorePath();
  await writeSessionStore({
    entries: {
      main: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      },
    },
  });
}

async function sendAgentWsRequest(
  socket: WebSocket,
  params: { reqId: string; message: string; idempotencyKey: string; sessionKey?: string },
) {
  await prepareGatewayReplyRuntimeForTest();
  socket.send(
    JSON.stringify({
      type: "req",
      id: params.reqId,
      method: "agent",
      params: {
        message: params.message,
        idempotencyKey: params.idempotencyKey,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      },
    }),
  );
}

async function sendAgentWsRequestAndWaitFinal(
  socket: WebSocket,
  params: { reqId: string; message: string; idempotencyKey: string; timeoutMs?: number },
) {
  const finalP = onceMessage(
    socket,
    (o) => o.type === "res" && o.id === params.reqId && o.payload?.status !== "accepted",
    params.timeoutMs,
  );
  await sendAgentWsRequest(socket, params);
  return await finalP;
}

const gwSessionTempDirs: string[] = [];

async function useTempSessionStorePath() {
  const dir = makeTempDir(gwSessionTempDirs, "openclaw-gw-");
  testState.sessionStorePath = path.join(dir, "sessions.json");
}

afterAll(() => {
  cleanupTempDirs(gwSessionTempDirs);
});

describe("gateway server agent", () => {
  beforeEach(async () => {
    vi.mocked(agentCommandMock).mockClear();
    testState.allowFrom = undefined;
    await useTempSessionStorePath();
    await writeSessionStore({ entries: {} });
  });

  afterEach(async () => {
    testState.allowFrom = undefined;
    for (const dir of gwSessionTempDirs) {
      await releaseGatewaySessionStoreFixture(dir);
    }
    cleanupTempDirs(gwSessionTempDirs);
  });

  test("write-scoped callers cannot reset conversations via agent", async () => {
    await withGatewayServer(async ({ port: portValue }) => {
      await useTempSessionStorePath();
      const storePath = testState.sessionStorePath;
      if (!storePath) {
        throw new Error("missing session store path");
      }

      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main-before-write-reset",
            updatedAt: Date.now(),
          },
        },
      });

      const writeWs = new WebSocket(`ws://127.0.0.1:${portValue}`);
      trackConnectChallengeNonce(writeWs);
      await new Promise<void>((resolve) => {
        writeWs.once("open", resolve);
      });
      await connectOk(writeWs, { scopes: ["operator.write"] });

      const directReset = await rpcReq(writeWs, "sessions.reset", { key: "main" });
      expect(directReset.ok).toBe(false);
      expect(directReset.error?.message).toContain("missing scope: operator.admin");

      vi.mocked(agentCommandMock).mockClear();
      const viaAgent = await rpcReq(writeWs, "agent", {
        message: "/reset",
        sessionKey: "main",
        idempotencyKey: "idem-agent-write-reset",
      });
      expect(viaAgent.ok).toBe(false);
      expect(viaAgent.error).toMatchObject({
        code: "FORBIDDEN",
        message: "missing scope: operator.admin",
        details: {
          code: "MISSING_SCOPE",
          missingScope: "operator.admin",
          requiredScopes: ["operator.admin"],
        },
      });

      const stored = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
      expect(stored?.sessionId).toBe("sess-main-before-write-reset");
      expect(vi.mocked(agentCommandMock)).not.toHaveBeenCalled();

      writeWs.close();
    });
  });

  test("agent durably admits the user turn before acknowledging a hanging dispatch", async () => {
    await writeMainSessionEntry({ sessionId: "sess-durable-agent-ack" });
    const dispatch = createDeferred<unknown>();
    vi.mocked(agentCommandMock).mockImplementationOnce(async () => await dispatch.promise);
    const runId = "idem-agent-durable-ack";
    const ackP = onceMessage(
      ws,
      (message) =>
        message.type === "res" && message.id === runId && message.payload?.status === "accepted",
    );
    const finalP = onceMessage(
      ws,
      (message) =>
        message.type === "res" && message.id === runId && message.payload?.status !== "accepted",
    );

    try {
      await sendAgentWsRequest(ws, {
        reqId: runId,
        message: "persist this agent turn before ACK",
        sessionKey: "main",
        idempotencyKey: runId,
      });
      expect((await ackP).payload).toMatchObject({ runId, status: "accepted" });

      const storePath = testState.sessionStorePath;
      if (!storePath) {
        throw new Error("expected session store path");
      }
      const scope = {
        agentId: "main",
        sessionId: "sess-durable-agent-ack",
        sessionKey: "agent:main:main",
        storePath,
      };
      expect(loadTranscriptEventsSync(scope)).toEqual([]);
      expect(await listSessionPendingInputs(scope)).toMatchObject({
        total: 1,
        items: [
          {
            runId,
            state: "queued",
            message: {
              role: "user",
              content: "persist this agent turn before ACK",
              idempotencyKey: `${runId}:user`,
            },
          },
        ],
      });
    } finally {
      dispatch.resolve({ payloads: [{ text: "ok" }], meta: { durationMs: 1 } });
      expect((await finalP).payload).toMatchObject({ runId, status: "ok" });
    }
  });

  test("an aborted hanging agent dispatch leaves its acknowledged turn queryable", async () => {
    await writeMainSessionEntry({ sessionId: "sess-durable-agent-abort" });
    const runId = "idem-agent-durable-abort";
    vi.mocked(agentCommandMock).mockImplementationOnce(
      async (...args: unknown[]) =>
        await new Promise<void>((_resolve, reject) => {
          const options = args[0] as { abortSignal?: AbortSignal };
          const finish = () => {
            const reason = options.abortSignal?.reason;
            reject(reason instanceof Error ? reason : new Error("agent run aborted"));
          };
          options.abortSignal?.addEventListener("abort", finish, { once: true });
        }),
    );
    const ackP = onceMessage(
      ws,
      (message) =>
        message.type === "res" && message.id === runId && message.payload?.status === "accepted",
    );
    const finalP = onceMessage(
      ws,
      (message) =>
        message.type === "res" && message.id === runId && message.payload?.status !== "accepted",
    );

    await sendAgentWsRequest(ws, {
      reqId: runId,
      message: "keep this aborted agent turn queryable",
      sessionKey: "main",
      idempotencyKey: runId,
    });
    await ackP;
    await readAgentCommandCall({ runId });
    await rpcReq(ws, "chat.abort", { runId, sessionKey: "main" });
    const final = await finalP;
    expect(final.payload).toMatchObject({ runId, status: "timeout", stopReason: "rpc" });

    const storePath = testState.sessionStorePath;
    if (!storePath) {
      throw new Error("expected session store path");
    }
    const scope = {
      agentId: "main",
      sessionId: "sess-durable-agent-abort",
      sessionKey: "agent:main:main",
      storePath,
    };
    expect(loadTranscriptEventsSync(scope)).toEqual([]);
    expect(await listSessionPendingInputs(scope)).toMatchObject({
      total: 1,
      items: [
        {
          runId,
          state: "cancelled",
          message: {
            role: "user",
            content: "keep this aborted agent turn queryable",
          },
        },
      ],
    });
  });

  test("agent returns a wire error when durable user-turn admission fails", async () => {
    await writeMainSessionEntry({ sessionId: "sess-durable-agent-failure" });
    const refusal = refusePendingInputCommit({
      operation: "stage",
      message: "injected agent transcript admission failure",
      sessionId: "sess-durable-agent-failure",
      runId: "idem-agent-durable-failure",
    });
    try {
      const response = await rpcReq(ws, "agent", {
        message: "this turn must not be acknowledged",
        sessionKey: "main",
        idempotencyKey: "idem-agent-durable-failure",
      });

      expect(response.ok).toBe(false);
      expect(response.error).toMatchObject({
        code: "UNAVAILABLE",
        message: expect.stringContaining("injected agent transcript admission failure"),
      });
      expect(vi.mocked(agentCommandMock)).not.toHaveBeenCalled();
    } finally {
      refusal.mockRestore();
    }
  });

  test("agent final response surfaces redacted ACP runtime cause details", async () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    vi.mocked(agentCommandMock).mockRejectedValueOnce(
      new AcpRuntimeError("ACP_TURN_FAILED", "Internal error", {
        cause: new Error(`upstream rejected token=${token}`),
      }),
    );

    const final = await sendAgentWsRequestAndWaitFinal(ws, {
      reqId: "ag-acp-error-detail",
      message: "hi",
      idempotencyKey: "idem-agent-acp-error-detail",
    });

    const finalError = final.error as { message?: string } | undefined;
    const errorMessage = finalError?.message ?? "";
    expect(final.ok).toBe(false);
    expect(final.payload?.status).toBe("error");
    expect(errorMessage).toMatch(/ACP_TURN_FAILED/);
    expect(errorMessage).toMatch(/Internal error/);
    expect(errorMessage).toMatch(/upstream rejected/);
    expect(errorMessage).not.toContain("AcpRuntimeError");
    expect(JSON.stringify(final)).not.toContain(token);
  });
  test("agent events stream to webchat clients when run context is registered", async () => {
    await writeMainSessionEntry({ sessionId: "sess-main" });

    const webchatWs = await connectWebchatClient({ port });

    registerAgentRunContext("run-auto-1", { sessionKey: "main" });

    const finalChatP = onceMessage(
      webchatWs,
      (o) => {
        if (o.type !== "event" || o.event !== "chat") {
          return false;
        }
        const payload = o.payload as { state?: unknown; runId?: unknown } | undefined;
        return payload?.state === "final" && payload.runId === "run-auto-1";
      },
      8000,
    );

    emitAgentEvent({
      runId: "run-auto-1",
      stream: "assistant",
      data: { text: "hi from agent" },
    });
    emitAgentEvent({
      runId: "run-auto-1",
      stream: "lifecycle",
      data: { phase: "end" },
    });

    const evt = await finalChatP;
    const payload = evt.payload && typeof evt.payload === "object" ? evt.payload : {};
    expect(payload.sessionKey).toBe("main");
    expect(payload.runId).toBe("run-auto-1");

    webchatWs.close();
  });
});
