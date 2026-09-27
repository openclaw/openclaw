// @vitest-environment node
import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { getChatSessionProjection } from "./history-merge.ts";
import { reconcileChatRunFromSessionRow, reconcileChatRunLifecycle } from "./run-lifecycle.ts";

it.each(["matching", "different-run", "unowned", "different-kind"] as const)(
  "recovers only the failed run's recorded diagnostic from history (%s)",
  async (source) => {
    const diagnostic =
      'This turn ended before a reply: Failed to prepare skill resources: skill="review" ' +
      'root="/workspace/skills/review" error=Skill tree file could not be read: ' +
      'path="/workspace/skills/review/CLAUDE.md" error=ENOENT: missing target.';
    const summary = "Failed to prepare skill resources";
    const state = makeChatHost({
      sessionKey: "main",
      requestHandlers: {
        "chat.history": {
          messages: [
            {
              role: "custom",
              customType: source === "different-kind" ? "other-notice" : "run-failed-before-reply",
              content: diagnostic,
              details: { errorKind: "state_contention" },
              __openclaw: {
                id: "failure-notice",
                seq: 1,
                ...(source === "unowned"
                  ? {}
                  : { runId: source === "different-run" ? "older-run" : "failed-run" }),
              },
            },
          ],
          sessionInfo: {
            key: "main",
            kind: "direct",
            updatedAt: 2,
            status: "failed",
            hasActiveRun: false,
            lastRunId: "failed-run",
            lastRunError: summary,
          },
        },
      },
    });
    await loadChatHistory(state);
    const expected = source === "matching" ? diagnostic : summary;
    expect(state.chatRunError).toMatchObject({ runId: "failed-run", summary: expected });
    expect(state.chatRunError?.kind).toBe(source === "matching" ? "state_contention" : undefined);
    expect(getChatSessionProjection(state).runs["failed-run"]?.errorMessage).toBe(expected);
  },
);

it.each([
  undefined,
  { status: "done" },
  { lastRunId: "next-run" },
  { lastRunId: "next-run", status: "killed" },
  { lastRunId: "next-run", status: "running" },
  { lastRunId: "next-run", status: "done", hasActiveRun: true },
] satisfies (Partial<GatewaySessionRow> | undefined)[])(
  "does not infer recovery from incomplete or non-successful history %j",
  async (sessionInfo) => {
    const state = makeChatHost({
      sessionKey: "main",
      requestHandlers: {
        "chat.history": {
          messages: [],
          ...(sessionInfo
            ? { sessionInfo: { key: "main", kind: "direct", updatedAt: 1, ...sessionInfo } }
            : {}),
        },
      },
    });
    try {
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "failed-run",
        state: "error",
        errorMessage: "Current diagnostic",
      });
      const diagnostic = state.chatRunError;
      await loadChatHistory(state);
      expect(state.chatRunError).toEqual(diagnostic);
      expect(getChatSessionProjection(state).runs["next-run"]).toBeUndefined();
    } finally {
      reconcileChatRunLifecycle(state, { clearRunStatus: true });
    }
  },
);

it.each(["history-only", "startup-only", "final-only", "delta-then-final"] as const)(
  "retires a recovered failure after a newer success delivered by %s",
  async (delivery) => {
    const error = "Earlier preparation failed. Retry after repairing the workspace.";
    const firstPrompt = {
      role: "user",
      content: "Start working",
      __openclaw: { id: "first-user", idempotencyKey: "run-first:user", seq: 1 },
    };
    let history: ChatHistoryResult = {
      sessionId: "recovered-session",
      messages: [firstPrompt],
      sessionInfo: {
        key: "main",
        kind: "direct",
        updatedAt: 2,
        status: "failed",
        hasActiveRun: false,
        lastRunId: "run-first",
        lastRunError: error,
      },
    };
    const state = makeChatHost({
      requestHandlers: { "chat.history": () => history, "chat.startup": () => history },
      sessionKey: "main",
    });
    await loadChatHistory(state);
    expect(state.chatRunError?.summary).toContain(error);
    const failedHistory = history;
    const reply = {
      role: "assistant",
      content: "Recovery completed.",
      __openclaw: { id: "retry-answer", idempotencyKey: "run-retry", seq: 3 },
    };
    try {
      if (delivery === "delta-then-final") {
        handleChatGatewayEvent(state, {
          sessionKey: "main",
          runId: "run-retry",
          state: "delta",
          deltaText: "Recovery",
        });
      }
      if (delivery === "final-only" || delivery === "delta-then-final") {
        handleChatGatewayEvent(state, {
          sessionKey: "main",
          runId: "run-retry",
          state: "final",
          message: reply,
        });
      }
      history = {
        sessionId: "recovered-session",
        messages: [
          firstPrompt,
          {
            role: "user",
            content: "Try again",
            __openclaw: { id: "retry-user", idempotencyKey: "run-retry:user", seq: 2 },
          },
          reply,
        ],
        sessionInfo: {
          key: "main",
          kind: "direct",
          updatedAt: 4,
          status: "done",
          hasActiveRun: false,
          lastRunId: "run-retry",
        },
      };
      await loadChatHistory(state, { startup: delivery === "startup-only" });

      expect(state.currentSessionId).toBe("recovered-session");
      expect(state.chatMessages).toEqual(history.messages);
      expect(state.chatRunId).toBeNull();
      expect(state.lastError).toBeNull();
      expect(getChatSessionProjection(state).runs["run-first"]).toMatchObject({
        status: "error",
        errorMessage: error,
      });
      expect(state.chatRunError).toBeNull();

      history = failedHistory;
      await loadChatHistory(state);
      expect(state.chatRunError).toBeNull();
    } finally {
      reconcileChatRunLifecycle(state, { clearRunStatus: true });
    }
  },
);

it.each(
  (["done", "failed"] as const).flatMap((snapshotStatus) =>
    (["active", "failed", "completed"] as const).flatMap((newerState) =>
      ["before", "after"].map((requestOrder) => ({
        snapshotStatus,
        newerState,
        requestOrder,
        oldRunId: "2",
        newRunId: "1",
      })),
    ),
  ),
)(
  "keeps newer $newerState run $newRunId over $snapshotStatus history for $oldRunId requested $requestOrder it",
  async ({ snapshotStatus, newerState, requestOrder, oldRunId, newRunId }) => {
    const response = createDeferred<ChatHistoryResult>();
    const state = makeChatHost({
      requestHandlers: { "chat.history": () => response.promise },
      sessionKey: "main",
    });
    handleChatGatewayEvent(state, {
      sessionKey: "main",
      runId: oldRunId,
      state: snapshotStatus === "done" ? "final" : "error",
      ...(snapshotStatus === "done"
        ? { message: { role: "assistant", content: "Old reply" } }
        : { errorMessage: "Old failure" }),
    });
    let loading = requestOrder === "before" ? loadChatHistory(state) : undefined;
    try {
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: newRunId,
        state: "delta",
        deltaText: "New reply",
      });
      if (newerState !== "active") {
        handleChatGatewayEvent(state, {
          sessionKey: "main",
          runId: newRunId,
          state: newerState === "completed" ? "final" : "error",
          ...(newerState === "completed"
            ? { message: { role: "assistant", content: "New reply" } }
            : { errorMessage: "Current failure with the complete diagnostic" }),
        });
      }
      const currentError = state.chatRunError;
      loading ??= loadChatHistory(state);
      response.resolve({
        messages: [],
        sessionInfo: {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          status: snapshotStatus,
          hasActiveRun: false,
          lastRunId: oldRunId,
          ...(snapshotStatus === "failed" ? { lastRunError: "Old failure" } : {}),
        },
      });
      await loading;
      expect(state.chatRunError).toEqual(currentError);
      expect(state.chatRunId).toBe(newerState === "active" ? newRunId : null);
    } finally {
      reconcileChatRunLifecycle(state, { clearRunStatus: true });
    }
  },
);

it.each(["failed", "timeout"] as const)(
  "recovers a missed %s diagnostic after session publication settles the active run",
  async (status) => {
    const row: GatewaySessionRow = {
      key: "main",
      kind: "direct",
      updatedAt: 2,
      status,
      hasActiveRun: false,
      lastRunId: "current-run",
      lastRunError: "Current failure recovered after terminal publication",
    };
    const state = makeChatHost({
      sessionKey: "main",
      requestHandlers: { "chat.history": { messages: [], sessionInfo: row } },
    });
    try {
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "current-run",
        state: "delta",
        deltaText: "Working",
      });
      reconcileChatRunFromSessionRow(state, row, { publishRunStatus: false });
      expect(state.chatRunId).toBeNull();
      // Session publication can settle the run before its chat error event arrives.
      // The composer must explain the failure without requiring a history reload.
      expect(state.chatRunError).toMatchObject({
        runId: "current-run",
        summary: row.lastRunError,
      });

      await loadChatHistory(state);

      expect(state.chatRunError?.summary).toContain(row.lastRunError);
      expect(getChatSessionProjection(state).runs["current-run"]).toMatchObject({
        status: status === "timeout" ? "timeout" : "error",
        errorMessage: row.lastRunError,
      });
    } finally {
      reconcileChatRunLifecycle(state, { clearRunStatus: true });
    }
  },
);

it.each(
  (["live", "history"] as const).flatMap((source) =>
    [false, undefined].map((publishRunStatus) => ({ source, publishRunStatus })),
  ),
)(
  "upgrades a session failure summary from $source (publishRunStatus=$publishRunStatus)",
  async ({ source, publishRunStatus }) => {
    const summary = "Failed to prepare the workspace";
    const diagnostic = `${summary}: missing required file /workspace/project/setup.ts`;
    const row: GatewaySessionRow = {
      key: "main",
      kind: "direct",
      updatedAt: 2,
      status: "failed",
      hasActiveRun: false,
      lastRunId: "current-run",
      lastRunError: summary,
    };
    const state = makeChatHost({
      sessionKey: "main",
      requestHandlers: {
        "chat.history": {
          messages: [
            {
              role: "custom",
              customType: "run-failed-before-reply",
              content: diagnostic,
              __openclaw: { id: "failure", seq: 1, runId: "current-run" },
            },
          ],
          sessionInfo: row,
        },
      },
    });
    try {
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "current-run",
        state: "delta",
        deltaText: "Working",
      });
      reconcileChatRunFromSessionRow(state, row, { publishRunStatus });
      expect(state.chatRunError?.summary).toBe(summary);
      if (source === "history") {
        await loadChatHistory(state);
      } else {
        handleChatGatewayEvent(state, {
          sessionKey: "main",
          runId: "current-run",
          state: "error",
          errorMessage: diagnostic,
        });
      }
      expect(state.chatRunError?.summary).toContain(diagnostic);
      expect(getChatSessionProjection(state).runs["current-run"]?.errorMessage).toBe(diagnostic);
    } finally {
      reconcileChatRunLifecycle(state, { clearRunStatus: true });
    }
  },
);

it("replaces a generic live failure with its first recovered diagnostic", async () => {
  const state = makeChatHost({
    sessionKey: "main",
    requestHandlers: {
      "chat.history": {
        messages: [],
        sessionInfo: {
          key: "main",
          kind: "direct",
          updatedAt: 2,
          status: "failed",
          hasActiveRun: false,
          lastRunId: "current-run",
          lastRunError: "Specific failure recovered from history",
        },
      },
    },
  });
  try {
    handleChatGatewayEvent(state, { sessionKey: "main", runId: "current-run", state: "error" });
    await loadChatHistory(state);
    expect(state.chatRunError?.summary).toBe("Specific failure recovered from history");
  } finally {
    reconcileChatRunLifecycle(state, { clearRunStatus: true });
  }
});

it.each(["before", "during"])(
  "preserves a same-run late diagnostic received %s successful history",
  async (order) => {
    const response = createDeferred<ChatHistoryResult>();
    const state = makeChatHost({
      requestHandlers: { "chat.history": () => response.promise },
      sessionKey: "main",
    });
    try {
      handleChatGatewayEvent(state, { sessionKey: "main", runId: "run", state: "delta" });
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "run",
        state: "final",
        message: { role: "assistant", content: "Delivered answer" },
      });
      let loading = order === "during" ? loadChatHistory(state) : undefined;
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "run",
        state: "error",
        errorMessage: "Full late diagnostic after delivery",
      });
      const diagnostic = state.chatRunError;
      expect(diagnostic?.summary).toContain("Full late diagnostic after delivery");
      loading ??= loadChatHistory(state);
      response.resolve({
        messages: [],
        sessionInfo: {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          status: "done",
          hasActiveRun: false,
          lastRunId: "run",
        },
      });
      await loading;
      expect(state.chatRunError).toEqual(diagnostic);
      expect(state.chatRunId).toBeNull();
    } finally {
      reconcileChatRunLifecycle(state, { clearRunStatus: true });
    }
  },
);

it.each(["same-run", "newer-run"])(
  "retains a %s diagnostic when a completed run delivers another final",
  (diagnosticRunId) => {
    const state = makeChatHost({ sessionKey: "main" });
    try {
      handleChatGatewayEvent(state, { sessionKey: "main", runId: "same-run", state: "delta" });
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "same-run",
        state: "final",
        message: { role: "assistant", content: "First delivered answer" },
      });
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: diagnosticRunId,
        state: "error",
        errorMessage: "Diagnostic that must remain visible",
      });
      const diagnostic = state.chatRunError;
      expect(diagnostic?.summary).toContain("Diagnostic that must remain visible");
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "same-run",
        state: "final",
        message: { role: "assistant", content: "Another valid late answer" },
      });
      expect(state.chatMessages).toContainEqual(
        expect.objectContaining({ content: "Another valid late answer" }),
      );
      expect(state.chatRunId).toBeNull();
      expect(state.chatRunError).toEqual(diagnostic);
    } finally {
      reconcileChatRunLifecycle(state, { clearRunStatus: true });
    }
  },
);

it.each(["state_contention", "unknown", undefined])(
  "restores only certified contention history (%s) and preserves drafts",
  async (errorKind) => {
    const diagnostic =
      "Temporarily busy. Check status before trying again.\nState contention: session store; attempts exhausted.";
    const state = makeChatHost({
      sessionKey: "main",
      requestHandlers: {
        "chat.history": {
          messages: [
            {
              role: "custom",
              customType: "run-failed-before-reply",
              content: diagnostic,
              details: { errorKind, privateDetail: "must not enter the notice" },
              __openclaw: { id: "failure", seq: 1, runId: "failed-run" },
            },
          ],
          sessionInfo: {
            key: "main",
            kind: "direct",
            updatedAt: 2,
            status: "failed",
            hasActiveRun: false,
            lastRunId: "failed-run",
            lastRunError: "Temporarily busy",
          },
        },
      },
    });
    state.chatMessage = "My unsent draft";
    const attachments = state.chatAttachments;
    await loadChatHistory(state);
    expect(state.chatRunError).toEqual({
      summary: diagnostic,
      runId: "failed-run",
      ...(errorKind === "state_contention" ? { kind: "state_contention" } : {}),
    });
    expect(getChatSessionProjection(state).runs["failed-run"]?.errorKind).toBe(
      errorKind === "state_contention" ? errorKind : undefined,
    );
    expect(state.chatMessage).toBe("My unsent draft");
    expect(state.chatAttachments).toBe(attachments);
    expect(state.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    await loadChatHistory(state);
    expect(state.chatRunError?.kind).toBe(errorKind === "state_contention" ? errorKind : undefined);
    state.sessions.dispose();
  },
);

it("restores separately projected contention diagnostics without putting them in the transcript text", async () => {
  const summary =
    "The turn was interrupted while the server was busy. Check its status before trying again.";
  const diagnostic = "State lifecycle acquisition remained busy.";
  const notice = {
    role: "custom",
    customType: "run-failed-before-reply",
    content: summary,
    details: { errorKind: "state_contention", diagnostic },
    __openclaw: { id: "busy-notice", seq: 1, runId: "busy-run" },
  };
  const state = makeChatHost({
    sessionKey: "main",
    requestHandlers: {
      "chat.history": {
        messages: [notice],
        sessionInfo: {
          key: "main",
          kind: "direct",
          updatedAt: 2,
          status: "failed",
          hasActiveRun: false,
          lastRunId: "busy-run",
          lastRunError: summary,
        },
      },
    },
  });
  await loadChatHistory(state);
  expect(state.chatRunError).toMatchObject({
    kind: "state_contention",
    runId: "busy-run",
    summary: `${summary}\n\n${diagnostic}`,
  });
  expect(state.chatMessages).toContainEqual(expect.objectContaining({ content: summary }));
});
