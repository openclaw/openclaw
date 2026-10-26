// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import { prunePersistedAssistantStreamSegments } from "./stream-segment-pruning.ts";
import { handleSessionOperationEvent } from "./tool-stream-status.ts";
import {
  agentEvent,
  createHost,
  TOOL_STREAM_TEST_NOW,
  useToolStreamFakeTimers,
} from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

function createTimedHost(overrides?: Parameters<typeof createHost>[0]) {
  useToolStreamFakeTimers();
  return createHost(overrides);
}
const globalHost = () =>
  createHost({
    sessionKey: "global",
    assistantAgentId: "work",
    agentsList: { defaultId: "main" },
  });

function emitEvent(host: ReturnType<typeof createHost>, ...event: Parameters<typeof agentEvent>) {
  handleAgentEvent(host, agentEvent(...event));
}

const fallback = {
  phase: "fallback",
  selectedProvider: "fireworks",
  selectedModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
  activeProvider: "deepinfra",
  activeModel: "moonshotai/Kimi-K2.5",
};
const expectedPreamble = (text: string) => ({
  text,
  ts: TOOL_STREAM_TEST_NOW,
  runId: "run-1",
  itemId: "msg-preamble-1",
});

function emitGlobal(
  host: ReturnType<typeof createHost>,
  runId: string,
  seq: number,
  stream: Parameters<typeof agentEvent>[2],
  data: Parameters<typeof agentEvent>[3],
  agentId = "main",
) {
  handleAgentEvent(host, { ...agentEvent(runId, seq, stream, data, "global"), agentId });
}

function emitPreamble(
  host: ReturnType<typeof createHost>,
  runId: string,
  seq: number,
  progressText: string,
  itemId: string,
) {
  emitEvent(host, runId, seq, "item", { kind: "preamble", itemId, progressText });
}

function emitOperation(
  host: ReturnType<typeof createHost>,
  operationId: string,
  phase: "start" | "end",
  sessionKey: string,
  extra: Partial<NonNullable<Parameters<typeof handleSessionOperationEvent>[1]>> = {},
) {
  handleSessionOperationEvent(host, {
    operationId,
    operation: "compact",
    phase,
    sessionKey,
    ts: TOOL_STREAM_TEST_NOW,
    ...extra,
  });
}

function compaction(
  phase: "active" | "retrying" | "complete",
  runId: string,
  extra: { itemId?: string } = {},
) {
  return {
    ...extra,
    phase,
    runId,
    startedAt: TOOL_STREAM_TEST_NOW,
    completedAt: phase === "complete" ? TOOL_STREAM_TEST_NOW : null,
  };
}

function expectCompactionCompleteAndRetained(host: ReturnType<typeof createHost>, itemId?: string) {
  expect(host.compactionStatus).toEqual(compaction("complete", "run-1", itemId ? { itemId } : {}));
  const status = host.compactionStatus;
  vi.advanceTimersByTime(5_000);
  expect(host.compactionStatus).toBe(status);
  expect(host.compactionClearTimer).toBeNull();
}

describe("app-tool-stream fallback lifecycle handling", () => {
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

  it("rejects idle fallback lifecycle events for other sessions", () => {
    useToolStreamFakeTimers();
    const host = createHost();

    emitEvent(host, "run-1", 1, "lifecycle", { ...fallback }, "agent:other:main");

    expect(host.fallbackStatus).toBeNull();
  });

  it("auto-clears fallback status after toast duration", () => {
    const publication = vi.fn();
    const host = createTimedHost();
    chatRunPresentation(host).subscribe(publication);

    emitEvent(host, "run-1", 1, "lifecycle", { ...fallback, reasonSummary: "rate limit" });

    publication.mockClear();
    const expected = {
      phase: "active",
      selected: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
      active: "deepinfra/moonshotai/Kimi-K2.5",
    };
    expect(host.fallbackStatus).toMatchObject({ ...expected, reason: "rate limit" });
    vi.advanceTimersByTime(7_999);
    expect(host.fallbackStatus).toMatchObject(expected);
    expect(publication).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(host.fallbackStatus).toBeNull();
    expect(publication).toHaveBeenCalledOnce();
  });

  it("builds previous fallback label from provider + model on fallback_cleared", () => {
    const host = createTimedHost();

    emitEvent(host, "run-1", 1, "lifecycle", {
      ...fallback,
      phase: "fallback_cleared",
      activeProvider: "fireworks",
      activeModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
      previousActiveProvider: "deepinfra",
      previousActiveModel: "moonshotai/Kimi-K2.5",
    });

    expect(host.fallbackStatus).toMatchObject({
      phase: "cleared",
      previous: "deepinfra/moonshotai/Kimi-K2.5",
    });
  });

  it.each([
    ["main", "agent:main:main", "main", null],
    ["agent:work:thread", "agent:work:thread", "work", "openai/gpt-5-mini"],
    ["global", "global", "work", null],
    ["agent:work:main", "global", "work", null],
  ])(
    "refreshes canonical selection after status changes for %s",
    async (key, target, agentId, override) => {
      const row = {
        key,
        kind: "direct" as const,
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-5.6-sol",
        modelOverrideSource: null,
      };
      const result: SessionsListResult = {
        ts: 1,
        path: "(multiple)",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [row],
      };
      const pendingPatch = createDeferred<unknown>();
      const request = vi.fn(async (method: string) =>
        method === "sessions.patch" ? pendingPatch.promise : result,
      );
      const sessions = createTestSessionCapability(
        {
          snapshot: {
            client: { request } as unknown as GatewayBrowserClient,
            phase: "connected",
            hello: null,
            assistantAgentId: agentId,
            sessionKey: key,
          },
          subscribe: () => () => undefined,
          subscribeEvents: () => () => undefined,
        },
        agentId,
      );
      const sessionHost = () =>
        createHost({
          sessionKey: key,
          assistantAgentId: agentId,
          agentsList: { defaultId: "main", scope: target === "global" ? "global" : "per-sender" },
          sessions,
        });
      const host = sessionHost();
      const event = {
        ...agentEvent(
          "run-1",
          1,
          "tool",
          {
            phase: "result",
            name: "session_status",
            toolCallId: "status-1",
            result: {
              details: { changedModel: true, sessionKey: target, agentId, modelOverride: override },
            },
          },
          key,
        ),
        agentId,
      };
      handleAgentEvent(host, event);
      await waitForFast(() =>
        expect(sessions.state.result?.sessions[0]?.model).toBe("gpt-5.6-sol"),
      );
      expect(request).toHaveBeenCalledWith("sessions.list", expect.objectContaining({ agentId }));
      expect(sessions.state.modelOverrides).toEqual({});

      // Replaying an old tool result reads today's row, without replacing a newer UI intent.
      result.sessions = [{ ...row, model: "gpt-5-mini" }];
      const patch = sessions.patch(key, { model: "openai/gpt-5.6-luna" });
      handleAgentEvent(sessionHost(), event);
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(2),
      );
      await waitForFast(() => expect(sessions.state.loading).toBe(false));
      expect(sessions.state.result?.sessions[0]?.model).toBe("gpt-5-mini");
      expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-5.6-luna");
      pendingPatch.resolve({ ok: true, key, entry: {} });
      await patch;
      expect(sessions.state.modelOverrides).toEqual({});
      sessions.dispose();
    },
  );

  it.each([
    { changedModel: true, sessionKey: "global" },
    { changedModel: false, sessionKey: "global", agentId: "work" },
    { changedModel: true, sessionKey: "agent:work:other", agentId: "work" },
    { changedModel: true, sessionKey: "global", agentId: "main" },
  ])("does not refresh an unrelated/read-only status result (%j)", (details) => {
    const host = globalHost();
    handleAgentEvent(host, {
      ...agentEvent(
        "run-1",
        1,
        "tool",
        {
          phase: "result",
          name: "session_status",
          toolCallId: "status-1",
          result: { details },
        },
        "global",
      ),
      agentId: "work",
    });
    expect(host.sessions.reconcileMutation).not.toHaveBeenCalled();
    expect(host.sessions.state.modelOverrides).toEqual({});
  });

  it("stores keyed preamble item progress as stream segments", () => {
    const host = createTimedHost({ chatRunId: "run-1" });

    emitPreamble(host, "run-1", 1, "Checking", "msg-preamble-1");
    emitPreamble(host, "run-1", 2, "Checking the app-server stream", "msg-preamble-1");

    expect(host.chatStreamSegments).toEqual([expectedPreamble("Checking the app-server stream")]);
    expect(host.chatStream).toBeNull();
  });

  it.each(["run-1", undefined])(
    "replaces only the commentary owned by persisted run %s",
    (runId) => {
      const state = createHost({
        chatStreamSegments: [
          { itemId: "shared-item", runId: "run-1", text: "First run", ts: 1 },
          { itemId: "shared-item", runId: "run-2", text: "Second run", ts: 2 },
        ],
      });
      const originalSegments = [...state.chatStreamSegments];
      const persisted = {
        role: "assistant",
        content: "Completed progress",
        __openclaw: { id: "persisted-commentary", seq: 3, ...(runId ? { runId } : {}) },
        openclawStreamFallback: { itemId: "shared-item", source: "segment" },
      };
      prunePersistedAssistantStreamSegments(state, persisted);
      expect(state.chatStreamSegments).toEqual(
        runId ? originalSegments.filter((segment) => segment.runId !== runId) : [],
      );
      if (runId) {
        state.chatMessages = [persisted];
        emitPreamble(state, runId, 4, "Completed progress", "shared-item");
        expect(state.chatStreamSegments).toEqual(
          originalSegments.filter((segment) => segment.runId !== runId),
        );
      }
    },
  );

  it.each([
    { progressText: "Another run's commentary", name: "replace" },
    { progressText: "", name: "clear" },
  ])("does not let another run $name the active preamble", ({ progressText }) => {
    const host = createTimedHost({ chatRunId: "run-1" });

    emitPreamble(host, "run-1", 1, "The active run's commentary", "msg-preamble-1");
    emitPreamble(host, "run-2", 2, progressText, "msg-preamble-1");

    expect(host.chatStreamSegments).toEqual([expectedPreamble("The active run's commentary")]);
  });

  it("does not insert another run's preamble into the active transcript", () => {
    const host = createTimedHost({ chatRunId: "run-1" });

    emitPreamble(host, "run-2", 1, "Another run's commentary", "msg-preamble-2");

    expect(host.chatStreamSegments).toEqual([]);
  });

  it("accepts a session-scoped preamble while no run is active", () => {
    const host = createTimedHost();

    emitPreamble(host, "run-1", 1, "An already active session's commentary", "msg-preamble-1");

    expect(host.chatStreamSegments).toEqual([
      expectedPreamble("An already active session's commentary"),
    ]);
  });

  it("clears keyed preamble item progress on empty updates", () => {
    const host = createTimedHost({ chatRunId: "run-1" });

    emitPreamble(host, "run-1", 1, "Checking", "msg-preamble-1");
    emitPreamble(host, "run-1", 2, "", "msg-preamble-1");

    expect(host.chatStreamSegments).toEqual([]);
  });

  it("preserves prepared marker text while stripping inline directive tags", () => {
    const host = createTimedHost({ chatRunId: "run-1" });

    emitPreamble(host, "run-1", 1, "Checking [[reply_to_current]]", "msg-preamble-1");
    emitPreamble(host, "run-1", 2, "[[reply_to_current]]", "msg-preamble-2");
    emitPreamble(host, "run-1", 3, "**NO_REPLY", "msg-preamble-1");

    expect(host.chatStreamSegments).toEqual([expectedPreamble("**NO_REPLY")]);
  });

  it("ignores selected-global tool events from another agent", () => {
    const host = globalHost();

    emitGlobal(host, "run-main-global", 1, "tool", {
      phase: "start",
      name: "exec",
      toolCallId: "tool-main-global",
    });

    expect(host.toolStreamOrder).toHaveLength(0);
  });

  it("ignores selected-global lifecycle and fallback events from another agent", () => {
    const host = globalHost();

    emitGlobal(host, "run-main-global", 1, "compaction", { phase: "start" });
    emitGlobal(host, "run-main-global", 2, "lifecycle", fallback);
    emitGlobal(host, "run-main-global", 3, "fallback", fallback);

    expect(host.compactionStatus).toBeNull();
    expect(host.fallbackStatus).toBeNull();
  });

  it.each([{ phase: "start" }, { phase: "end", completed: true, willRetry: true }])(
    "keeps newer compaction active after stale $phase event %j",
    (staleData) => {
      const host = createTimedHost();
      emitEvent(host, "run-1", 1, "compaction", { phase: "start", itemId: "compact-1" });
      emitEvent(host, "run-1", 3, "compaction", { phase: "start", itemId: "compact-2" });
      emitEvent(host, "run-1", 2, "compaction", { ...staleData, itemId: "compact-1" });
      expect(host.compactionStatus).toMatchObject({ phase: "active", itemId: "compact-2" });

      emitEvent(host, "run-1", 4, "compaction", {
        phase: "end",
        completed: true,
        itemId: "compact-2",
      });
      emitEvent(host, "run-1", 3, "compaction", { phase: "start", itemId: "compact-2" });
      expectCompactionCompleteAndRetained(host, "compact-2");

      emitEvent(host, "run-2", 1, "compaction", { phase: "start", itemId: "compact-3" });
      expect(host.compactionStatus).toMatchObject({
        phase: "active",
        runId: "run-2",
        itemId: "compact-3",
      });
      vi.advanceTimersByTime(5 * 60_000);
      expect(host.compactionStatus).toBeNull();
    },
  );

  it("keeps compaction in retry-pending state until the matching lifecycle end", () => {
    const host = createTimedHost();

    emitEvent(host, "run-1", 1, "compaction", { phase: "start", itemId: "compact-1" });

    expect(host.compactionStatus).toEqual(compaction("active", "run-1", { itemId: "compact-1" }));

    emitEvent(host, "run-1", 2, "compaction", {
      phase: "end",
      willRetry: true,
      completed: true,
    });

    expect(host.compactionStatus).toEqual(compaction("retrying", "run-1", { itemId: "compact-1" }));
    expect(host.compactionClearTimer).not.toBeNull();

    emitEvent(host, "run-2", 3, "lifecycle", { phase: "end" });
    emitEvent(host, "run-1", 1, "lifecycle", { phase: "end" });

    expect(host.compactionStatus).toEqual(compaction("retrying", "run-1", { itemId: "compact-1" }));

    emitEvent(host, "run-1", 4, "lifecycle", { phase: "end" });

    expectCompactionCompleteAndRetained(host, "compact-1");
  });

  it("keeps recovery compaction status and expiry when hook notices arrive", () => {
    const host = createTimedHost();
    emitEvent(host, "run-1", 1, "compaction", { phase: "start", itemId: "recovery-1" });
    const status = host.compactionStatus;
    const timer = host.compactionClearTimer;
    emitEvent(host, "run-1", 2, "compaction", { phase: "notice", messages: ["Preparing context"] });
    expect(host.compactionStatus).toBe(status);
    expect(host.compactionClearTimer).toBe(timer);
    vi.advanceTimersByTime(5 * 60_000);
    expect(host.compactionStatus).toBeNull();
    expect(host.compactionClearTimer).toBeNull();
  });

  it("auto-clears active compaction after the stale timeout", () => {
    useToolStreamFakeTimers();
    const host = createHost();

    emitEvent(host, "run-1", 1, "compaction", { phase: "start" });

    expect(host.compactionStatus).toEqual({
      phase: "active",
      runId: "run-1",
      startedAt: TOOL_STREAM_TEST_NOW,
      completedAt: null,
    });
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(host.compactionStatus).toEqual({
      phase: "active",
      runId: "run-1",
      startedAt: TOOL_STREAM_TEST_NOW,
      completedAt: null,
    });

    vi.advanceTimersByTime(1);

    expect(host.compactionStatus).toBeNull();
    expect(host.compactionClearTimer).toBeNull();
  });

  it("shows manual session operation compaction progress while idle", () => {
    const host = createTimedHost({
      sessionKey: "main",
      hello: {
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "main",
            mainKey: "main",
            mainSessionKey: "agent:main:main",
          },
        },
      },
    });

    emitOperation(host, "operation-1", "start", "agent:main:main");

    expect(host.compactionStatus).toEqual(compaction("active", "operation-1"));

    emitOperation(host, "operation-1", "end", "agent:main:main", { completed: true });

    expect(host.compactionStatus).toEqual(compaction("complete", "operation-1"));
  });

  it("ignores manual session operation compaction for other sessions", () => {
    useToolStreamFakeTimers();
    const host = createHost({ sessionKey: "agent:main:main" });

    handleSessionOperationEvent(host, {
      operationId: "operation-1",
      operation: "compact",
      phase: "start",
      sessionKey: "agent:other:main",
      ts: TOOL_STREAM_TEST_NOW,
    });

    expect(host.compactionStatus).toBeNull();
    expect(host.compactionClearTimer).toBeNull();
  });

  it("ignores selected-global session operation compaction for another agent", () => {
    const host = createTimedHost({
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
    });

    emitOperation(host, "operation-main", "start", "global", { agentId: "main" });

    expect(host.compactionStatus).toBeNull();
    expect(host.compactionClearTimer).toBeNull();
  });

  it("accepts canonical global live events for selected agent main aliases", () => {
    const host = createTimedHost({
      sessionKey: "agent:work:main",
      agentsList: { defaultId: "main", scope: "global" },
    });

    emitGlobal(host, "run-work", 1, "compaction", { phase: "start" }, "work");

    expect(host.compactionStatus).toEqual(compaction("active", "run-work"));

    emitGlobal(host, "run-main", 2, "fallback", {
      phase: "fallback_started",
      selectedProvider: "openai",
      selectedModel: "gpt-5",
    });

    expect(host.fallbackStatus).toBeNull();
  });

  it("ignores stale manual session operation completion after a newer start", () => {
    const host = createTimedHost({ sessionKey: "agent:main:main" });

    emitOperation(host, "operation-1", "start", "agent:main:main");
    emitOperation(host, "operation-2", "start", "agent:main:main");
    emitOperation(host, "operation-1", "end", "agent:main:main", { completed: true });

    expect(host.compactionStatus).toEqual(compaction("active", "operation-2"));
    vi.advanceTimersByTime(5 * 60_000);
    expect(host.compactionStatus).toBeNull();
    expect(host.compactionClearTimer).toBeNull();
  });

  it("treats lifecycle error as terminal for retry-pending compaction", () => {
    useToolStreamFakeTimers();
    const host = createHost();

    emitEvent(host, "run-1", 1, "compaction", { phase: "start" });

    emitEvent(host, "run-1", 2, "compaction", {
      phase: "end",
      willRetry: true,
      completed: true,
    });

    expect(host.compactionStatus).toEqual({
      phase: "retrying",
      runId: "run-1",
      startedAt: TOOL_STREAM_TEST_NOW,
      completedAt: null,
    });

    emitEvent(host, "run-1", 3, "lifecycle", { phase: "error", error: "boom" });

    expectCompactionCompleteAndRetained(host);
  });

  it("does not surface retrying or complete when retry compaction failed", () => {
    const host = createTimedHost();

    emitEvent(host, "run-1", 1, "compaction", { phase: "start" });

    emitEvent(host, "run-1", 2, "compaction", {
      phase: "end",
      willRetry: true,
      completed: false,
    });

    expect(host.compactionStatus).toBeNull();
    expect(host.compactionClearTimer).toBeNull();

    emitEvent(host, "run-1", 3, "lifecycle", { phase: "error", error: "boom" });

    expect(host.compactionStatus).toBeNull();
    expect(host.compactionClearTimer).toBeNull();
  });
});
