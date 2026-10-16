import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { TuiBackend } from "./tui-backend.js";
import {
  createBaseState,
  createTestSessionActions,
  makeChatLog,
  makeTui,
  makeTuiBackend,
} from "./tui-session-actions-test-support.js";
import type { TuiPendingSubmit } from "./tui-submit-state.js";

const acceptedSubmit = (runId: string, draftText: string | null = "pending"): TuiPendingSubmit => ({
  phase: "accepted",
  runId,
  draftText,
});

function abortHarness({
  aborted = true,
  local = false,
  ...overrides
}: Parameters<typeof createBaseState>[0] & { aborted?: boolean; local?: boolean }) {
  const backend = {
    abortChat: vi.fn<TuiBackend["abortChat"]>().mockResolvedValue({ ok: true, aborted }),
    loadHistory: vi
      .fn<TuiBackend["loadHistory"]>()
      .mockResolvedValue({ sessionInfo: { hasActiveRun: false } }),
  };
  const chatLog = { addSystem: vi.fn(), clearAll: vi.fn(), dropPendingUser: vi.fn() };
  const tui = { requestRender: vi.fn() };
  const effects = {
    setActivityStatus: vi.fn(),
    invalidateRunOwnership: vi.fn(),
  };
  const state = createBaseState({ historyLoaded: true, ...overrides });
  const actions = createTestSessionActions({
    client: makeTuiBackend({ describeSession: vi.fn(), ...backend }),
    chatLog: makeChatLog(chatLog),
    tui: makeTui(tui),
    opts: { local },
    state,
    ...effects,
    resolveSessionSelection: (raw = state.currentSessionKey, agentId = state.currentAgentId) => ({
      key: raw,
      agentId,
    }),
  });
  return { ...actions, ...backend, ...chatLog, ...tui, ...effects, state };
}

it.each([
  ["registered pending run", null, null, false, true],
  ["optimistic pending run", "hello", null, false, true],
  ["selected global run", null, null, true, true],
  ["queued gateway run", null, "run-active", false, true],
  ["missing backend run", "hello", null, false, false],
  ["completed active run", null, "run-active", false, false],
] as const)(
  "reconciles %s after a session-scoped abort",
  async (_name, draft, active, global, aborted) => {
    const sessionKey = global ? "global" : "agent:main:main";
    const h = abortHarness({
      ...(global ? { currentSessionKey: sessionKey, currentAgentId: "work" } : {}),
      activeChatRunId: active,
      pendingSubmit: acceptedSubmit("run-pending", draft),
      aborted,
    });
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
  const h = abortHarness({
    activeChatRunId: "run-active",
    pendingSubmit: acceptedSubmit("run-queued", "queued"),
  });
  h.abortChat.mockImplementation(() => abort.promise);

  const pendingAbort = h.abortActive();
  expect(h.abortChat).toHaveBeenCalledOnce();
  h.state.pendingSubmit = null;
  abort.resolve({ ok: true, aborted: true, runIds: ["run-active", "run-queued"] });
  await pendingAbort;

  expect(h.dropPendingUser).toHaveBeenCalledExactlyOnceWith("run-queued");
});

it.each([true, undefined])(
  "preserves a non-abortable run until the session is idle (hasActiveRun=%s)",
  async (hasActiveRun) => {
    const h = abortHarness({
      activeChatRunId: "run-finalizing",
      pendingSubmit: acceptedSubmit("run-pending"),
      aborted: false,
    });
    h.loadHistory.mockResolvedValue({ sessionInfo: { hasActiveRun } });

    await h.abortActive();

    expect(h.state).toMatchObject({
      activeChatRunId: "run-finalizing",
      pendingSubmit: acceptedSubmit("run-pending"),
    });
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
  const h = abortHarness({ activeChatRunId: "run-old" });
  h.abortChat.mockImplementation(() => deferred.promise);
  h.loadHistory.mockResolvedValue({ messages: [] });

  const pendingAbort = h.abortActive();
  h.state.activeChatRunId = "run-new";
  deferred.resolve({ ok: true, aborted: false });
  await pendingAbort;

  expect(h.state.activeChatRunId).toBe("run-new");
  expect(h.invalidateRunOwnership).not.toHaveBeenCalled();
  expect(h.setActivityStatus).not.toHaveBeenCalled();
});

it.each([
  ["successful session switch", "agent:main:first", "agent:main:second", true, false],
  ["rejected session switch", "agent:main:first", "agent:main:second", false, true],
  ["successful global agent switch", "global", "global", true, false],
  ["successful same-session replacement", "agent:main:main", "agent:main:main", true, false],
])("ignores a %s", async (_name, initialKey, nextKey, aborted, rejected) => {
  const deferred = createDeferred<Awaited<ReturnType<TuiBackend["abortChat"]>>>();
  const h = abortHarness({
    currentSessionKey: initialKey,
    currentSessionId: "first-session",
    activeChatRunId: "first-active-run",
    pendingSubmit: acceptedSubmit("first-pending-run"),
  });
  h.abortChat.mockImplementation(() => deferred.promise);
  h.loadHistory.mockResolvedValue({
    sessionInfo: { key: nextKey, sessionId: "second-session" },
    messages: [],
  });
  const pendingAbort = h.abortActive();
  expect(h.abortChat).toHaveBeenCalledWith({
    sessionKey: initialKey,
    ...(initialKey === "global" ? { agentId: "main" } : {}),
  });
  if (initialKey === nextKey && initialKey !== "global") {
    h.state.sessionGeneration = (h.state.sessionGeneration ?? 0) + 1;
    h.state.currentSessionId = "second-session";
  } else {
    await h.setSession(nextKey, initialKey === "global" ? "work" : undefined);
  }
  h.state.activeChatRunId = "second-active-run";
  h.state.pendingSubmit = acceptedSubmit("second-pending-run", "second draft");
  h.addSystem.mockClear();
  h.setActivityStatus.mockClear();

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

  expect(h.state).toMatchObject({
    currentSessionKey: nextKey,
    currentAgentId: initialKey === "global" ? "work" : "main",
    currentSessionId: "second-session",
    activeChatRunId: "second-active-run",
    pendingSubmit: acceptedSubmit("second-pending-run", "second draft"),
  });
  expect(h.dropPendingUser).not.toHaveBeenCalled();
  expect(h.addSystem).not.toHaveBeenCalled();
  expect(h.setActivityStatus).not.toHaveBeenCalled();
});

it.each([false, true])(
  "requires explicit stop during local maintenance (explicit=%s)",
  async (explicit) => {
    const h = abortHarness({
      activeChatRunId: "run-finishing",
      activityStatus: "finishing context",
      local: true,
    });
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
