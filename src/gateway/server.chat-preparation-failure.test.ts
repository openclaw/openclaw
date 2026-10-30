// Real WebSocket coverage for failures returned before any agent runtime lifecycle exists.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildKnownAgentRunFailureReplyPayload } from "../auto-reply/reply/agent-runner-failure-reply.js";
import { clearConfigCache } from "../config/config.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { captureSessionControllerSettlement } from "../sessions/session-controller.lifecycle.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import { releaseGatewaySessionStoreFixture } from "./test/server-sessions-resources.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const temporaryDirectories = useAutoCleanupTempDirTracker(afterEach);
let gateway: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;

beforeAll(async () => {
  gateway = await createGatewaySuiteHarness();
});

afterAll(async () => {
  await gateway.close();
});

afterEach(async () => {
  for (const dir of temporaryDirectories.dirs) {
    await releaseGatewaySessionStoreFixture(dir);
  }
  dispatchInboundMessageMock.mockReset();
  testState.sessionStorePath = undefined;
  clearConfigCache();
});

test("retains a failure returned before the agent run started for a reconnecting client", async () => {
  const storePath = path.join(
    temporaryDirectories.make("openclaw-chat-preparation-failure-"),
    "sessions.json",
  );
  testState.sessionStorePath = storePath;
  const sessionId = "preparation-failure-session";
  await writeSessionStore({ entries: { main: { sessionId, updatedAt: Date.now() } } });
  const scope = { storePath, agentId: "main", sessionKey: "agent:main:main", sessionId };
  const runId = "preparation-failure-before-run";
  // Memory flush/preflight compaction failed during preparation: the runner returns
  // its failure payload without ever starting a runtime lifecycle.
  const failure = expectDefined(
    buildKnownAgentRunFailureReplyPayload({
      err: new Error("Preflight compaction required but failed: Aborted"),
      sessionCtx: {},
      resolvedVerboseLevel: "off",
    }),
    "preflight failure payload",
  );
  const notice = expectDefined(failure.text, "preflight failure notice");
  dispatchInboundMessageMock.mockImplementationOnce(async ({ dispatcher, replyOptions }) => {
    await replyOptions?.userTurnTranscriptRecorder?.persistApproved();
    dispatcher.sendFinalReply(failure);
    await dispatcher.waitForIdle();
    return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
  });
  const socket = await gateway.openWs();
  let settled: Promise<void> | undefined;
  try {
    await connectOk(socket);
    const terminal = onceMessage(
      socket,
      (frame) =>
        frame.event === "chat" &&
        frame.payload?.runId === runId &&
        frame.payload?.state === "error",
    );
    const started = await rpcReq(socket, "chat.send", {
      sessionKey: scope.sessionKey,
      message: "Land it.",
      idempotencyKey: runId,
    });
    expect(started.payload).toMatchObject({ runId, status: "started" });
    settled = captureSessionControllerSettlement({
      scope: storePath,
      identities: [scope.sessionKey, sessionId],
    });
    expect((await terminal).payload?.errorMessage).toBe(notice);
    await settled;
  } finally {
    await settled;
    socket.close();
  }
  // A client that missed the live broadcast still sees what failed and the next step.
  const reader = await gateway.openWs();
  try {
    await connectOk(reader);
    const history = await rpcReq<{ messages: unknown[] }>(reader, "chat.history", {
      sessionKey: scope.sessionKey,
    });
    expect(history.payload?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Land it." }),
      expect.objectContaining({
        role: "custom",
        customType: "run-failed-before-reply",
        content: notice,
      }),
    ]);
  } finally {
    reader.close();
  }
  expect(loadSessionEntry(scope)).toMatchObject({ status: "failed", lastRunId: runId });
});
