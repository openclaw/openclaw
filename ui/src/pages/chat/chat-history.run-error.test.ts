// @vitest-environment node
import { expect, it, onTestFinished } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory, type ChatEventPayload } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { getChatSessionProjection } from "./history-merge.ts";
import { reconcileChatRunFromSessionRow, reconcileChatRunLifecycle } from "./run-lifecycle.ts";

const row = (overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key: "main",
  kind: "direct",
  updatedAt: 2,
  status: "failed",
  hasActiveRun: false,
  lastRunId: "run",
  lastRunError: "Workspace preparation failed",
  ...overrides,
});
const notice = (content: string, details = {}, customType = "run-failed-before-reply") => ({
  role: "custom",
  customType,
  content,
  details,
  __openclaw: { id: "failure", seq: 1, runId: "run" },
});
function host(history: ChatHistoryResult | (() => ChatHistoryResult | Promise<ChatHistoryResult>)) {
  const state = makeChatHost({ sessionKey: "main", requestHandlers: { "chat.history": history } });
  onTestFinished(() => reconcileChatRunLifecycle(state, { clearRunStatus: true }));
  return state;
}
function emit(
  state: ReturnType<typeof host>,
  runId: string,
  event: Omit<ChatEventPayload, "sessionKey" | "runId">,
) {
  handleChatGatewayEvent(state, { sessionKey: "main", runId, ...event });
}

it.each(["run-failed-before-reply", "other-notice"])(
  "recovers only the failure notice diagnostic (%s)",
  async (kind) => {
    const diagnostic =
      'Failed to prepare skill resources: skill="review" path="/workspace/skills/review/CLAUDE.md" error=ENOENT';
    const sessionInfo = row();
    const state = host({
      messages: [notice(diagnostic, { errorKind: "state_contention" }, kind)],
      sessionInfo,
    });
    await loadChatHistory(state);
    const expected = kind === "run-failed-before-reply" ? diagnostic : sessionInfo.lastRunError;
    expect(state.chatRunError).toMatchObject({ runId: "run", summary: expected });
    expect(state.chatRunError?.kind).toBe(
      kind === "run-failed-before-reply" ? "state_contention" : undefined,
    );
    expect(getChatSessionProjection(state).runs.run?.errorMessage).toBe(expected);
  },
);

it("retires a recovered failure after a newer successful history and rejects its stale replay", async () => {
  const first = {
    role: "user",
    content: "Start working",
    __openclaw: { id: "first", idempotencyKey: "run:user", seq: 1 },
  };
  const failed = { sessionId: "session", messages: [first], sessionInfo: row() };
  let history: ChatHistoryResult = failed;
  const state = host(() => history);
  await loadChatHistory(state);
  expect(state.chatRunError?.summary).toContain(failed.sessionInfo.lastRunError);
  history = {
    sessionId: "session",
    messages: [
      first,
      {
        role: "user",
        content: "Try again",
        __openclaw: { id: "retry", idempotencyKey: "retry:user", seq: 2 },
      },
      {
        role: "assistant",
        content: "Recovered",
        __openclaw: { id: "answer", idempotencyKey: "retry", seq: 3 },
      },
    ],
    sessionInfo: row({ status: "done", lastRunId: "retry", lastRunError: undefined }),
  };
  await loadChatHistory(state);
  expect(state.currentSessionId).toBe("session");
  expect(state.chatMessages).toEqual(history.messages);
  expect(state.chatRunId).toBeNull();
  expect(getChatSessionProjection(state).runs.run).toMatchObject({
    status: "error",
    errorMessage: failed.sessionInfo.lastRunError,
  });
  expect(state.chatRunError).toBeNull();
  history = failed;
  await loadChatHistory(state);
  expect(state.chatRunError).toBeNull();
});

it.each([
  { snapshotStatus: "done", newerState: "active", requestOrder: "before" },
  { snapshotStatus: "failed", newerState: "failed", requestOrder: "before" },
  { snapshotStatus: "done", newerState: "completed", requestOrder: "after" },
] as const)(
  "keeps newer $newerState over $snapshotStatus history requested $requestOrder it",
  async ({ snapshotStatus, newerState, requestOrder }) => {
    const response = createDeferred<ChatHistoryResult>();
    const state = host(() => response.promise);
    emit(
      state,
      "2",
      snapshotStatus === "done"
        ? { state: "final", message: { role: "assistant", content: "Old reply" } }
        : { state: "error", errorMessage: "Old failure" },
    );
    let loading = requestOrder === "before" ? loadChatHistory(state) : undefined;
    emit(state, "1", { state: "delta", deltaText: "New reply" });
    if (newerState !== "active") {
      emit(
        state,
        "1",
        newerState === "completed"
          ? { state: "final", message: { role: "assistant", content: "New reply" } }
          : { state: "error", errorMessage: "Current full diagnostic" },
      );
    }
    const currentError = state.chatRunError;
    loading ??= loadChatHistory(state);
    response.resolve({
      messages: [],
      sessionInfo: row({
        status: snapshotStatus,
        lastRunId: "2",
        lastRunError: snapshotStatus === "failed" ? "Old failure" : undefined,
      }),
    });
    await loading;
    expect(state.chatRunError).toEqual(currentError);
    expect(state.chatRunId).toBe(newerState === "active" ? "1" : null);
  },
);

it("recovers a missed timeout after session publication settles the active run", async () => {
  const sessionInfo = row({ status: "timeout" });
  const state = host({ messages: [], sessionInfo });
  emit(state, "run", { state: "delta", deltaText: "Working" });
  reconcileChatRunFromSessionRow(state, sessionInfo, { publishRunStatus: false });
  expect(state.chatRunId).toBeNull();
  expect(state.chatRunError).toMatchObject({ runId: "run", summary: sessionInfo.lastRunError });
  await loadChatHistory(state);
  expect(state.chatRunError?.summary).toContain(sessionInfo.lastRunError);
  expect(getChatSessionProjection(state).runs.run).toMatchObject({
    status: "timeout",
    errorMessage: sessionInfo.lastRunError,
  });
});

it.each([
  { source: "live", publishRunStatus: undefined },
  { source: "history", publishRunStatus: false },
])("upgrades a session failure summary from $source", async ({ source, publishRunStatus }) => {
  const sessionInfo = row();
  const diagnostic = `${sessionInfo.lastRunError}: missing required file /workspace/project/setup.ts`;
  const state = host({ messages: [notice(diagnostic)], sessionInfo });
  emit(state, "run", { state: "delta", deltaText: "Working" });
  reconcileChatRunFromSessionRow(state, sessionInfo, { publishRunStatus });
  expect(state.chatRunError?.summary).toBe(sessionInfo.lastRunError);
  if (source === "history") {
    await loadChatHistory(state);
  } else {
    emit(state, "run", { state: "error", errorMessage: diagnostic });
  }
  expect(state.chatRunError?.summary).toContain(diagnostic);
  expect(getChatSessionProjection(state).runs.run?.errorMessage).toBe(diagnostic);
});

it("preserves a same-run late diagnostic received during successful history", async () => {
  const response = createDeferred<ChatHistoryResult>();
  const state = host(() => response.promise);
  emit(state, "run", { state: "delta" });
  emit(state, "run", {
    state: "final",
    message: { role: "assistant", content: "Delivered answer" },
  });
  const loading = loadChatHistory(state);
  emit(state, "run", { state: "error", errorMessage: "Full late diagnostic after delivery" });
  const diagnostic = state.chatRunError;
  expect(diagnostic?.summary).toContain("Full late diagnostic after delivery");
  response.resolve({ messages: [], sessionInfo: row({ status: "done", lastRunError: undefined }) });
  await loading;
  expect(state.chatRunError).toEqual(diagnostic);
  expect(state.chatRunId).toBeNull();
});

it("retains a newer-run diagnostic when a completed run delivers another final", () => {
  const state = host({ messages: [] });
  emit(state, "run", { state: "delta" });
  emit(state, "run", { state: "final", message: { role: "assistant", content: "First answer" } });
  emit(state, "newer-run", { state: "error", errorMessage: "Diagnostic that must remain visible" });
  const diagnostic = state.chatRunError;
  expect(diagnostic?.summary).toContain("Diagnostic that must remain visible");
  emit(state, "run", { state: "final", message: { role: "assistant", content: "Late answer" } });
  expect(state.chatMessages).toContainEqual(expect.objectContaining({ content: "Late answer" }));
  expect(state.chatRunId).toBeNull();
  expect(state.chatRunError).toEqual(diagnostic);
});

it("does not certify unknown contention kinds or alter the draft", async () => {
  const diagnostic = "Temporarily busy. Check status before trying again.";
  const state = host({
    messages: [
      notice(diagnostic, { errorKind: "unknown", privateDetail: "must not enter the notice" }),
    ],
    sessionInfo: row(),
  });
  state.chatMessage = "My unsent draft";
  const attachments = state.chatAttachments;
  await loadChatHistory(state);
  expect(state.chatRunError).toEqual({ summary: diagnostic, runId: "run" });
  expect(getChatSessionProjection(state).runs.run?.errorKind).toBeUndefined();
  expect(state.chatMessage).toBe("My unsent draft");
  expect(state.chatAttachments).toBe(attachments);
  expect(state.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  await loadChatHistory(state);
  expect(state.chatRunError?.kind).toBeUndefined();
});

it("restores contention diagnostics separately from transcript text", async () => {
  const summary = "The turn was interrupted while the server was busy.";
  const diagnostic = "State lifecycle acquisition remained busy.";
  const state = host({
    messages: [notice(summary, { errorKind: "state_contention", diagnostic })],
    sessionInfo: row({ lastRunError: summary }),
  });
  await loadChatHistory(state);
  expect(state.chatRunError).toMatchObject({
    kind: "state_contention",
    runId: "run",
    summary: `${summary}\n\n${diagnostic}`,
  });
  expect(state.chatMessages).toContainEqual(expect.objectContaining({ content: summary }));
});
