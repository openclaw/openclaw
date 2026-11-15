import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { AcpRuntimeError } from "../acp/runtime/errors.js";
import {
  listSessionPendingInputs,
  loadSessionEntry,
  loadTranscriptEventsSync,
} from "../config/sessions/session-accessor.js";
import { readAgentCommandCall } from "./agent-command.test-helpers.js";
import { refusePendingInputCommit } from "./pending-input-commit.test-support.js";
import {
  agentCommandMock,
  connectWebchatClient,
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  startConnectedServerWithClient,
  startServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import { releaseGatewaySessionStoreFixture } from "./test/server-sessions-resources.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];
let port: number;
let storePath: string;

beforeAll(async () => {
  ({ server, ws, port } = await startConnectedServerWithClient());
});

afterAll(async () => {
  ws.close();
  await server.close();
});

async function writeMainSessionEntry(sessionId: string) {
  await writeSessionStore({ entries: { main: { sessionId, updatedAt: Date.now() } } });
  return { agentId: "main", sessionKey: "agent:main:main", sessionId, storePath };
}

async function sendAgentWsRequest(
  reqId: string,
  params: { message: string; idempotencyKey: string; sessionKey?: string },
) {
  await prepareGatewayReplyRuntimeForTest();
  ws.send(JSON.stringify({ type: "req", id: reqId, method: "agent", params }));
}

const gwSessionTempDirs: string[] = [];

function agentResponse(id: string, accepted = false) {
  return onceMessage(
    ws,
    (message) =>
      message.type === "res" &&
      message.id === id &&
      (message.payload?.status === "accepted") === accepted,
  );
}

beforeEach(async () => {
  vi.mocked(agentCommandMock).mockClear();
  testState.allowFrom = undefined;
  storePath = path.join(makeTempDir(gwSessionTempDirs, "openclaw-gw-"), "sessions.json");
  testState.sessionStorePath = storePath;
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
  const scope = await writeMainSessionEntry("sess-main-before-write-reset");

  const writeWs = await connectWebchatClient({ port, scopes: ["operator.write"] });
  try {
    const directReset = await rpcReq(writeWs, "sessions.reset", { key: "main" });
    expect(directReset.ok).toBe(false);
    expect(directReset.error?.message).toContain("missing scope: operator.admin");

    const viaAgent = await rpcReq(writeWs, "agent", {
      message: "/reset",
      sessionKey: "main",
      idempotencyKey: "idem-agent-write-reset",
    });
    const missingScope = "operator.admin";
    expect(viaAgent).toMatchObject({
      ok: false,
      error: {
        code: "FORBIDDEN",
        message: `missing scope: ${missingScope}`,
        details: { code: "MISSING_SCOPE", missingScope, requiredScopes: [missingScope] },
      },
    });

    expect(loadSessionEntry(scope)?.sessionId).toBe("sess-main-before-write-reset");
    expect(vi.mocked(agentCommandMock)).not.toHaveBeenCalled();
  } finally {
    writeWs.close();
  }
});

test.each(["completion", "abort"] as const)(
  "a hanging agent dispatch durably admits its turn before ACK and %s",
  async (outcome) => {
    const scope = await writeMainSessionEntry("sess-durable-agent-abort");
    const runId = `idem-agent-durable-${outcome}`;
    const content = "keep this aborted agent turn queryable";
    const dispatch = createDeferred<unknown>();
    vi.mocked(agentCommandMock).mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[0] as { abortSignal?: AbortSignal };
      const finish = () => {
        const reason = options.abortSignal?.reason;
        dispatch.reject(reason instanceof Error ? reason : new Error("agent run aborted"));
      };
      options.abortSignal?.addEventListener("abort", finish, { once: true });
      try {
        return await dispatch.promise;
      } finally {
        options.abortSignal?.removeEventListener("abort", finish);
      }
    });
    const ackP = agentResponse(runId, true);
    const finalP = agentResponse(runId);

    try {
      await sendAgentWsRequest(runId, {
        message: content,
        sessionKey: "main",
        idempotencyKey: runId,
      });
      expect((await ackP).payload).toMatchObject({ runId, status: "accepted" });
      expect(loadTranscriptEventsSync(scope)).toEqual([]);
      const userMessage = { role: "user", content };
      const expectPending = async (
        state: "queued" | "cancelled",
        message: Record<string, string> = userMessage,
      ) =>
        expect(await listSessionPendingInputs(scope)).toMatchObject({
          total: 1,
          items: [{ runId, state, message }],
        });
      await expectPending("queued", { ...userMessage, idempotencyKey: `${runId}:user` });

      await readAgentCommandCall({ runId });
      if (outcome === "abort") {
        const aborted = await rpcReq(ws, "chat.abort", { runId, sessionKey: "main" });
        expect(aborted.ok).toBe(true);
      } else {
        dispatch.resolve({ payloads: [{ text: "ok" }], meta: { durationMs: 1 } });
      }
      const final = await finalP;
      if (outcome === "abort") {
        expect(final.payload).toMatchObject({ runId, status: "timeout", stopReason: "rpc" });
        expect(loadTranscriptEventsSync(scope)).toEqual([]);
        await expectPending("cancelled");
      } else {
        expect(final.payload).toMatchObject({ runId, status: "ok" });
      }
    } finally {
      dispatch.resolve({ payloads: [{ text: "ok" }], meta: { durationMs: 1 } });
      await Promise.allSettled([ackP, finalP]);
    }
  },
);

test("agent returns a wire error when durable user-turn admission fails", async () => {
  await writeMainSessionEntry("sess-durable-agent-failure");
  using _ = refusePendingInputCommit({
    operation: "stage",
    message: "injected agent transcript admission failure",
    sessionId: "sess-durable-agent-failure",
    runId: "idem-agent-durable-failure",
  });
  const response = await rpcReq(ws, "agent", {
    message: "this turn must not be acknowledged",
    sessionKey: "main",
    idempotencyKey: "idem-agent-durable-failure",
  });
  expect(response).toMatchObject({
    ok: false,
    error: {
      code: "UNAVAILABLE",
      message: expect.stringContaining("injected agent transcript admission failure"),
    },
  });
  expect(vi.mocked(agentCommandMock)).not.toHaveBeenCalled();
});

test("agent final response surfaces redacted ACP runtime cause details", async () => {
  const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
  vi.mocked(agentCommandMock).mockRejectedValueOnce(
    new AcpRuntimeError("ACP_TURN_FAILED", "Internal error", {
      cause: new Error(`upstream rejected token=${token}`),
    }),
  );

  const finalP = agentResponse("ag-acp-error-detail");
  await sendAgentWsRequest("ag-acp-error-detail", {
    message: "hi",
    idempotencyKey: "idem-agent-acp-error-detail",
  });
  const final = await finalP;
  const errorMessage = (final.error as { message?: string } | undefined)?.message ?? "";
  expect(final).toMatchObject({ ok: false, payload: { status: "error" } });
  expect(errorMessage).toMatch(/ACP_TURN_FAILED/);
  expect(errorMessage).toMatch(/Internal error/);
  expect(errorMessage).toMatch(/upstream rejected/);
  expect(errorMessage).not.toContain("AcpRuntimeError");
  expect(JSON.stringify(final)).not.toContain(token);
});
