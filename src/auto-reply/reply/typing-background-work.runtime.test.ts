import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { copySubagentRunRuntimeOwner } from "../../agents/subagents/registry/subagent-run-generation.js";
import { createReplyBackgroundWorkObserver } from "./typing-background-work.runtime.js";

const owners = vi.hoisted(() => ({
  rows: [] as SubagentRunRecord[],
  liveRunIds: new Set<string>(),
  queuedRunIds: new Set<string>(),
  observations: new Map<string, { state: string; wait?: { kind: string } }>(),
  processes: [] as Array<Record<string, unknown>>,
  registryListeners: new Set<(event: unknown) => void>(),
  processListeners: new Set<(session: unknown) => void>(),
  runListeners: new Map<string, Set<(event: unknown) => void>>(),
}));

// mock-isolation: mutable requester/generation rows are fixture-owned, not the process-wide live/durable registries.
vi.mock("../../agents/subagents/registry/subagent-registry-read.js", () => ({
  listSubagentRunsForRequester: (sessionKey: string, options?: { requesterAgentId?: string }) =>
    owners.rows.filter(
      (entry) =>
        entry.requesterSessionKey === sessionKey &&
        (!options?.requesterAgentId || entry.requesterAgentId === options.requesterAgentId),
    ),
  getLatestLiveSubagentRunByChildSessionKey: (
    childSessionKey: string,
    matches?: (entry: SubagentRunRecord) => boolean,
    childAgentId?: string,
  ) =>
    owners.rows
      .filter(
        (entry) =>
          entry.childSessionKey === childSessionKey &&
          (!childAgentId || entry.childAgentId === childAgentId) &&
          (!matches || matches(entry)),
      )
      .toSorted((left, right) => (right.generation ?? 0) - (left.generation ?? 0))[0] ?? null,
  isSubagentRunLive: (entry: { runId: string }) => owners.liveRunIds.has(entry.runId),
  isSubagentRunQueued: (entry: { runId: string }) => owners.queuedRunIds.has(entry.runId),
}));
// mock-isolation: explicit running/input/child-wait facts must not read unrelated live model controllers.
vi.mock("../../agents/subagents/registry/subagent-execution-observation.js", () => ({
  observeSubagentExecution: (entry: { runId: string }) =>
    owners.observations.get(entry.runId) ?? {
      state: owners.liveRunIds.has(entry.runId) ? "running" : "unknown",
    },
}));
// mock-isolation: fixture listeners must be isolated from global registry persistence/session notifications.
vi.mock("../../agents/subagents/registry/subagent-registry-publication.js", () => ({
  subscribeSubagentRunChanges: (_phase: string, listener: (event: unknown) => void) => {
    owners.registryListeners.add(listener);
    return () => owners.registryListeners.delete(listener);
  },
}));
// mock-isolation: run-scoped fixture events must not subscribe to unrelated live turns in the shared worker.
vi.mock("../../infra/agent-events.js", () => ({
  onAgentEventForRun: (runId: string, listener: (event: unknown) => void) => {
    const listeners = owners.runListeners.get(runId) ?? new Set();
    owners.runListeners.set(runId, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        owners.runListeners.delete(runId);
      }
    };
  },
}));
// mock-isolation: controlled PID/activity rows are separate from OS-managed processes; the real-owner test covers real supervisors.
vi.mock("../../agents/bash-process-registry.js", () => ({
  listActiveBackgroundProcessSessions: () => [...owners.processes],
  subscribeProcessSessionChanges: (listener: (session: unknown) => void) => {
    owners.processListeners.add(listener);
    return () => owners.processListeners.delete(listener);
  },
}));

const REQUESTER = "agent:main:discord:channel:typing";
const PARENT_RUN = "parent-run";

function subagentRun(params: {
  runId: string;
  requesterSessionKey: string;
  requesterTurnRunId: string;
  childSessionKey: string;
  generation?: number;
  yielded?: boolean;
  pauseReason?: string;
}): SubagentRunRecord {
  return {
    runId: params.runId,
    requesterSessionKey: params.requesterSessionKey,
    requesterAgentId: "main",
    requesterTurnRunId: params.requesterTurnRunId,
    requesterTurnYielded: params.yielded === false ? undefined : true,
    expectsCompletionMessage: true,
    childSessionKey: params.childSessionKey,
    childAgentId: "main",
    generation: params.generation ?? 1,
    createdAt: params.generation ?? 1,
    pauseReason: params.pauseReason,
    execution: { status: "running", startedAt: 1 },
  } as unknown as SubagentRunRecord;
}

function notifyRegistry() {
  for (const listener of owners.registryListeners) {
    listener({});
  }
}

function notifyRun(runId: string, stream: string, phase: string) {
  for (const listener of owners.runListeners.get(runId) ?? []) {
    listener({ runId, stream, data: { phase } });
  }
}

const observers: Array<ReturnType<typeof createReplyBackgroundWorkObserver>> = [];
function observe(onChange = vi.fn()) {
  const observer = createReplyBackgroundWorkObserver({
    sessionKey: REQUESTER,
    runId: PARENT_RUN,
    onChange,
  });
  observers.push(observer);
  return { observer, onChange };
}

beforeEach(() => {
  owners.rows.length = 0;
  owners.liveRunIds.clear();
  owners.queuedRunIds.clear();
  owners.observations.clear();
  owners.processes.length = 0;
  owners.registryListeners.clear();
  owners.processListeners.clear();
  owners.runListeners.clear();
});

afterEach(() => {
  for (const observer of observers.splice(0)) {
    observer.dispose();
  }
  expect(owners.registryListeners.size).toBe(0);
  expect(owners.processListeners.size).toBe(0);
  expect(owners.runListeners.size).toBe(0);
});

describe("reply background work attribution", () => {
  it("keeps multiple children active until every exact owner is terminal", () => {
    const children = ["first-child", "second-child"].map((runId) =>
      subagentRun({
        runId,
        requesterSessionKey: REQUESTER,
        requesterTurnRunId: PARENT_RUN,
        childSessionKey: "agent:main:subagent:" + runId,
      }),
    );
    owners.rows.push(...children);
    for (const child of children) {
      owners.liveRunIds.add(child.runId);
    }
    const { observer } = observe();
    expect(observer.currentState()).toBe("active");
    owners.liveRunIds.delete(children[0]!.runId);
    notifyRun(children[0]!.runId, "lifecycle", "end");
    expect(observer.currentState()).toBe("active");
    owners.liveRunIds.delete(children[1]!.runId);
    notifyRun(children[1]!.runId, "lifecycle", "end");
    expect(observer.currentState()).toBe("none");
  });

  it("follows a yielded child to its currently executing grandchild", () => {
    const child = subagentRun({
      runId: "child-run",
      requesterSessionKey: REQUESTER,
      requesterTurnRunId: PARENT_RUN,
      childSessionKey: "agent:main:subagent:child",
      pauseReason: "sessions_yield",
    });
    const grandchild = subagentRun({
      runId: "grandchild-run",
      requesterSessionKey: child.childSessionKey,
      requesterTurnRunId: child.runId,
      childSessionKey: "agent:main:subagent:grandchild",
    });
    owners.rows.push(child, grandchild);
    owners.liveRunIds.add(grandchild.runId);
    owners.observations.set(child.runId, { state: "waiting", wait: { kind: "children" } });
    owners.observations.set(grandchild.runId, { state: "running" });

    const { observer, onChange } = observe();

    expect(observer.currentState()).toBe("active");
    expect(onChange).toHaveBeenLastCalledWith("active");
    expect(owners.runListeners.has(grandchild.runId)).toBe(true);
  });

  it("follows a recorded child through its public yielded-settle wake", () => {
    const child = subagentRun({
      runId: "transferred-child",
      requesterSessionKey: REQUESTER,
      requesterTurnRunId: PARENT_RUN,
      childSessionKey: "agent:main:subagent:transferred",
      yielded: false,
    });
    owners.rows.push(child);
    owners.liveRunIds.add(child.runId);
    owners.observations.set(child.runId, { state: "running" });

    const { observer, onChange } = observe();
    expect(observer.currentState()).toBe("none");

    const transferred = copySubagentRunRuntimeOwner(child, {
      ...child,
      requesterTurnRunId: undefined,
      requesterTurnYielded: undefined,
      requesterSettleWake: {
        status: "pending" as const,
        attemptCount: 0,
        batchRunIds: [child.runId],
        requesterYieldBatch: true as const,
        yieldedFinalDeliverable: true as const,
        rearmGeneration: 1,
      },
    } as unknown as SubagentRunRecord);
    owners.rows[0] = transferred;
    notifyRegistry();

    expect(observer.currentState()).toBe("active");
    expect(onChange).toHaveBeenLastCalledWith("active");

    const rearmed = copySubagentRunRuntimeOwner(transferred, {
      ...transferred,
      requesterSettleWake: {
        ...transferred.requesterSettleWake!,
        rearmGeneration: 2,
      },
    } as unknown as SubagentRunRecord);
    owners.rows[0] = rearmed;
    notifyRegistry();

    expect(observer.currentState()).toBe("none");
    expect(onChange).toHaveBeenLastCalledWith("none");
  });

  it("does not infer requester lineage from a wake-only row", () => {
    const child = {
      ...subagentRun({
        runId: "wake-only-child",
        requesterSessionKey: REQUESTER,
        requesterTurnRunId: PARENT_RUN,
        childSessionKey: "agent:main:subagent:wake-only",
        yielded: false,
      }),
      requesterTurnRunId: undefined,
      requesterTurnYielded: undefined,
      requesterSettleWake: {
        status: "pending" as const,
        attemptCount: 0,
        batchRunIds: ["wake-only-child"],
        requesterYieldBatch: true as const,
        yieldedFinalDeliverable: true as const,
        rearmGeneration: 1,
      },
    } as unknown as SubagentRunRecord;
    owners.rows.push(child);
    owners.liveRunIds.add(child.runId);
    owners.observations.set(child.runId, { state: "running" });

    const { observer, onChange } = observe();

    expect(observer.currentState()).toBe("none");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps a waiting approval non-typing and resumes only on an active execution event", () => {
    const child = subagentRun({
      runId: "child-run",
      requesterSessionKey: REQUESTER,
      requesterTurnRunId: PARENT_RUN,
      childSessionKey: "agent:main:subagent:child",
    });
    owners.rows.push(child);
    owners.liveRunIds.add(child.runId);
    owners.observations.set(child.runId, { state: "waiting", wait: { kind: "approval" } });

    const { observer, onChange } = observe();

    expect(observer.currentState()).toBe("waiting");
    expect(onChange).toHaveBeenLastCalledWith("waiting");
    owners.observations.set(child.runId, { state: "running" });
    notifyRun(child.runId, "execution", "running");
    expect(observer.currentState()).toBe("active");

    owners.liveRunIds.delete(child.runId);
    notifyRun(child.runId, "lifecycle", "end");
    expect(observer.currentState()).toBe("none");
  });

  it("rejects unrelated requester runs, sessions, and superseded child generations", () => {
    const wrongTurn = subagentRun({
      runId: "wrong-turn",
      requesterSessionKey: REQUESTER,
      requesterTurnRunId: "another-parent-run",
      childSessionKey: "agent:main:subagent:other",
    });
    const wrongSession = subagentRun({
      runId: "wrong-session",
      requesterSessionKey: "agent:main:discord:channel:other",
      requesterTurnRunId: PARENT_RUN,
      childSessionKey: "agent:main:subagent:unrelated",
    });
    const old = subagentRun({
      runId: "stale-child",
      requesterSessionKey: REQUESTER,
      requesterTurnRunId: PARENT_RUN,
      childSessionKey: "agent:main:subagent:replaced",
      generation: 1,
    });
    const replacement = subagentRun({
      runId: "replacement-child",
      requesterSessionKey: "agent:main:discord:channel:other",
      requesterTurnRunId: "another-parent-run",
      childSessionKey: old.childSessionKey,
      generation: 2,
    });
    owners.rows.push(wrongTurn, wrongSession, old, replacement);
    owners.liveRunIds.add(wrongTurn.runId);
    owners.liveRunIds.add(wrongSession.runId);
    owners.liveRunIds.add(old.runId);
    owners.liveRunIds.add(replacement.runId);

    const { observer, onChange } = observe();

    expect(observer.currentState()).toBe("none");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("fails closed for unknown owners and treats queued work as waiting", () => {
    const unknown = subagentRun({
      runId: "unknown-run",
      requesterSessionKey: REQUESTER,
      requesterTurnRunId: PARENT_RUN,
      childSessionKey: "agent:main:subagent:unknown",
    });
    owners.rows.push(unknown);
    owners.liveRunIds.add(unknown.runId);
    owners.observations.set(unknown.runId, { state: "unknown" });

    const { observer, onChange } = observe();
    expect(observer.currentState()).toBe("none");
    expect(onChange).not.toHaveBeenCalled();

    const queued = subagentRun({
      runId: "queued-run",
      requesterSessionKey: REQUESTER,
      requesterTurnRunId: PARENT_RUN,
      childSessionKey: "agent:main:subagent:queued",
    });
    owners.rows.push(queued);
    owners.queuedRunIds.add(queued.runId);
    notifyRegistry();

    expect(observer.currentState()).toBe("waiting");
    expect(onChange).toHaveBeenLastCalledWith("waiting");
  });

  it("continues the original live owner when another same-session request begins", () => {
    const child = subagentRun({
      runId: "old-child",
      requesterSessionKey: REQUESTER,
      requesterTurnRunId: PARENT_RUN,
      childSessionKey: "agent:main:subagent:old-child",
    });
    const newTurnChild = subagentRun({
      runId: "new-turn-child",
      requesterSessionKey: REQUESTER,
      requesterTurnRunId: "new-parent-run",
      childSessionKey: "agent:main:subagent:new-child",
    });
    owners.rows.push(child, newTurnChild);
    owners.liveRunIds.add(child.runId);
    owners.liveRunIds.add(newTurnChild.runId);

    const { observer, onChange } = observe();
    expect(observer.currentState()).toBe("active");

    notifyRun("new-parent-run", "lifecycle", "start");
    notifyRegistry();

    expect(observer.currentState()).toBe("active");
    expect(onChange).toHaveBeenLastCalledWith("active");
  });

  it("keeps an exact active background process owner with its managed stdin handle", () => {
    const session: {
      id: string;
      agentRunId: string;
      sessionKey: string;
      scopeKey: string;
      backgrounded: boolean;
      startedAt: number;
      pid: number;
      stdin: Record<string, unknown>;
      processActivity: { resultSettled: boolean; lastOutputAtMs: number };
    } = {
      id: "exec-session",
      agentRunId: PARENT_RUN,
      sessionKey: REQUESTER,
      scopeKey: REQUESTER,
      backgrounded: true,
      startedAt: 1,
      pid: 42,
      // exec-runtime assigns managed stdin even when nobody is waiting for input.
      stdin: {},
      processActivity: { resultSettled: false, lastOutputAtMs: 1 },
    };
    const { observer } = observe();
    expect(observer.currentState()).toBe("none");
    owners.processes.push(session as unknown as Record<string, unknown>);
    for (const listener of owners.processListeners) {
      listener(session);
    }
    expect(observer.currentState()).toBe("active");

    const invalidOwners = [
      { ...session, agentRunId: "another-run" },
      { ...session, sessionKey: "agent:main:discord:channel:other" },
      { ...session, scopeKey: "agent:main:discord:channel:other" },
      { ...session, backgrounded: false },
      { ...session, startedAt: Date.now() + 1_000 },
      { ...session, pid: 0 },
      { ...session, cancellationRequested: true },
      { ...session, finalizing: true },
      { ...session, terminalStatus: "killed" },
      { ...session, processActivity: { ...session.processActivity, resultSettled: true } },
    ];
    for (const invalid of invalidOwners) {
      owners.processes[0] = invalid as unknown as Record<string, unknown>;
      expect(observer.currentState()).toBe("none");
      owners.processes[0] = session as unknown as Record<string, unknown>;
      expect(observer.currentState()).toBe("active");
    }
  });
});
