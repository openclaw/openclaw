// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readToolApprovalReviews } from "../../lib/chat/tool-approval-reviews.ts";
import { readPreparedActivity, summarizeToolGroup } from "../../lib/chat/tool-call-grouping.ts";
import { extractToolCardsCached, resolveToolCardOutcome } from "../../lib/chat/tool-cards.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import { activeChatRunStartupStatus, chatStartupStatusLabel } from "./chat-run-startup.ts";
import { coalesceToolActivityMessages } from "./chat-tool-activity-coalesce.ts";
import { buildToolStreamIdentity } from "./tool-stream-identity.ts";
import { reconcileWaitingApprovalsFromSnapshot } from "./tool-stream-snapshot.ts";
import { resetToolStream } from "./tool-stream-state.ts";
import {
  agentEvent,
  createHost,
  TOOL_STREAM_TEST_NOW,
  useToolStreamFakeTimers,
} from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

const startupLabel = (host: ReturnType<typeof createHost>) =>
  chatStartupStatusLabel(activeChatRunStartupStatus(host.chatRunStartup), null);
const reviewIds = (details: unknown) => readToolApprovalReviews(details).map((review) => review.id);
const messageItem = (key: string, message: unknown) => ({ kind: "message" as const, key, message });
const steer = (id: string, text: string) => ({
  role: "user",
  content: text,
  __openclaw: { idempotencyKey: `${id}:user`, steerTargetRunId: "run-1" },
});

function emitEvent(host: ReturnType<typeof createHost>, ...event: Parameters<typeof agentEvent>) {
  handleAgentEvent(host, agentEvent(...event));
}

function toolEvents(
  host: ReturnType<typeof createHost>,
  runId: string,
  defaults: Parameters<typeof agentEvent>[3],
) {
  return (seq: number, data: Parameters<typeof agentEvent>[3]) =>
    emitEvent(host, runId, seq, "tool", { ...defaults, ...data });
}

function reviewData(
  id: string,
  status: "approved" | "denied",
  extra: Record<string, unknown> = {},
  outcome = status,
) {
  return {
    phase: "review",
    approvalReviewOutcome: outcome,
    review: { id, label: "Guardian", status, ...extra },
  };
}

const globalWithWindow = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis;
};
let installedTestWindow = false;

beforeAll(() => {
  if (!globalWithWindow.window) {
    globalWithWindow.window = globalThis as unknown as Window & typeof globalThis;
    installedTestWindow = true;
  }
});

afterAll(() => {
  if (installedTestWindow) {
    Reflect.deleteProperty(globalWithWindow, "window");
  }
});

afterEach(() => vi.useRealTimers());

it.each(["live", "history"] as const)(
  "anchors only first-observed live tools and commentary (%s)",
  (source) => {
    useToolStreamFakeTimers();
    const host = createHost({
      chatRunId: "run-1",
      chatMessages: [steer("steer", "Steer")],
    });
    const tool = agentEvent("run-1", 1, "tool", {
      phase: "start",
      toolCallId: "call",
      name: "read",
    });
    handleAgentEvent(host, tool, source);
    handleAgentEvent(
      host,
      agentEvent("run-1", 2, "item", {
        kind: "preamble",
        itemId: "comment",
        progressText: "Checking.",
      }),
      source,
    );
    const expected = source === "live" ? "steer" : undefined;
    expect(host.toolStreamById.get(buildToolStreamIdentity("run-1", "call"))?.afterUserSendId).toBe(
      expected,
    );
    expect(host.chatStreamSegments[0]?.afterUserSendId).toBe(expected);
    host.chatMessages = [...(host.chatMessages ?? []), steer("later", "Later")];
    handleAgentEvent(host, {
      ...tool,
      seq: 3,
      data: { ...tool.data, phase: "result", result: "Done" },
    });
    expect(host.chatToolMessages[0]?.openclawToolStreamAfterSendId).toBe(expected);
    resetToolStream(host);
  },
);

describe("status text truncation", () => {
  it("restores model waits after prior activity and rejects stale wait replay", () => {
    const host = createHost({ chatRunId: "run-1" });
    emitEvent(host, "run-1", 1, "assistant", { text: "First result" });
    emitEvent(host, "run-1", 2, "run_status", {
      phase: "waiting_for_model",
      reason: "slot",
    });
    expect(startupLabel(host)).toBe("Waiting for a free model slot");
    emitEvent(host, "run-1", 3, "run_status", { phase: "starting_model" });
    handleAgentEvent(
      host,
      agentEvent("run-1", 2, "run_status", {
        phase: "waiting_for_model",
        reason: "slot",
      }),
      "history",
    );
    expect(startupLabel(host)).toBe("Waiting for a response");
  });

  it("keeps retry labels generic and preserves complete characters in provider model labels", () => {
    const expected = "x".repeat(255);
    const input = `${expected}😀 trailing`;
    const host = createHost({
      chatRunId: "run-1",
      chatRunStartup: { state: "status", runId: "run-1", phase: "starting_model" },
      toolStreamSyncTimer: 1,
    });
    emitEvent(host, "run-1", 1, "run_status", {
      phase: "retrying",
      message: input,
    });
    expect(startupLabel(host)).toBe("Retrying…");
    emitEvent(host, "run-1", 2, "notice", {
      phase: "provider_policy",
      category: "cyber",
      provider: "openai",
      state: "fallback",
      model: input,
      fallbackModel: input,
    });
    expect(host.providerPolicyNotice?.model).toBe(expected);
    expect(host.providerPolicyNotice?.fallbackModel).toBe(expected);
  });
});

describe("app-tool-stream approval lifecycle", () => {
  it.each([true, false])(
    "keeps terminal tool activity through history and replay (result: %s)",
    (withResult) => {
      const host = createHost({ chatRunId: "run-1" });
      const started = {
        itemId: "tool:call",
        toolCallId: "call",
        kind: "tool",
        name: "process",
        title: "Check process",
        phase: "start",
        status: "running",
        hideFromChannelProgress: true,
      };
      const completed = {
        ...started,
        phase: "end",
        status: withResult ? "completed" : undefined,
        title: "Stop process",
        hideFromChannelProgress: false,
      };
      const completedEvent = Object.freeze({ ...completed, diagnostic: { source: "native-tool" } });
      const historyCall = {
        role: "assistant",
        runId: "run-1",
        content: [{ type: "toolCall", id: "call", name: "process", arguments: { action: "poll" } }],
        activity: [started],
      };
      const emit = toolEvents(host, "run-1", { toolCallId: "call", name: "process" });
      emit(1, { phase: "start", args: { action: "poll" } });
      emitEvent(host, "run-1", 2, "item", started);
      if (withResult) {
        emit(3, { phase: "result", isError: false, result: "raw execution result" });
      }
      emitEvent(host, "run-1", 4, "item", completedEvent);
      emitEvent(host, "run-1", 2, "item", started);
      const reconciled = coalesceToolActivityMessages([
        messageItem("history", { ...historyCall, __openclaw: { id: "history-call" } }),
        messageItem("live", [...host.toolStreamById.values()][0]!.message),
      ]);
      const messages = reconciled.flatMap((item) =>
        item.kind === "message" ? [item.message] : [],
      );
      const activity = messages.flatMap(readPreparedActivity);
      expect(activity).toEqual([completed]);
      expect(summarizeToolGroup(activity)).toBe(
        withResult ? "1 other operation" : "1 other operation · 1 unknown",
      );
      expect(activity[0]).not.toHaveProperty("diagnostic");
      expect(completedEvent.diagnostic).toEqual({ source: "native-tool" });
      const cards = messages.flatMap(extractToolCardsCached);
      expect(cards).toMatchObject([{ args: { action: "poll" }, completed: true }]);
      expect(cards.map((card) => card.outputText)).toEqual([
        withResult ? "raw execution result" : undefined,
      ]);
      expect(cards.map((card) => resolveToolCardOutcome(card, true))).toEqual([
        withResult ? "succeeded" : "unknown",
      ]);
      expect(messages[0]).toMatchObject({ __openclawToolStreamResultReceived: withResult });
      const quietHistory = coalesceToolActivityMessages([
        messageItem("call", historyCall),
        messageItem("result", {
          role: "toolResult",
          runId: "run-1",
          toolCallId: "call",
          toolName: "process",
          isError: false,
          content: "raw wait result",
          activity: [],
        }),
      ]);
      expect(
        quietHistory.flatMap((item) =>
          item.kind === "message" ? readPreparedActivity(item.message) : [],
        ),
      ).toEqual([]);
      resetToolStream(host);
    },
  );

  it("keeps suppressed native item completion from settling the visible call", () => {
    const host = createHost({ chatRunId: "run-1" });
    emitEvent(host, "run-1", 1, "tool", {
      toolCallId: "call",
      name: "exec",
      phase: "start",
      args: { command: "check" },
    });
    emitEvent(host, "run-1", 2, "item", {
      itemId: "native-call",
      toolCallId: "call",
      kind: "command",
      name: "exec",
      title: "Check",
      phase: "end",
      suppressChannelProgress: true,
    });
    const [card] = extractToolCardsCached(host.chatToolMessages[0]);
    expect(resolveToolCardOutcome(card!, true)).toBe("running");
    expect(card?.outputText).toBeUndefined();
    resetToolStream(host);
  });

  it.each(["result", "review"])("keeps text streaming through %s activity", (phase) => {
    useToolStreamFakeTimers();
    const host = createHost({
      chatRunId: "run-1",
      chatStream: "I'll check",
      chatStreamStartedAt: TOOL_STREAM_TEST_NOW,
    });
    try {
      emitEvent(host, "run-1", 1, "tool", {
        phase,
        toolCallId: "call",
        name: "read",
        review: { id: "review", label: "Approval", status: "approved" },
      });
      expect(host.chatStream).toBe("I'll check");
      expect(host.chatStreamStartedAt).toBe(TOOL_STREAM_TEST_NOW);
      expect(host.chatStreamSegments).toEqual([]);
      expect(host.toolStreamById.size).toBe(1);
      if (phase === "result") {
        const entry = host.toolStreamById.get(buildToolStreamIdentity("run-1", "call"));
        expect(entry?.resultReceived).toBe(true);
        expect(entry?.receivedAt).toBe(TOOL_STREAM_TEST_NOW);
        expect(entry?.message["__openclawToolStreamReceivedAt"]).toBe(TOOL_STREAM_TEST_NOW);
        expect(entry?.message.content).toContainEqual({
          type: "toolresult",
          name: "read",
          text: "",
        });
      }
    } finally {
      resetToolStream(host);
      vi.useRealTimers();
    }
  });

  it("preserves producer parent identity through live completion without reading arguments", () => {
    const host = createHost();
    const emit = toolEvents(host, "nested-run", { name: "exec", toolCallId: "child" });
    emit(1, {
      phase: "start",
      parentToolCallId: "outer",
      args: { command: "gh auth login", parentToolCallId: "argument-is-not-provenance" },
    });
    emit(2, {
      phase: "result",
      isError: true,
      result: { content: [{ type: "text", text: "gh: command not found" }] },
    });
    const entry = [...host.toolStreamById.values()][0];
    expect(extractToolCardsCached(entry?.message)).toMatchObject([
      {
        callId: "child",
        runId: "nested-run",
        parentToolCallId: "outer",
        completed: true,
        isError: true,
      },
    ]);
  });

  it("carries browser tab details through the completed live result, including empty text", () => {
    const host = createHost();
    const emit = toolEvents(host, "browser-run", { name: "browser", toolCallId: "browser-call" });
    emit(1, { phase: "start", args: { action: "open" } });
    emit(2, {
      phase: "result",
      result: {
        content: [],
        details: {
          browserTab: {
            profile: "managed",
            target: "host",
            targetId: "tab-1",
            url: "https://example.com",
            title: "Example",
          },
        },
      },
    });
    const entry = [...host.toolStreamById.values()][0];
    const [card] = extractToolCardsCached(entry?.message);
    expect(card).toMatchObject({
      completed: true,
      live: true,
      preview: {
        kind: "browser-tab",
        profile: "managed",
        target: "host",
        targetId: "tab-1",
        title: "Example",
      },
    });
    resetToolStream(host);
  });

  const approval = (runId: string | undefined, sessionKey = "main") => ({
    id: "approval-1",
    kind: "exec" as const,
    request: { command: "echo test", sessionKey, runId },
    createdAtMs: 1,
    expiresAtMs: 2,
  });

  const learnRun = (host: ReturnType<typeof createHost>, runId: string) => {
    emitEvent(host, runId, 1, "lifecycle", { phase: "start" });
  };

  it("clears only parked runs whose approvals leave the queue snapshot", () => {
    const host = createHost({
      waitingApprovalStatuses: new Map([
        ["approval-1", { approvalId: "approval-1", toolCallId: "tool-1", runId: "run-1" }],
        ["approval-2", { approvalId: "approval-2", toolCallId: "tool-2", runId: "run-2" }],
      ]),
    });

    expect(
      reconcileWaitingApprovalsFromSnapshot(host, [{ ...approval("run-2"), id: "approval-2" }]),
    ).toBe(true);
    expect([...host.waitingApprovalStatuses!.keys()]).toEqual(["approval-2"]);
  });

  it("clears hydrated state when the lifecycle resolution arrives", () => {
    const host = createHost({ waitingApprovalStatuses: new Map() });
    learnRun(host, "run-1");
    reconcileWaitingApprovalsFromSnapshot(host, [approval("run-1")]);

    emitEvent(host, "run-1", 1, "lifecycle", {
      phase: "approval-resolved",
      approvalId: "approval-1",
    });

    expect(host.waitingApprovalStatuses?.size).toBe(0);

    resetToolStream(host);
    expect(reconcileWaitingApprovalsFromSnapshot(host, [approval("run-1")])).toBe(false);
    expect(host.waitingApprovalStatuses?.size).toBe(0);

    reconcileWaitingApprovalsFromSnapshot(host, []);
    learnRun(host, "run-1");
    expect(reconcileWaitingApprovalsFromSnapshot(host, [approval("run-1")])).toBe(true);
  });

  it("replaces hydrated state with the authoritative lifecycle payload", () => {
    const host = createHost({ waitingApprovalStatuses: new Map() });
    learnRun(host, "run-1");
    reconcileWaitingApprovalsFromSnapshot(host, [approval("run-1")]);

    emitEvent(host, "run-1", 1, "lifecycle", {
      phase: "waiting-approval",
      approvalId: "approval-1",
      toolCallId: "tool-1",
    });

    expect(host.waitingApprovalStatuses?.get("approval-1")).toEqual({
      runId: "run-1",
    });
  });
});

describe("app-tool-stream throttled projections", () => {
  it("renders a deferred tool update when its projection flushes", () => {
    useToolStreamFakeTimers();
    const publication = vi.fn();
    const host = createHost();
    chatRunPresentation(host).subscribe(publication);
    const toolCallId = "call-deferred";
    const emit = toolEvents(host, "run-1", { name: "read", toolCallId });
    emit(1, { phase: "start", args: { path: "notes.txt" } });
    vi.advanceTimersByTime(80);
    publication.mockClear();
    emit(2, { phase: "update", partialResult: "still reading" });
    expect(publication).not.toHaveBeenCalled();
    vi.advanceTimersByTime(79);
    expect(publication).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(host.chatToolMessages).toHaveLength(1);
    expect(publication).toHaveBeenCalledOnce();
    expect(host.chatToolMessages[0]?.content).toEqual([
      { type: "toolcall", name: "read", arguments: { path: "notes.txt" } },
      { type: "toolresult", name: "read", text: "still reading" },
    ]);
  });

  it("does not let an older replay replace newer live tool progress", () => {
    useToolStreamFakeTimers();
    const host = createHost();
    const toolCallId = "call-sequenced";
    const emit = toolEvents(host, "run-1", { name: "read", toolCallId });
    emit(1, { phase: "start", args: { path: "README.md" } });
    emit(3, { phase: "update", partialResult: "newer live progress" });
    emit(2, { phase: "update", partialResult: "older replayed progress" });
    vi.advanceTimersByTime(80);
    expect(host.chatToolMessages[0]?.content).toEqual([
      { type: "toolcall", name: "read", arguments: { path: "README.md" } },
      { type: "toolresult", name: "read", text: "newer live progress" },
    ]);
  });
});

it.each(["live", "history"] as const)(
  "does not create raw tool bubbles for display-hidden automation activity (%s)",
  (source) => {
    useToolStreamFakeTimers();
    const host = createHost();
    for (const [index, phase] of ["start", "update", "result"].entries()) {
      for (const stream of ["item", "tool"] as const) {
        handleAgentEvent(
          host,
          agentEvent("run-quiet", index * 2 + (stream === "item" ? 1 : 2), stream, {
            itemId: "tool:quiet-call",
            toolCallId: "quiet-call",
            kind: "tool",
            name: "automations",
            title: "Automations",
            phase: stream === "item" && phase === "result" ? "end" : phase,
            hideFromChannelProgress: true,
            display: false,
          }),
          source,
        );
      }
    }
    vi.advanceTimersByTime(80);
    expect(host.chatToolMessages).toEqual([]);
    expect(host.toolStreamOrder).toEqual([]);
    // A later attention result has no display suppression and must still create its card.
    handleAgentEvent(
      host,
      agentEvent("run-quiet", 7, "tool", {
        toolCallId: "quiet-call",
        name: "automations",
        phase: "result",
        isError: true,
        result: "The check failed.",
      }),
      source,
    );
    expect(host.chatToolMessages.flatMap(extractToolCardsCached)).toMatchObject([
      { name: "automations", isError: true },
    ]);
    resetToolStream(host);
  },
);

it("does not render Codex reasoning items as tool calls", () => {
  const host = createHost({ chatRunId: "run-1" });
  const reasoning = {
    itemId: "rs_1",
    toolCallId: "rs_1",
    kind: "analysis",
    title: "Reasoning",
    phase: "start",
    status: "running",
    hideFromChannelProgress: true,
  };
  emitEvent(host, "run-1", 1, "item", reasoning);
  emitEvent(host, "run-1", 2, "item", { ...reasoning, phase: "end", status: "completed" });
  emitEvent(host, "run-1", 3, "item", {
    itemId: "tool:call",
    toolCallId: "call",
    kind: "tool",
    name: "read",
    title: "Read",
    phase: "end",
    status: "completed",
  });

  expect(host.toolStreamOrder).toEqual([buildToolStreamIdentity("run-1", "call")]);
  expect(host.chatToolMessages.flatMap(extractToolCardsCached)).toMatchObject([{ name: "read" }]);
});

describe("app-tool-stream result blocks", () => {
  it("retains out-of-order review identities and lets a result fence every older review", () => {
    const host = createHost();
    const toolCallId = "call-reviewed";
    const emit = toolEvents(host, "run-1", { toolCallId });
    emit(
      4,
      reviewData("review-b", "approved", {
        riskLevel: "low",
        userAuthorization: "high",
        rationale: "Newer live review.",
      }),
    );
    emit(1, { phase: "start", name: "exec", args: { command: "git status --short" } });
    emit(2, reviewData("review-a", "approved", { rationale: "Older snapshot review." }));
    emit(3, reviewData("review-b", "denied"));

    const identity = buildToolStreamIdentity("run-1", toolCallId);
    const details = host.toolStreamById.get(identity)?.details;
    expect(reviewIds(details)).toEqual(["review-a", "review-b"]);
    expect(details).toMatchObject({ approvalReviewOutcome: "approved" });

    emit(5, { phase: "result", name: "exec", result: { details: { runtime: "native" } } });
    emit(3, reviewData("review-c", "denied"));

    const completed = host.toolStreamById.get(identity);
    expect(completed?.resultReceived).toBe(true);
    expect(reviewIds(completed?.details)).toEqual(["review-a", "review-b"]);
    expect(completed?.details).toMatchObject({
      runtime: "native",
      approvalReviewOutcome: "approved",
    });
  });

  it.each(["early", "out-of-order"])("keeps %s denial beyond the review display cap", (order) => {
    const host = createHost();
    const toolCallId = "call-many-reviews";
    const emit = toolEvents(host, "run-1", { toolCallId });
    const early = order === "early";
    const prefix = early ? "review" : "newer-review";
    emit(1, { phase: "start", name: "exec", args: { command: "printf reviewed" } });
    for (let index = 0; index < (early ? 18 : 16); index += 1) {
      emit(
        index + (early ? 2 : 3),
        reviewData(
          `${prefix}-${index}`,
          early && index === 0 ? "denied" : "approved",
          {},
          early ? "denied" : "approved",
        ),
      );
    }
    if (!early) {
      emit(2, reviewData("older-denied-review", "denied"));
    }
    const identity = buildToolStreamIdentity("run-1", toolCallId);
    expect(reviewIds(host.toolStreamById.get(identity)?.details)).toEqual(
      Array.from({ length: 16 }, (_, index) => `${prefix}-${index + (early ? 2 : 0)}`),
    );
    expect(host.toolStreamById.get(identity)?.details).toMatchObject({
      approvalReviewOutcome: "denied",
    });
    if (!early) {
      emit(19, {
        phase: "result",
        name: "exec",
        approvalReviewOutcome: "approved",
        result: { details: { runtime: "native", approvalReviewOutcome: "approved" } },
      });
      expect(host.toolStreamById.get(identity)?.details).toMatchObject({
        runtime: "native",
        approvalReviewOutcome: "denied",
      });
    }
  });

  it("projects live edit counts and lets the resolved result replace them without flicker", () => {
    useToolStreamFakeTimers();
    const host = createHost({ chatRunId: "run-1" });
    const toolCallId = "call-live-edit";
    const identity = buildToolStreamIdentity("run-1", toolCallId);
    const emit = toolEvents(host, "run-1", { name: "edit", toolCallId });
    emit(1, { phase: "start", args: { path: "src/report.ts" } });
    emit(2, { phase: "input_delta", diff: { added: 12, removed: 3 } });
    vi.advanceTimersByTime(80);
    expect(host.toolStreamById.get(identity)?.liveDiffStat).toEqual({ added: 12, removed: 3 });
    expect(host.chatToolMessages[0]?.["__openclawToolStreamDiffStat"]).toEqual({
      added: 12,
      removed: 3,
    });
    emit(3, { phase: "result", result: { details: { diff: "-1 old\n+1 new" } } });
    const resolved = host.toolStreamById.get(identity);
    expect(resolved?.liveDiffStat).toBeUndefined();
    expect(resolved?.details).toEqual({ diff: "-1 old\n+1 new" });
    expect(resolved?.message).not.toHaveProperty("__openclawToolStreamDiffStat");
    expect(host.chatToolMessages[0]).not.toHaveProperty("__openclawToolStreamDiffStat");
  });

  it("applies session-status effects when the result reports a placeholder tool name", () => {
    const host = createHost();
    const toolCallId = "status-preserve-name";
    const emit = toolEvents(host, "run-1", { toolCallId });
    emit(1, { phase: "start", name: "session_status" });
    emit(2, {
      phase: "result",
      name: "tool",
      result: {
        details: {
          changedModel: true,
          sessionKey: "main",
          agentId: "main",
          modelOverride: "openai/gpt-5.6-luna",
        },
      },
    });

    expect(host.sessions.reconcileMutation).toHaveBeenCalledOnce();
    expect(host.sessions.state.modelOverrides).toEqual({});
  });

  it("keeps interleaved sibling-run calls and results under independent identities", () => {
    const host = createHost({ chatRunId: "run-foreground" });
    const toolCallId = "call-shared";
    const foregroundIdentity = buildToolStreamIdentity("run-foreground", toolCallId);
    const backgroundIdentity = buildToolStreamIdentity("run-background", toolCallId);
    const foreground = toolEvents(host, "run-foreground", { toolCallId, name: "read" });
    const background = toolEvents(host, "run-background", { toolCallId, name: "exec" });
    foreground(1, { phase: "start", args: { path: "foreground.txt" } });
    background(1, { phase: "start", args: { command: "background command" } });
    foreground(2, { phase: "update", partialResult: "foreground partial" });
    background(2, { phase: "update", partialResult: "background partial" });
    background(3, { phase: "result", isError: true, result: "background failed" });

    expect(host.toolStreamOrder).toEqual([foregroundIdentity, backgroundIdentity]);
    expect(host.toolStreamById.get(foregroundIdentity)).toMatchObject({
      runId: "run-foreground",
      toolCallId,
      name: "read",
      args: { path: "foreground.txt" },
      output: "foreground partial",
      message: {
        runId: "run-foreground",
        toolCallId,
        __openclawToolStreamResultReceived: false,
      },
    });
    expect(host.toolStreamById.get(backgroundIdentity)).toMatchObject({
      runId: "run-background",
      toolCallId,
      name: "exec",
      args: { command: "background command" },
      output: "background failed",
      isError: true,
      resultReceived: true,
      message: {
        runId: "run-background",
        toolCallId,
        __openclawToolStreamResultReceived: true,
      },
    });
    expect(host.chatToolMessages.map((message) => message.runId)).toEqual([
      "run-foreground",
      "run-background",
    ]);

    foreground(3, {
      phase: "result",
      isError: false,
      result: "foreground completed",
    });

    expect(host.toolStreamById.get(foregroundIdentity)).toMatchObject({
      output: "foreground completed",
      isError: false,
      resultReceived: true,
    });
    expect(host.toolStreamById.get(backgroundIdentity)).toMatchObject({
      output: "background failed",
      isError: true,
      resultReceived: true,
    });
  });
});

it("shows a fallback attempt in the claw until same-run output resumes", () => {
  const host = createHost({ chatRunId: "run-1", toolStreamSyncTimer: 1 });
  emitEvent(host, "run-1", 10, "run_status", {
    phase: "retrying",
    message: "Rate limited",
    retryAt: 20_000,
  });
  expect(host.chatRunStartup).toMatchObject({ phase: "retrying", retryAt: 20_000 });
  emitEvent(host, "run-1", 11, "lifecycle", {
    phase: "fallback_step",
    fallbackStepToModel: "example/backup",
    fallbackStepFinalOutcome: "next_fallback",
  });
  expect(startupLabel(host)).toBe("Trying fallback model…");
  emitEvent(host, "run-1", 12, "assistant", { text: "Recovered" });
  expect(startupLabel(host)).toBeUndefined();
});
