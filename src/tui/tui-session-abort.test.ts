import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { TuiBackend } from "./tui-backend.js";
import {
  createBaseState,
  createTestSessionActions,
  makeChatLog,
  makeTui,
  makeTuiBackend,
} from "./tui-session-actions-test-support.js";
import {
  getPendingSubmitAcceptedRunId,
  getPendingSubmitDraft,
  type TuiPendingSubmit,
} from "./tui-submit-state.js";

const acceptedSubmit = (runId: string, draftText: string | null = "pending"): TuiPendingSubmit => ({
  phase: "accepted",
  runId,
  draftText,
});

function abortHarness(
  overrides: Parameters<typeof createBaseState>[0],
  aborted = true,
  local = false,
) {
  const abortChat = vi.fn().mockResolvedValue({ ok: true, aborted });
  const loadHistory = vi.fn().mockResolvedValue({ sessionInfo: { hasActiveRun: false } });
  const addSystem = vi.fn();
  const dropPendingUser = vi.fn();
  const setActivityStatus = vi.fn();
  const requestRender = vi.fn();
  const invalidateRunOwnership = vi.fn();
  const state = createBaseState({ historyLoaded: true, ...overrides });
  const actions = createTestSessionActions({
    client: makeTuiBackend({ loadHistory, abortChat }),
    chatLog: makeChatLog({ addSystem, clearAll: vi.fn(), dropPendingUser }),
    tui: makeTui({ requestRender }),
    opts: { local },
    state,
    setActivityStatus,
    invalidateRunOwnership,
  });
  return {
    ...actions,
    abortChat,
    loadHistory,
    addSystem,
    dropPendingUser,
    setActivityStatus,
    requestRender,
    invalidateRunOwnership,
    state,
  };
}

describe("TUI selected-session abort", () => {
  it.each([
    { name: "registered pending run", draft: null, active: null, global: false, aborted: true },
    { name: "optimistic pending run", draft: "hello", active: null, global: false, aborted: true },
    { name: "selected global run", draft: null, active: null, global: true, aborted: true },
    { name: "queued gateway run", draft: null, active: "run-active", global: false, aborted: true },
    { name: "missing backend run", draft: "hello", active: null, global: false, aborted: false },
    {
      name: "completed active run",
      draft: null,
      active: "run-active",
      global: false,
      aborted: false,
    },
  ])(
    "reconciles $name after a session-scoped abort",
    async ({ draft, active, global, aborted }) => {
      const sessionKey = global ? "global" : "agent:main:main";
      const h = abortHarness(
        {
          currentSessionKey: sessionKey,
          currentAgentId: global ? "work" : "main",
          activeChatRunId: active,
          pendingSubmit: acceptedSubmit("run-pending", draft),
          activityStatus: active ? "waiting" : "idle",
        },
        aborted,
      );
      await h.abortActive();
      expect(h.abortChat).toHaveBeenCalledWith({
        sessionKey,
        ...(global ? { agentId: "work" } : {}),
      });
      expect(h.state.pendingSubmit).toBeNull();
      expect(h.setActivityStatus).toHaveBeenCalledWith(aborted ? "aborted" : "idle");
      if (!aborted) {
        expect(h.state.activeChatRunId).toBeNull();
        expect(h.invalidateRunOwnership).toHaveBeenCalledOnce();
        expect(h.addSystem).toHaveBeenCalledWith("no active run", { coalesceConsecutive: true });
        expect(h.requestRender).toHaveBeenCalledOnce();
      }
      if (draft !== null) {
        expect(h.dropPendingUser).toHaveBeenCalledWith("run-pending");
      } else {
        expect(h.dropPendingUser).not.toHaveBeenCalled();
      }
    },
  );

  it("drops a queued row that terminalizes while session abort is pending", async () => {
    const abort = createDeferred<{ ok: boolean; aborted: boolean; runIds: string[] }>();
    const abortChat = vi.fn(() => abort.promise);
    const dropPendingUser = vi.fn();
    const state = createBaseState({
      historyLoaded: true,
      activeChatRunId: "run-active",
      pendingSubmit: acceptedSubmit("run-queued", "queued"),
    });
    const { abortActive } = createTestSessionActions({
      client: makeTuiBackend({ describeSession: vi.fn(), abortChat }),
      chatLog: makeChatLog({
        addSystem: vi.fn(),
        clearAll: vi.fn(),
        dropPendingUser,
      }),
      state,
    });

    const pendingAbort = abortActive();
    expect(abortChat).toHaveBeenCalledOnce();
    state.pendingSubmit = null;
    abort.resolve({ ok: true, aborted: true, runIds: ["run-active", "run-queued"] });
    await pendingAbort;

    expect(dropPendingUser).toHaveBeenCalledTimes(1);
    expect(dropPendingUser).toHaveBeenCalledWith("run-queued");
  });

  it.each([true, undefined])(
    "preserves a non-abortable run until the session is idle (hasActiveRun=%s)",
    async (hasActiveRun) => {
      const h = abortHarness(
        {
          activeChatRunId: "run-finalizing",
          pendingSubmit: acceptedSubmit("run-pending"),
          activityStatus: "finishing context",
        },
        false,
      );
      h.loadHistory.mockResolvedValue({ sessionInfo: { hasActiveRun } });

      await h.abortActive();

      expect(h.state.activeChatRunId).toBe("run-finalizing");
      expect(getPendingSubmitAcceptedRunId(h.state)).toBe("run-pending");
      expect(h.invalidateRunOwnership).not.toHaveBeenCalled();
      expect(h.dropPendingUser).not.toHaveBeenCalled();
      expect(h.setActivityStatus).not.toHaveBeenCalled();
      expect(h.addSystem).toHaveBeenCalledWith("run is still active; waiting for completion", {
        coalesceConsecutive: true,
      });
    },
  );

  it("preserves a newer run when an older abort reports no active run", async () => {
    const deferred = createDeferred<Awaited<ReturnType<TuiBackend["abortChat"]>>>();
    const state = createBaseState({ historyLoaded: true, activeChatRunId: "run-old" });
    const invalidateRunOwnership = vi.fn();
    const setActivityStatus = vi.fn();
    const { abortActive } = createTestSessionActions({
      state,
      client: makeTuiBackend({ abortChat: vi.fn(() => deferred.promise) }),
      invalidateRunOwnership,
      setActivityStatus,
    });

    const pendingAbort = abortActive();
    state.activeChatRunId = "run-new";
    deferred.resolve({ ok: true, aborted: false });
    await pendingAbort;

    expect(state.activeChatRunId).toBe("run-new");
    expect(invalidateRunOwnership).not.toHaveBeenCalled();
    expect(setActivityStatus).not.toHaveBeenCalled();
  });

  it.each([
    [
      "successful abort after a session switch",
      "agent:main:first",
      "agent:main:second",
      true,
      false,
    ],
    ["rejected abort after a session switch", "agent:main:first", "agent:main:second", false, true],
    ["successful global abort after an agent switch", "global", "global", true, false],
    [
      "successful abort after the same session is replaced",
      "agent:main:main",
      "agent:main:main",
      true,
      false,
    ],
  ])("ignores a %s", async (_name, initialKey, nextKey, aborted, rejected) => {
    const deferred = createDeferred<Awaited<ReturnType<TuiBackend["abortChat"]>>>();
    const abortChat = vi.fn(() => deferred.promise);
    const loadHistory = vi.fn().mockResolvedValue({
      sessionInfo: {
        key: nextKey,
        sessionId: "second-session",
        model: "current-model",
      },
      messages: [],
    });
    const addSystem = vi.fn();
    const chatLog = makeChatLog({ addSystem });
    const dropPendingUser = vi.fn();
    const setActivityStatus = vi.fn();
    const state = createBaseState({
      historyLoaded: true,
      currentSessionKey: initialKey,
      currentAgentId: "main",
      currentSessionId: "first-session",
      sessionGeneration: 4,
      activeChatRunId: "first-active-run",
      pendingSubmit: acceptedSubmit("first-pending-run"),
    });
    const { abortActive, setSession } = createTestSessionActions({
      client: makeTuiBackend({ describeSession: vi.fn(), loadHistory, abortChat }),
      chatLog: Object.assign(chatLog, { dropPendingUser }),
      state,
      setActivityStatus,
      resolveSessionSelection: vi.fn((raw?: string, agentId?: string) => ({
        key: raw ?? state.currentSessionKey,
        agentId: agentId ?? state.currentAgentId,
      })),
    });

    const pendingAbort = abortActive();
    expect(abortChat).toHaveBeenCalledWith({
      sessionKey: initialKey,
      ...(initialKey === "global" ? { agentId: "main" } : {}),
    });
    if (initialKey === nextKey && initialKey !== "global") {
      state.sessionGeneration = (state.sessionGeneration ?? 0) + 1;
      state.currentSessionId = "second-session";
    } else {
      await setSession(nextKey, initialKey === "global" ? "work" : undefined);
    }
    state.activeChatRunId = "second-active-run";
    state.pendingSubmit = acceptedSubmit("second-pending-run", "second draft");
    addSystem.mockClear();
    setActivityStatus.mockClear();

    if (rejected) {
      deferred.reject(new Error("stale session abort"));
    } else {
      deferred.resolve({
        ok: true,
        aborted,
        runIds: ["first-active-run", "first-pending-run"],
      });
    }
    await pendingAbort;

    expect(state.currentSessionKey).toBe(nextKey);
    expect(state.currentAgentId).toBe(initialKey === "global" ? "work" : "main");
    expect(state.currentSessionId).toBe("second-session");
    expect(state.activeChatRunId).toBe("second-active-run");
    expect(getPendingSubmitAcceptedRunId(state)).toBe("second-pending-run");
    expect(getPendingSubmitDraft(state)).toEqual({
      runId: "second-pending-run",
      text: "second draft",
    });
    expect(dropPendingUser).not.toHaveBeenCalled();
    expect(addSystem).not.toHaveBeenCalled();
    expect(setActivityStatus).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "requires explicit stop during local maintenance (explicit=%s)",
    async (explicit) => {
      const h = abortHarness(
        {
          activeChatRunId: "run-finishing",
          pendingSubmit: null,
          activityStatus: "finishing context",
        },
        true,
        true,
      );
      await h.abortActive(explicit ? { preferActive: true } : undefined);
      if (explicit) {
        expect(h.abortChat).toHaveBeenCalledWith({ sessionKey: "agent:main:main" });
        expect(h.setActivityStatus).toHaveBeenCalledWith("aborted");
      } else {
        expect(h.abortChat).not.toHaveBeenCalled();
        expect(h.addSystem).toHaveBeenCalledWith(
          "agent is finishing context; wait for it to finish before aborting",
        );
        expect(h.requestRender).toHaveBeenCalled();
        expect(h.state.activeChatRunId).toBe("run-finishing");
      }
    },
  );
});
