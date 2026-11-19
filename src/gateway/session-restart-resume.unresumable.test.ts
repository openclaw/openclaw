import { expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import * as registry from "../agents/subagents/registry/subagent-registry.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { ensureGatewayOwnerProfile } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import { settleUnresumableChildren } from "./session-restart-resume-custody.js";
import {
  persistRunningSessionsForRestart,
  resumeMarkedSessions,
} from "./session-restart-resume.js";

const storePath = () => resolveSessionStorePathCore(undefined, { agentId: "main" });

function seedRequester(sessionKey: string, scope?: string) {
  const person = ensureGatewayOwnerProfile("Restart settle owner");
  const entry = {
    sessionId: `${sessionKey}-id`,
    lifecycleRevision: "original-revision",
    updatedAt: 1,
    createdActor: { type: "human" as const, source: "profile" as const, id: person.id },
  };
  replaceSessionEntrySync({ agentId: "main", storePath: storePath(), sessionKey }, entry);
  if (scope) {
    replaceSessionEntrySync(
      { agentId: "main", storePath: storePath(), sessionKey },
      { ...entry, lifecycleRestartScope: scope },
    );
  }
  return entry;
}

function seedStuckChild(runId: string, requesterSessionKey: string) {
  const child = createSubagentRunRecord({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey,
    requesterAgentId: "main",
    requesterStorePath: storePath(),
    expectsCompletionMessage: true,
    spawnMode: "run",
    createdAt: Math.floor(performance.timeOrigin) - 10_000,
    startedAt: Math.floor(performance.timeOrigin) - 9_000,
  });
  subagentRuns.set(child.runId, child);
  subagentRuns.retireCompletionAuthority(child);
  return child;
}

function params() {
  const context = createContext();
  context.resolveGatewayContext = () => context;
  return { context, signal: new AbortController().signal, log: { warn: vi.fn() } };
}

it.each([
  { requester: "same scope", scope: undefined, deliver: true },
  { requester: "another scope", scope: "token-a", deliver: false },
])("ends a stuck child of a requester from $requester (deliver: $deliver)", ({ scope, deliver }) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const requesterKey = "agent:main:dashboard:stuck-requester";
    seedRequester(requesterKey, scope);
    const child = seedStuckChild("stuck-child", requesterKey);
    const custodyAtSettle: boolean[] = [];
    const settle = vi
      .spyOn(registry, "settleRestartInterruptedSubagentRunNow")
      .mockImplementation(async (entry) => {
        custodyAtSettle.push(!subagentRuns.isCompletionAuthorityRetired(entry));
      });
    try {
      const run = params();
      await settleUnresumableChildren(run, [child]);
      expect(run.log.warn).not.toHaveBeenCalled();
      // Custody binds before the row ends, so delivery has a live owner; another
      // scope's requester is never woken and its child ends without delivery.
      expect(settle).toHaveBeenCalledOnce();
      expect(settle).toHaveBeenCalledWith(expect.objectContaining({ runId: child.runId }), deliver);
      expect(custodyAtSettle).toEqual([deliver]);
    } finally {
      settle.mockRestore();
      subagentRuns.delete(child.runId);
    }
  }),
);

it("visits an agent with nothing to resume and settles only its unresumed child", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const requesterKey = "agent:main:dashboard:quiet-requester";
    seedRequester(requesterKey);
    const stuck = seedStuckChild("stuck-child", requesterKey);
    const live = seedStuckChild("live-child", requesterKey);
    const settled: string[] = [];
    const settle = vi
      .spyOn(registry, "settleRestartInterruptedSubagentRunNow")
      .mockImplementation(async (entry) => {
        settled.push(entry.runId);
      });
    const liveness = await import("../agents/subagents/registry/subagent-run-liveness.js");
    const isLive = vi
      .spyOn(liveness, "isSubagentRunLive")
      .mockImplementation((entry) => entry?.runId === live.runId);
    try {
      await resumeMarkedSessions(params());
      await vi.waitFor(() => expect(settled).toEqual([stuck.runId]));
    } finally {
      settle.mockRestore();
      isLive.mockRestore();
      subagentRuns.delete(stuck.runId);
      subagentRuns.delete(live.runId);
    }
  }));

it("keeps the row of a child this boot resumed", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const requesterKey = "agent:main:dashboard:resuming-requester";
    seedRequester(requesterKey);
    const resumed = seedStuckChild("resumed-child", requesterKey);
    const stuck = seedStuckChild("stuck-child", requesterKey);
    // The resumed child's session carries a restart marker from the previous shutdown.
    const target = { agentId: "main", sessionKey: resumed.childSessionKey, sessionId: "resumed" };
    seedRequester(resumed.childSessionKey);
    replaceSessionEntrySync(target, {
      sessionId: target.sessionId,
      updatedAt: Date.now(),
      createdActor: {
        type: "human",
        source: "profile",
        id: ensureGatewayOwnerProfile("Restart settle owner").id,
      },
    });
    await persistGatewaySessionLifecycleEvent({
      sessionKey: target.sessionKey,
      event: {
        runId: "resumed-run",
        sessionId: target.sessionId,
        ts: Date.now(),
        data: { phase: "start", startedAt: Date.now() },
      },
    });
    const claim = claimAgentRunContext("resumed-run", target, {
      trackOwner: true,
      ownsContext: true,
    });
    await persistRunningSessionsForRestart({ cfg });
    releaseAgentRunContext("resumed-run", claim);
    const resume = vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockReturnValue({
      accepted: Promise.resolve({ ok: true }),
      id: "restart-input",
      settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
      cancel: () => false,
    });
    const settled: string[] = [];
    const settle = vi
      .spyOn(registry, "settleRestartInterruptedSubagentRunNow")
      .mockImplementation(async (entry) => {
        settled.push(entry.runId);
      });
    try {
      const run = params();
      run.context.getRuntimeConfig = () => cfg;
      await resumeMarkedSessions(run);
      expect(resume.mock.calls.map(([, options]) => options.sessionKey)).toEqual([
        target.sessionKey,
      ]);
      await vi.waitFor(() => expect(settled).toEqual([stuck.runId]));
      expect(run.log.warn).not.toHaveBeenCalled();
    } finally {
      resume.mockRestore();
      settle.mockRestore();
      subagentRuns.delete(resumed.runId);
      subagentRuns.delete(stuck.runId);
    }
  }));
