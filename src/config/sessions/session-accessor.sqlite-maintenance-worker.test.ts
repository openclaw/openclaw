import { AsyncLocalStorage } from "node:async_hooks";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  beginSessionEffect,
  runSessionMutation,
} from "../../sessions/session-controller.lifecycle.js";
import {
  onSessionIdentityMutation,
  type SessionIdentityMutation,
} from "../../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { drainSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import { loadSessionEntry, replaceSessionEntrySync } from "./session-accessor.js";
import type { SqliteSessionReclamationDiagnostics } from "./session-accessor.sqlite-contract.js";
import { patchSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import type {
  SessionEntryMaintenancePlan,
  SessionEntryMaintenanceResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { observeSessionMaintenanceCompletion } from "./session-accessor.sqlite-maintenance-completion.test-support.js";
import * as maintenanceKick from "./session-accessor.sqlite-maintenance-kick.js";
import { registerSessionMaintenancePreparationTests } from "./session-accessor.sqlite-maintenance-preparation.test-support.js";
import { registerSessionMaintenanceProtectionTests } from "./session-accessor.sqlite-maintenance-protection.test-support.js";
import {
  maintenanceFixture,
  maintenancePolicy,
  observeSessionMaintenancePlanningWorker,
} from "./session-accessor.sqlite-maintenance.test-support.js";
import * as reclamationRun from "./session-accessor.sqlite-reclamation-run.js";
import * as reclamation from "./session-accessor.sqlite-reclamation.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { registerSessionMaintenancePreserveKeysProvider } from "./store-maintenance-preserve.js";

afterEach(() => vi.restoreAllMocks());

function withMaintenanceFixture(
  run: (fixture: ReturnType<typeof maintenanceFixture>) => Promise<void>,
) {
  return withOpenClawTestState({ scenario: "minimal" }, (state) => run(maintenanceFixture(state)));
}

function observeMaintenance(
  accept: (result: SessionEntryMaintenancePlan | SessionEntryMaintenanceResult) => boolean = () =>
    true,
) {
  return observeSessionMaintenanceCompletion(resolveOpenClawAgentSqlitePath({ agentId: "main" }), {
    accept,
  });
}

async function maintain(
  target: Parameters<typeof patchSessionEntryCore>[0],
  label: string,
  maintenanceConfig: NonNullable<Parameters<typeof patchSessionEntryCore>[2]>["maintenanceConfig"],
  options: NonNullable<Parameters<typeof patchSessionEntryCore>[2]> = {},
  accept?: Parameters<typeof observeMaintenance>[0],
) {
  const completed = observeMaintenance(accept);
  await patchSessionEntryCore(target, () => ({ label }), { maintenanceConfig, ...options });
  return completed;
}

it.for(["cold", "warm-cap", "removal"] as const)(
  "runs automatic maintenance row planning off-thread (%s)",
  async (scenario, { signal }) => {
    const remove = scenario === "removal" || scenario === "warm-cap";
    await withMaintenanceFixture(async ({ state, scope, seed }) => {
      const active = seed("agent:main:maintenance-worker-active", "active");
      const stale = scope("agent:main:subagent:maintenance-worker-stale");
      const locked = scope("agent:main:maintenance-worker-locked");
      const protectedEntry = scope("agent:main:maintenance-worker-protected");
      const staleEvent = { type: "session", id: "stale", content: "synthetic maintenance archive" };
      const seedStale = (updatedAt: number) => {
        replaceSessionEntrySync(stale, { sessionId: "stale", updatedAt });
        replaceTranscriptEventsSync({ ...stale, sessionId: "stale" }, [staleEvent]);
      };
      if (scenario === "removal") {
        seedStale(1);
      }
      const policy = maintenancePolicy("1h", { maxEntries: scenario === "warm-cap" ? 3 : 100 });
      if (scenario === "warm-cap") {
        await maintain(active, "warm", policy, { workerGuard: {} });
        vi.restoreAllMocks();
      }
      if (scenario === "warm-cap") {
        seed(locked.sessionKey, "locked", Date.now() - 3, { modelSelectionLocked: true });
        seed(protectedEntry.sessionKey, "protected", Date.now() - 2);
        seedStale(Date.now() - 1);
      }
      const planningPhases: string[] = [];
      const workerThreadIds: number[] = [];
      const writeOutcomes: { kind: "committed" | "not-committed"; admitted: boolean }[] = [];
      let writeAdmitted = false;
      let foregroundProgressed = false;
      observeSessionMaintenancePlanningWorker({
        async afterPrepare() {
          planningPhases.push("prepared");
          if (scenario === "warm-cap" && !foregroundProgressed) {
            // A foreground writer must finish while automatic preparation remains held.
            await racePromiseWithAbortSignal(
              patchSessionEntryCore(active, () => ({ label: "foreground progressed" }), {
                skipMaintenance: true,
                workerGuard: {},
              }),
              signal,
            );
            foregroundProgressed = true;
          }
        },
        beforeExecute: () => planningPhases.push("planning"),
        beforeAdmission: (request) => {
          writeAdmitted ||= request.stage === "transaction";
        },
        afterExecute: (result) => {
          workerThreadIds.push(result.workerThreadId);
          writeOutcomes.push({ kind: result.kind, admitted: writeAdmitted });
        },
      });
      const completed = observeMaintenance();
      const observation = new AsyncLocalStorage<boolean>();
      const kick = maintenanceKick.kickSessionEntryMaintenanceAfterWrite;
      vi.spyOn(maintenanceKick, "kickSessionEntryMaintenanceAfterWrite").mockImplementation(
        (request) => observation.run(true, () => kick(request)),
      );
      const parentSql: string[] = [];
      const sql = observeHostDataSql((query) => {
        if (observation.getStore()) {
          parentSql.push(query);
        }
      });
      const unregister = registerSessionMaintenancePreserveKeysProvider(async () => ({
        capture: () => (scenario === "warm-cap" ? [protectedEntry.sessionKey] : []),
        dispose() {},
      }));
      const result = await (async () => {
        try {
          await patchSessionEntryCore(active, () => ({ label: "updated" }), {
            maintenanceConfig: policy,
            workerGuard: {},
          });
          return await racePromiseWithAbortSignal(completed, signal);
        } finally {
          unregister();
          sql.restore();
        }
      })();
      expect(
        parentSql.filter((query) =>
          /(?:from|update|into) "(?:session_nodes|session_transcript_archives)"/iu.test(query),
        ),
      ).toEqual([]);
      if (!remove) {
        expect(parentSql).toEqual([]);
      }
      expect(planningPhases).toEqual(["prepared", "planning"]);
      expect(workerThreadIds[0]).toBeGreaterThan(0);
      expect(writeOutcomes).toEqual([
        { kind: remove ? "committed" : "not-committed", admitted: remove },
      ]);
      const expectedLabel = scenario === "warm-cap" ? "foreground progressed" : "updated";
      expect(loadSessionEntry(active)?.label).toBe(expectedLabel);
      if (scenario === "warm-cap") {
        expect(foregroundProgressed).toBe(true);
        expect(loadSessionEntry(locked)?.sessionId).toBe("locked");
        expect(loadSessionEntry(protectedEntry)?.sessionId).toBe("protected");
      }
      if (remove) {
        if (!("archivedTranscripts" in result)) {
          throw new Error("Session removals did not complete maintenance finalization");
        }
        expect(scenario === "warm-cap" ? result.capped : result.pruned).toBe(1);
        expect(loadSessionEntry(stale)).toBeUndefined();
        expect(result.archivedTranscripts).toHaveLength(1);
        expect(
          readSessionArchiveContentSync(result.archivedTranscripts[0]!.archivedPath)
            .trim()
            .split("\n"),
        ).toEqual([JSON.stringify(staleEvent)]);
      }
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
      expect(loadSessionEntry(active)?.label).toBe(expectedLabel);
      if (remove) {
        expect(loadSessionEntry(stale)).toBeUndefined();
      }
    });
  },
);

describe("automatic worker planning protections", () => {
  let state: OpenClawTestState;

  beforeAll(async () => {
    state = await createOpenClawTestState({ scenario: "minimal" });
  });

  afterEach(async () => {
    await drainSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
  });

  afterAll(async () => {
    await state.cleanup();
  });

  it.each([
    "registry",
    "recovery-cycle",
    "recovery-run",
    "provider",
    "work-key",
    "work-id",
    "lifecycle-key",
    "lifecycle-id",
    "ancestor",
  ] as const)("preserves %s protection through automatic worker planning", async (protection) => {
    const { storePath, seed, scope } = maintenanceFixture(state);
    const active = seed(
      `agent:main:maintenance-protection-active-${protection}`,
      `active-${protection}`,
    );
    const protectedKey = protection.startsWith("recovery")
      ? `agent:main:hook:maintenance-protected-${protection}`
      : `agent:main:subagent:maintenance-protected-${protection}`;
    const protectedId = `maintenance-protected-id-${protection}`;
    const aliasKey = `agent:main:subagent:maintenance-protected-alias-${protection}`;
    const sibling = `agent:main:subagent:maintenance-unprotected-${protection}`;
    const recovery = (
      terminal: boolean,
    ): Partial<Parameters<typeof replaceSessionEntrySync>[1]> => {
      if (protection === "recovery-cycle") {
        return {
          mainRestartRecovery: {
            cycleId: terminal ? "finished" : "waiting",
            revision: 1,
            chargedAttempts: 0,
            ...(terminal ? { tombstone: { reason: "exhausted" } } : {}),
          },
        };
      }
      const runId = terminal ? "terminal" : "awaiting-recovery";
      return protection === "recovery-run"
        ? {
            restartRecoveryRuns: [{ runId, lifecycleGeneration: "previous-gateway" }],
            ...(terminal ? { restartRecoveryTerminalRunIds: [runId] } : {}),
          }
        : {};
    };
    seed(protectedKey, protectedId, 1, recovery(false));
    if (protection.endsWith("-id")) {
      seed(aliasKey, protectedId, 1);
    }
    seed(sibling, `unprotected-${protection}`, 1, recovery(true));
    const run = async () => {
      const completed = observeMaintenance();
      await patchSessionEntryCore(
        active,
        () => ({
          label: "protected",
          ...(protection === "ancestor" ? { parentSessionKey: protectedKey } : {}),
        }),
        {
          maintenanceConfig: maintenancePolicy(),
        },
      );
      await completed;
      expect(loadSessionEntry(scope(protectedKey))?.sessionId).toBe(protectedId);
      expect(loadSessionEntry(scope(sibling))).toBeUndefined();
      if (protection.endsWith("-id")) {
        expect(loadSessionEntry(scope(aliasKey))?.sessionId).toBe(protectedId);
      }
    };
    if (protection.startsWith("lifecycle")) {
      await runSessionMutation({
        scope: storePath,
        identities: [protection.endsWith("-key") ? protectedKey : protectedId],
        run,
      });
      return;
    }
    let release = () => {};
    if (protection === "provider") {
      let reverse = false;
      release = registerSessionMaintenancePreserveKeysProvider(async () => ({
        capture: () => {
          reverse = !reverse;
          const keys = [protectedKey.toUpperCase(), active.sessionKey];
          return reverse ? keys.toReversed() : keys;
        },
        dispose() {},
      }));
    } else if (protection === "registry") {
      registerAgentRunContext("maintenance-live-run", {
        agentId: "main",
        sessionKey: protectedKey,
        sessionId: protectedId,
        projectSessionActive: true,
      });
      release = () => clearAgentRunContext("maintenance-live-run");
    } else if (protection.startsWith("work")) {
      const lease = await beginSessionEffect({
        scope: storePath,
        identities: [protection.endsWith("-key") ? protectedKey : protectedId],
        assertAllowed: () => {},
      });
      release = () => lease.release();
    }
    try {
      await run();
    } finally {
      release();
    }
  });
});

it("rolls back archive metadata when a run registers at planning commit", async () => {
  await withMaintenanceFixture(async ({ seed, scope }) => {
    const active = seed("agent:main:maintenance-live-protection", "active");
    const protectedKey = "agent:main:maintenance-newly-protected";
    const staleKey = "agent:main:maintenance-still-stale";
    seed(protectedKey, "protected", 1);
    seed(staleKey, "stale", 1);
    let protectedNow = false;
    observeSessionMaintenancePlanningWorker({
      beforeAdmission(request) {
        const facts = request.facts;
        if (
          request.stage === "commit" &&
          isRecord(facts) &&
          isRecord(facts.publication) &&
          Array.isArray(facts.publication.changedKeys) &&
          facts.publication.changedKeys.includes(protectedKey)
        ) {
          protectedNow = true;
          registerAgentRunContext("maintenance-live-run", {
            agentId: "main",
            sessionKey: protectedKey,
            projectSessionActive: true,
          });
        }
      },
    });
    try {
      await maintain(active, "updated", maintenancePolicy());
      expect(protectedNow).toBe(true);
      expect(loadSessionEntry(scope(protectedKey))?.archivedAt).toBeUndefined();
      expect(loadSessionEntry(scope(staleKey))?.archivedAt).toEqual(expect.any(Number));
    } finally {
      clearAgentRunContext("maintenance-live-run");
    }
  });
});

it.each([
  { mutation: "backdate", boundary: "before-authorization" },
  { mutation: "restore", boundary: "after-result" },
  { mutation: "backdate", boundary: "cold-after-result" },
] as const)(
  "keeps $mutation authority at $boundary across real Worker planning",
  async ({ mutation, boundary }) => {
    await withMaintenanceFixture(async ({ seed }) => {
      const policy = maintenancePolicy("1s", { maxEntries: 1, preserveRecent: "1h" });
      // Recent protection keeps the victim until the boundary probe makes it old.
      seed("agent:main:age-worker-pressure", "pressure");
      const active = seed("agent:main:age-worker-active", "active");
      const victim = seed(
        "agent:main:age-worker-victim",
        "victim",
        mutation === "restore" ? 1 : Date.now(),
        mutation === "restore" ? { archivedAt: 2, archiveReason: "age-retention" } : {},
      );
      const warm = boundary !== "cold-after-result";
      let warmWorkerThreadId: number | undefined;
      if (warm) {
        const reclaim = reclamationRun.runSqliteSessionReclamation;
        vi.spyOn(reclamationRun, "runSqliteSessionReclamation").mockImplementation(
          async (params) => {
            const result = await reclaim(params);
            if (result.kind === "maintenance-plan") {
              warmWorkerThreadId = params.diagnostics?.workerThreadId;
            }
            return result;
          },
        );
        await maintain(active, "warm", policy, { workerGuard: {} });
        expect(warmWorkerThreadId).toBeGreaterThan(0);
        vi.restoreAllMocks();
      }
      let changed = false;
      const mutate = () => {
        changed = true;
        // This real synchronous writer does not increment the automatic kick generation.
        replaceSessionEntrySync(victim, { sessionId: "victim", updatedAt: 1 });
      };
      const workerThreadIds: number[] = [];
      observeSessionMaintenancePlanningWorker({
        beforeExecute() {
          if (boundary === "before-authorization" && !changed) {
            mutate();
          }
        },
        afterExecute(result) {
          workerThreadIds.push(result.workerThreadId);
          if (boundary !== "before-authorization" && result.kind === "not-committed" && !changed) {
            // Empty planning has finished; parent age-fact adoption has not run yet.
            mutate();
          }
        },
      });
      await maintain(
        active,
        "change during planning",
        policy,
        { workerGuard: {} },
        (result) => result.archived === 1,
      );
      expect(changed).toBe(true);
      expect(workerThreadIds[0]).toBeGreaterThan(0);
      expect(new Set(workerThreadIds).size).toBe(1);
      if (warm) {
        expect(workerThreadIds[0]).toBe(warmWorkerThreadId);
      }
      if (boundary !== "before-authorization") {
        expect(workerThreadIds.length).toBeGreaterThanOrEqual(2);
      }
      expect(loadSessionEntry(victim)).toMatchObject({
        archivedAt: expect.any(Number),
        archiveReason: "age-retention",
      });
    });
  },
);

it("retains a managed backdate during synchronous maintenance publication reentry", async () => {
  await withMaintenanceFixture(async ({ state, seed }) => {
    const active = seed("agent:main:age-publication-active", "active");
    const victim = seed("agent:main:age-publication-victim", "victim");
    const stale = seed("agent:main:age-publication-stale", "stale", 1);
    const policy = maintenancePolicy("1d");
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
    let reentered = false;
    const observed: Array<{ before: number | undefined; after: number | undefined }> = [];
    const unsubscribe = sessionChanges.subscribe((change) => {
      if (
        reentered ||
        !("sessionKey" in change) ||
        change.sessionKey !== stale.sessionKey ||
        change.storePath !== databasePath
      ) {
        return;
      }
      reentered = true;
      const before = loadSessionEntry(victim)?.archivedAt;
      replaceSessionEntrySync(victim, { sessionId: "victim", updatedAt: 1 });
      observed.push({ before, after: loadSessionEntry(victim)?.updatedAt });
    });
    try {
      await maintain(
        active,
        "publish",
        policy,
        {},
        (result) => result.archived === 1 && loadSessionEntry(victim)?.archivedAt !== undefined,
      );
      expect(observed).toEqual([{ before: undefined, after: 1 }]);
      expect(loadSessionEntry(victim)?.archivedAt).toEqual(expect.any(Number));
      expect(loadSessionEntry(stale)?.archivedAt).toEqual(expect.any(Number));
    } finally {
      unsubscribe();
    }
  });
});

it("publishes exact archived keys without worktrees after Worker planning", async () => {
  await withMaintenanceFixture(async ({ seed, databaseOptions, plan }) => {
    const active = seed("agent:main:keyed-active", "active");
    const stale = seed("agent:main:keyed-stale", "stale", 1);
    const database = openOpenClawAgentDatabase(databaseOptions);
    const published: SessionRowChange[] = [];
    const unsubscribe = sessionChanges.subscribe((change) => published.push(change));
    const diagnostics = {};
    try {
      const result = await reclamationRun.runSqliteSessionReclamation({
        diagnostics,
        plan: plan(active.sessionKey, maintenancePolicy()),
      });
      expect(diagnostics).toMatchObject({ workerThreadId: expect.any(Number) });
      expect(result).toMatchObject({
        kind: "maintenance-plan",
        value: {
          archived: 1,
          archivedEntries: [{ sessionKey: stale.sessionKey, sessionId: "stale" }],
          entryRemovals: [],
        },
      });
      expect(published).toEqual([
        {
          agentId: "main",
          storePath: database.path,
          sessionKey: stale.sessionKey,
          scope: "session-entry",
        },
      ]);
      expect(loadSessionEntry(stale)).toMatchObject({ archivedAt: expect.any(Number) });
      expect(loadSessionEntry(stale)?.worktree).toBeUndefined();
      expect(loadSessionEntry(active)?.archivedAt).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });
});

it("publishes only committed removal keys after Worker finalization", async () => {
  await withMaintenanceFixture(async ({ seed, databaseOptions }) => {
    const removedEntry = { sessionId: "removed", updatedAt: 1 };
    const previousEntry = { sessionId: "changed", updatedAt: 1 };
    const removed = seed(
      "agent:main:keyed-removed",
      removedEntry.sessionId,
      removedEntry.updatedAt,
    );
    const changed = seed(
      "agent:main:keyed-changed",
      previousEntry.sessionId,
      previousEntry.updatedAt,
    );
    const database = openOpenClawAgentDatabase(databaseOptions);
    const entries = [
      { sessionKey: removed.sessionKey, expectedEntry: loadSessionEntry(removed) },
      { sessionKey: changed.sessionKey, expectedEntry: loadSessionEntry(changed) },
    ];
    const plan = reclamation.createSessionMaintenanceFinalizationOperation({
      agentId: "main",
      databaseOptions,
      entries,
      materializedPlans: [],
    });
    replaceSessionEntrySync(changed, { ...previousEntry, label: "changed after planning" });
    const published: SessionRowChange[] = [];
    const unsubscribe = sessionChanges.subscribe((change) => published.push(change));
    const identities: SessionIdentityMutation[] = [];
    const unsubscribeIdentities = onSessionIdentityMutation((change) => identities.push(change));
    // Forward the intercepted prototype method with the actual Worker receiver below.
    // oxlint-disable-next-line typescript/unbound-method
    const postMessage = Worker.prototype.postMessage;
    let mutated = false;
    const dispatch = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      ...args
    ) {
      const result = postMessage.apply(this, args);
      const message: unknown = args[0];
      if (
        isRecord(message) &&
        message.type === "reclaim" &&
        isRecord(message.plan) &&
        message.plan.kind === "maintenance-finalize" &&
        isRecord(message.plan.databaseOptions) &&
        message.plan.databaseOptions.path === database.path
      ) {
        entries[0]!.sessionKey = "agent:main:mutated-after-dispatch";
        entries[0]!.expectedEntry!.sessionId = "mutated-after-dispatch";
        entries.reverse();
        mutated = true;
      }
      return result;
    });
    const diagnostics = {};
    try {
      const result = await reclamationRun.runSqliteSessionReclamation({
        diagnostics,
        plan,
      });
      expect(diagnostics).toMatchObject({ workerThreadId: expect.any(Number) });
      expect(mutated).toBe(true);
      expect(result).toMatchObject({
        kind: "maintenance-finalize",
        value: { committedEntryIndices: [0] },
      });
      expect(published).toEqual([
        { agentId: "main", storePath: database.path, sessionKey: removed.sessionKey },
      ]);
      expect(identities).toEqual([
        expect.objectContaining({
          kind: "delete",
          agentId: "main",
          previous: { sessionId: removedEntry.sessionId, sessionKeys: [removed.sessionKey] },
        }),
      ]);
      expect(loadSessionEntry(removed)).toBeUndefined();
      expect(loadSessionEntry(changed)?.label).toBe("changed after planning");
    } finally {
      dispatch.mockRestore();
      unsubscribeIdentities();
      unsubscribe();
    }
  });
});

it("preserves committed statistics and Worker reuse after a retired predicate", async () => {
  await withMaintenanceFixture(async ({ seed, databaseOptions }) => {
    seed("agent:main:statistics-first", "first");
    const database = openOpenClawAgentDatabase(databaseOptions);
    database.db.exec("ANALYZE; PRAGMA analysis_limit = 37;");
    const readStatistics = () =>
      database.db
        .prepare("SELECT stat FROM sqlite_stat1 WHERE idx = ?")
        .get("idx_agent_session_nodes_updated_at");
    expect(readStatistics()).toEqual({ stat: expect.stringMatching(/^1\b/u) });
    seed("agent:main:statistics-second", "second");
    let current = true;
    const fault = new Error("synthetic post-commit retired predicate");
    const reload = vi.spyOn(database.db, "exec");
    const first: SqliteSessionReclamationDiagnostics = {};
    const result = await reclamationRun.runSqliteSessionReclamation({
      assertCommitAllowed: () => {
        if (!current) {
          throw fault;
        }
      },
      diagnostics: first,
      onWorkerResult: () => {
        current = false;
      },
      plan: reclamation.createSessionMaintenanceStatisticsOperation(databaseOptions),
    });
    expect(result).toEqual({ kind: "maintenance-statistics", value: true });
    expect(first.workerThreadId).toEqual(expect.any(Number));
    expect(readStatistics()).toEqual({ stat: expect.stringMatching(/^2\b/u) });
    expect(reload.mock.calls).toEqual([]);
    expect(database.db.prepare("PRAGMA analysis_limit").get()).toEqual({ analysis_limit: 37 });
    reload.mockRestore();
    const second: SqliteSessionReclamationDiagnostics = {};
    await expect(
      reclamationRun.runSqliteSessionReclamation({
        diagnostics: second,
        plan: reclamation.createSessionMaintenanceStatisticsOperation(databaseOptions),
      }),
    ).resolves.toEqual({ kind: "maintenance-statistics", value: true });
    expect(second.workerThreadId).toBe(first.workerThreadId);
  });
});

it("invalidates the retained maintenance age when a worker commits a backdate", async () => {
  await withMaintenanceFixture(async ({ seed }) => {
    const active = seed("agent:main:age-recheck-active", "active");
    const managedVictim = seed("agent:main:age-recheck-managed", "managed");
    const policy = maintenancePolicy("1d");
    const observeDeadline = () => {
      const settled = createDeferredCore<number | undefined>();
      const reclaim = reclamationRun.runSqliteSessionReclamation;
      vi.spyOn(reclamationRun, "runSqliteSessionReclamation").mockImplementation(async (params) => {
        const result = await reclaim(params);
        if (result.kind === "maintenance-plan" || result.kind === "maintenance-age") {
          settled.resolve(result.nextAt);
        }
        return result;
      });
      return settled.promise;
    };
    const warmDeadline = observeDeadline();
    await maintain(active, "warm", policy);
    const initialDeadline = await warmDeadline;
    expect(initialDeadline).toEqual(expect.any(Number));
    expect(initialDeadline).toBeGreaterThan(Date.now());
    vi.restoreAllMocks();
    // Managed commit receipts must invalidate the retained Worker age fact even
    // when that caller deliberately delegates scheduling to a later write.
    await patchSessionEntryCore(managedVictim, () => ({ sessionId: "managed", updatedAt: 1 }), {
      replaceEntry: true,
      workerGuard: {},
      skipMaintenance: true,
    });
    await maintain(active, "after managed backdate", policy, {}, (result) => result.archived === 1);
    expect(loadSessionEntry(managedVictim)?.archivedAt).toEqual(expect.any(Number));
    expect(loadSessionEntry(active)?.archivedAt).toBeUndefined();
  });
});

registerSessionMaintenanceProtectionTests();
registerSessionMaintenancePreparationTests();
