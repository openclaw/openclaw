import { expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { createLifecycleControllerFixture } from "../agents/subagents/registry/subagent-registry-lifecycle-controller.test-support.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { saveSubagentRegistryChangesToSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { settleRestartInterruptedSubagentRun } from "../agents/subagents/registry/subagent-registry-sweep-settle.js";
import { observeRootWork } from "../agents/subagents/registry/subagent-registry.browser-cleanup.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { ensureGatewayOwnerProfile } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { prepareRestartCompletionCustody } from "./session-restart-resume-custody.js";
import { prepareRestartStores } from "./session-restart-resume-discovery.js";

it("delivers a restored interrupted child's owed notice after its requester settled", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const target = {
      agentId: "main",
      physicalAgentId: "main",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    };
    const sessionKey = "agent:main:dashboard:settled-requester";
    const entry = {
      sessionId: "settled-requester",
      lifecycleRevision: "original-revision",
      updatedAt: 1,
    };
    replaceSessionEntrySync({ ...target, sessionKey }, entry);
    const child = createSubagentRunRecord({
      runId: "owed-completion",
      childSessionKey: "agent:main:subagent:finished-child",
      requesterSessionKey: sessionKey,
      requesterAgentId: "main",
      requesterStorePath: target.storePath,
      completionRequesterSessionId: entry.sessionId,
      completionRequesterLifecycleRevision: entry.lifecycleRevision,
      expectsCompletionMessage: true,
      spawnMode: "session",
      completionTarget: "parent",
      createdAt: Math.floor(performance.timeOrigin) - 10_000,
      startedAt: Math.floor(performance.timeOrigin) - 9_000,
    });
    subagentRuns.set(child.runId, child);
    subagentRuns.retireExecution(child);
    try {
      const params = {
        context: createContext(),
        signal: new AbortController().signal,
        log: { warn: vi.fn() },
      };
      params.context.resolveGatewayContext = () => params.context;
      const received: string[] = [];
      const controller = createLifecycleControllerFixture(
        {
          entry: child,
          runs: subagentRuns,
          realWorker: true,
          runSubagentAnnounceFlow: async (notice) => {
            if (notice.outcome?.status !== "error") {
              throw new Error("Missing interrupted outcome");
            }
            received.push(notice.outcome.error!);
            return "delivered";
          },
        },
        {
          callGateway: vi.fn(),
          cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
          ownersByEntry: new Map(),
        },
      );
      saveSubagentRegistryChangesToSqlite(subagentRuns, [child.runId]);
      const settle = async () => {
        const drain = observeRootWork();
        try {
          return await settleRestartInterruptedSubagentRun({
            runId: child.runId,
            entry: subagentRuns.get(child.runId)!,
            complete: controller.completeSubagentRun,
            now: Date.now(),
          });
        } finally {
          await drain();
        }
      };
      expect(await settle()).toBe(false);
      expect(received).toEqual([]);
      const stores = await prepareRestartStores(params, [target]);
      expect(stores?.[0]?.entries.map((row) => row.sessionKey)).toContain(sessionKey);
      const recovery = await prepareRestartCompletionCustody(params, stores![0]!);
      expect(subagentRuns.isExecutionRetired(child)).toBe(true);
      await recovery.resume();
      expect(subagentRuns.isExecutionRetired(child)).toBe(false);
      expect(params.log.warn).not.toHaveBeenCalled();
      await settle();
      expect(received).toEqual([
        "The Gateway stopped before this subagent finished. Its run did not survive the restart; inspect its saved work before retrying.",
      ]);
      expect(subagentRuns.get(child.runId)?.delivery?.status).toBe("delivered");
    } finally {
      subagentRuns.delete(child.runId);
    }
  }));

it.for([
  { change: "archived", phase: "prepare" },
  { change: "replaced", phase: "prepare" },
  { change: "reset", phase: "prepare" },
  { change: "archived", phase: "resume" },
  { change: "replaced", phase: "resume" },
  { change: "reset", phase: "resume" },
  { change: "execution-replaced", phase: "resume" },
] as const)(
  "does not reactivate a recovered execution after $change during $phase",
  ({ change, phase }) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const person = ensureGatewayOwnerProfile("Restart recovery owner");
      const target = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:retired-requester",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      const entry: InternalSessionEntry = {
        sessionId: "original-requester",
        lifecycleRevision: "original-revision",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: person.id },
      };
      replaceSessionEntrySync(target, entry);
      const child = createSubagentRunRecord({
        runId: "retained-child-completion",
        childSessionKey: "agent:main:dashboard:retained-child",
        requesterSessionKey: target.sessionKey,
        requesterAgentId: target.agentId,
        requesterStorePath: target.storePath,
        completionRequesterSessionId: entry.sessionId,
        completionRequesterLifecycleRevision: entry.lifecycleRevision,
        expectsCompletionMessage: true,
        spawnMode: "session",
        completionTarget: "parent",
        endedAt: 1,
        delivery: { status: "pending" },
      });
      subagentRuns.set(child.runId, child);
      subagentRuns.retireExecution(child);
      const invalidate = () => {
        if (change === "execution-replaced") {
          const replacement = createSubagentRunRecord({
            ...child,
            generation: (child.generation ?? 0) + 1,
          });
          subagentRuns.set(child.runId, replacement);
          subagentRuns.retireExecution(replacement);
        } else {
          replaceSessionEntrySync(target, {
            ...entry,
            ...(change === "archived"
              ? { archivedAt: 2 }
              : change === "replaced"
                ? { sessionId: "replacement-requester" }
                : { lifecycleRevision: "reset-revision" }),
          });
        }
      };
      try {
        const warn = vi.fn();
        if (phase === "prepare") {
          invalidate();
        }
        const recovery = await prepareRestartCompletionCustody(
          {
            context: createContext(),
            signal: new AbortController().signal,
            log: { warn },
          },
          {
            target: { ...target, physicalAgentId: target.agentId },
            entries: [{ sessionKey: target.sessionKey, entry }],
          },
        );
        if (phase === "resume") {
          invalidate();
        }
        await recovery.resume();
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("Restart completion recovery failed"),
        );
        expect(subagentRuns.isExecutionRetired(child)).toBe(true);
        expect(subagentRuns.isExecutionRetired(subagentRuns.get(child.runId)!)).toBe(true);
      } finally {
        subagentRuns.delete(child.runId);
      }
    }),
);

// A completion wake starts parent work, so only the scope the requester's work belongs to may
// recover it: its shutdown marker's scope, else the scope its latest run started under.
it.for([
  { stored: "token-a", marker: undefined, startup: "token-a", recovers: true },
  { stored: "token-a", marker: undefined, startup: "token-b", recovers: false },
  { stored: undefined, marker: undefined, startup: "token-b", recovers: false },
  { stored: "token-b", marker: "token-a", startup: "token-b", recovers: false },
  { stored: undefined, marker: undefined, startup: undefined, recovers: true },
] as const)(
  "reactivates completion work from scope $marker/$stored only at startup scope $startup",
  ({ stored, marker, startup, recovers }) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const person = ensureGatewayOwnerProfile("Restart recovery owner");
      const target = {
        agentId: "main",
        physicalAgentId: "main",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      const sessionKey = "agent:main:dashboard:scoped-requester";
      const entry: InternalSessionEntry = {
        sessionId: "scoped-requester",
        lifecycleRevision: "original-revision",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: person.id },
      };
      replaceSessionEntrySync({ ...target, sessionKey }, entry);
      // Private restart evidence belongs to an existing incarnation.
      replaceSessionEntrySync(
        { ...target, sessionKey },
        {
          ...entry,
          ...(stored ? { lifecycleRestartScope: stored } : {}),
          ...(marker ? { resumeAfterRestart: { scope: marker } } : {}),
        },
      );
      const child = createSubagentRunRecord({
        runId: "scoped-completion",
        childSessionKey: "agent:main:subagent:scoped-child",
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        requesterStorePath: target.storePath,
        completionRequesterSessionId: entry.sessionId,
        completionRequesterLifecycleRevision: entry.lifecycleRevision,
        expectsCompletionMessage: true,
        spawnMode: "session",
        completionTarget: "parent",
        delivery: { status: "pending" },
      });
      subagentRuns.set(child.runId, child);
      subagentRuns.retireExecution(child);
      vi.stubEnv("OPENCLAW_GATEWAY_RESTART_RESUME_SCOPE", startup);
      try {
        const params = {
          context: createContext(),
          signal: new AbortController().signal,
          log: { warn: vi.fn() },
        };
        params.context.resolveGatewayContext = () => params.context;
        const stores = await prepareRestartStores(params, [target]);
        expect(stores?.[0]?.entries.map((row) => row.entry.lifecycleRestartScope)).toEqual([
          stored,
        ]);
        const recovery = await prepareRestartCompletionCustody(params, stores![0]!);
        expect(subagentRuns.isExecutionRetired(child)).toBe(true);
        await recovery.resume();
        expect(params.log.warn).not.toHaveBeenCalled();
        expect(subagentRuns.isExecutionRetired(child)).toBe(!recovers);
      } finally {
        subagentRuns.delete(child.runId);
      }
    }),
);
