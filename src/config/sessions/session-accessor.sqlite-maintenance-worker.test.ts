import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { DatabaseSync, StatementSync as NativeStatement } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  beginSessionWorkAdmission,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
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
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
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
import { observeSessionMaintenancePlanningWorker } from "./session-accessor.sqlite-maintenance.test-support.js";
import * as reclamationRun from "./session-accessor.sqlite-reclamation-run.js";
import * as reclamation from "./session-accessor.sqlite-reclamation.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { registerSessionMaintenancePreserveKeysProvider } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

afterEach(() => vi.restoreAllMocks());

function observeMaintenance(
  accept: (result: SessionEntryMaintenancePlan | SessionEntryMaintenanceResult) => boolean = () =>
    true,
) {
  return observeSessionMaintenanceCompletion(resolveOpenClawAgentSqlitePath({ agentId: "main" }), {
    accept,
  });
}

it.each(["cold", "warm-cap", "removal"] as const)(
  "runs automatic maintenance row planning off-thread (%s)",
  async (scenario) => {
    const remove = scenario === "removal" || scenario === "warm-cap";
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const active = { sessionKey: "agent:main:maintenance-worker-active", storePath };
      const stale = { sessionKey: "agent:main:subagent:maintenance-worker-stale", storePath };
      replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
      const staleEvent = { type: "session", id: "stale", content: "synthetic maintenance archive" };
      const seedStale = (updatedAt: number) => {
        replaceSessionEntrySync(stale, { sessionId: "stale", updatedAt });
        replaceTranscriptEventsSync({ ...stale, sessionId: "stale" }, [staleEvent]);
      };
      if (scenario === "removal") {
        seedStale(1);
      }
      const policy = resolveMaintenanceConfigFromInput({
        mode: "enforce",
        maxEntries: scenario === "warm-cap" ? 1 : 100,
        pruneAfter: "1h",
      });
      if (scenario === "warm-cap") {
        const warmed = observeMaintenance();
        await patchSessionEntryCore(active, () => ({ label: "warm" }), {
          maintenanceConfig: policy,
          workerGuard: {},
        });
        await warmed;
        vi.restoreAllMocks();
      }
      if (scenario === "warm-cap") {
        seedStale(Date.now() - 1);
      }
      const maintenanceReads: string[] = [];
      observeSessionMaintenancePlanningWorker({
        onRead: (kind) => maintenanceReads.push(kind),
      });
      const completed = observeMaintenance();
      const observation = new AsyncLocalStorage<boolean>();
      const kick = maintenanceKick.kickSessionEntryMaintenanceAfterWrite;
      vi.spyOn(maintenanceKick, "kickSessionEntryMaintenanceAfterWrite").mockImplementation(
        (request) => observation.run(true, () => kick(request)),
      );
      const { DatabaseSync, StatementSync } = requireNodeSqlite();
      const emptyCounts = { prepare: 0, exec: 0, get: 0, all: 0, run: 0, iterate: 0 };
      const counts = { ...emptyCounts };
      const preparedSql: string[] = [];
      const executedSql: string[] = [];
      // oxlint-disable-next-line typescript/unbound-method -- Forward the native operation with its exact database receiver.
      const originalPrepare = DatabaseSync.prototype.prepare;
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(
        new Proxy(originalPrepare, {
          apply(target, receiver: DatabaseSync, args) {
            if (observation.getStore()) {
              counts.prepare += 1;
              preparedSql.push(args[0]);
            }
            return Reflect.apply(target, receiver, args);
          },
        }),
      );
      // oxlint-disable-next-line typescript/unbound-method -- Forward the native operation with its exact database receiver.
      const originalExec = DatabaseSync.prototype.exec;
      const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(
        new Proxy(originalExec, {
          apply(target, receiver: DatabaseSync, args) {
            if (observation.getStore()) {
              counts.exec += 1;
            }
            return Reflect.apply(target, receiver, args);
          },
        }),
      );
      const statements = (["get", "all", "run", "iterate"] as const).map((method) => {
        const original = StatementSync.prototype[method];
        return vi.spyOn(StatementSync.prototype, method).mockImplementation(
          new Proxy(original, {
            apply(target, receiver: NativeStatement, args) {
              if (observation.getStore()) {
                counts[method] += 1;
                executedSql.push(receiver.sourceSQL);
              }
              return Reflect.apply(target, receiver, args);
            },
          }),
        );
      });
      const preservation = vi.fn(() => []);
      const unregister = registerSessionMaintenancePreserveKeysProvider(async () => ({
        capture: preservation,
        dispose() {},
      }));
      const result = await (async () => {
        try {
          await patchSessionEntryCore(active, () => ({ label: "updated" }), {
            maintenanceConfig: policy,
            workerGuard: {},
          });
          return await completed;
        } finally {
          unregister();
          prepare.mockRestore();
          exec.mockRestore();
          statements.forEach((spy) => spy.mockRestore());
        }
      })();
      console.info("automatic-maintenance parent SQL", { scenario, ...counts });
      expect(
        [...preparedSql, ...executedSql].filter((query) =>
          /(?:from|update|into) "(?:session_nodes|session_transcript_archives)"/iu.test(query),
        ),
      ).toEqual([]);
      if (!remove) {
        expect(counts).toEqual(emptyCounts);
        expect(preservation).not.toHaveBeenCalled();
        expect(maintenanceReads).toEqual(["maintenance-plan"]);
      }
      expect(loadSessionEntry(active)?.label).toBe("updated");
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
      expect(loadSessionEntry(active)?.label).toBe("updated");
      if (remove) {
        expect(loadSessionEntry(stale)).toBeUndefined();
      }
    });
  },
);

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
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const active = { sessionKey: "agent:main:maintenance-protection-active", storePath };
    const protectedKey = protection.startsWith("recovery")
      ? "agent:main:hook:maintenance-protected"
      : "agent:main:subagent:maintenance-protected";
    const protectedId = "maintenance-protected-id";
    const aliasKey = "agent:main:subagent:maintenance-protected-alias";
    const sibling = "agent:main:subagent:maintenance-unprotected";
    replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
    replaceSessionEntrySync(
      { sessionKey: protectedKey, storePath },
      {
        sessionId: protectedId,
        updatedAt: 1,
        ...(protection === "recovery-cycle"
          ? {
              mainRestartRecovery: { cycleId: "waiting", revision: 1, chargedAttempts: 0 },
            }
          : protection === "recovery-run"
            ? {
                restartRecoveryRuns: [
                  { runId: "awaiting-recovery", lifecycleGeneration: "previous-gateway" },
                ],
              }
            : {}),
      },
    );
    if (protection.endsWith("-id")) {
      replaceSessionEntrySync(
        { sessionKey: aliasKey, storePath },
        {
          sessionId: protectedId,
          updatedAt: 1,
        },
      );
    }
    replaceSessionEntrySync(
      { sessionKey: sibling, storePath },
      {
        sessionId: "unprotected",
        updatedAt: 1,
        ...(protection === "recovery-cycle"
          ? {
              mainRestartRecovery: {
                cycleId: "finished",
                revision: 1,
                chargedAttempts: 0,
                tombstone: { reason: "exhausted" },
              },
            }
          : protection === "recovery-run"
            ? {
                restartRecoveryRuns: [
                  { runId: "terminal", lifecycleGeneration: "previous-gateway" },
                ],
                restartRecoveryTerminalRunIds: ["terminal"],
              }
            : {}),
      },
    );
    const run = async () => {
      const completed = observeMaintenance();
      await patchSessionEntryCore(
        active,
        () => ({
          label: "protected",
          ...(protection === "ancestor" ? { parentSessionKey: protectedKey } : {}),
        }),
        {
          maintenanceConfig: resolveMaintenanceConfigFromInput({
            mode: "enforce",
            maxEntries: 100,
            pruneAfter: "1s",
          }),
        },
      );
      await completed;
      expect(loadSessionEntry({ sessionKey: protectedKey, storePath })?.sessionId).toBe(
        protectedId,
      );
      expect(loadSessionEntry({ sessionKey: sibling, storePath })).toBeUndefined();
      if (protection.endsWith("-id")) {
        expect(loadSessionEntry({ sessionKey: aliasKey, storePath })?.sessionId).toBe(protectedId);
      }
    };
    if (protection === "provider") {
      let reverse = false;
      const unregister = registerSessionMaintenancePreserveKeysProvider(async () => ({
        capture: () => {
          reverse = !reverse;
          const keys = [protectedKey.toUpperCase(), active.sessionKey];
          return reverse ? keys.toReversed() : keys;
        },
        dispose() {},
      }));
      try {
        await run();
      } finally {
        unregister();
      }
    } else if (protection === "registry") {
      registerAgentRunContext("maintenance-live-run", {
        agentId: "main",
        sessionKey: protectedKey,
        sessionId: protectedId,
        projectSessionActive: true,
      });
      try {
        await run();
      } finally {
        clearAgentRunContext("maintenance-live-run");
      }
    } else if (protection === "ancestor" || protection.startsWith("recovery")) {
      await run();
    } else {
      const identity = protection.endsWith("-key") ? protectedKey : protectedId;
      if (protection.startsWith("lifecycle")) {
        await runExclusiveSessionLifecycleMutation("archive", {
          scope: storePath,
          identities: [identity],
          run,
        });
      } else {
        const lease = await beginSessionWorkAdmission({
          scope: storePath,
          identities: [identity],
          assertAllowed: () => {},
        });
        try {
          await run();
        } finally {
          lease.release();
        }
      }
    }
  });
});

it("rolls back archive metadata when a run registers at planning commit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const active = { sessionKey: "agent:main:maintenance-live-protection", storePath };
    const protectedKey = "agent:main:maintenance-newly-protected";
    const staleKey = "agent:main:maintenance-still-stale";
    replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
    replaceSessionEntrySync(
      { sessionKey: protectedKey, storePath },
      { sessionId: "protected", updatedAt: 1 },
    );
    replaceSessionEntrySync(
      { sessionKey: staleKey, storePath },
      { sessionId: "stale", updatedAt: 1 },
    );
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
      const completed = observeMaintenance();
      await patchSessionEntryCore(active, () => ({ label: "updated" }), {
        maintenanceConfig: resolveMaintenanceConfigFromInput({
          mode: "enforce",
          pruneAfter: "1s",
          maxEntries: 100,
        }),
      });
      await completed;
      expect(protectedNow).toBe(true);
      expect(loadSessionEntry({ sessionKey: protectedKey, storePath })?.archivedAt).toBeUndefined();
      expect(loadSessionEntry({ sessionKey: staleKey, storePath })?.archivedAt).toEqual(
        expect.any(Number),
      );
    } finally {
      clearAgentRunContext("maintenance-live-run");
    }
  });
});

it.each([
  { mutation: "backdate", boundary: "before-authorization" },
  { mutation: "restore", boundary: "after-settlement" },
  { mutation: "backdate", boundary: "missing-after-settlement" },
  { mutation: "backdate", boundary: "before-read-consumption" },
] as const)(
  "keeps $mutation authority at $boundary across real Worker planning",
  async ({ mutation, boundary }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const active = { sessionKey: "agent:main:age-worker-active", storePath };
      const victim = { sessionKey: "agent:main:age-worker-victim", storePath };
      const policy = resolveMaintenanceConfigFromInput({
        mode: "enforce",
        maxEntries: 1,
        pruneAfter: "1s",
        preserveRecent: "1h",
      });
      // Cap pressure requires Worker admission even with a warm age fact. Recent
      // rows remain protected until the injected backdate/restore makes the victim old.
      replaceSessionEntrySync(
        { sessionKey: "agent:main:age-worker-pressure", storePath },
        { sessionId: "pressure", updatedAt: Date.now() },
      );
      replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
      replaceSessionEntrySync(victim, {
        sessionId: "victim",
        updatedAt: mutation === "restore" ? 1 : Date.now(),
        ...(mutation === "restore"
          ? { archivedAt: 2, archiveReason: "age-retention" as const }
          : {}),
      });
      const warm = boundary !== "missing-after-settlement";
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
        const prepared = observeMaintenance();
        await patchSessionEntryCore(active, () => ({ label: "warm" }), {
          maintenanceConfig: policy,
          workerGuard: {},
        });
        await prepared;
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
      let readOnlySettled = false;
      observeSessionMaintenancePlanningWorker({
        beforeExecute() {
          if (boundary === "before-authorization" && !changed) {
            mutate();
          }
        },
        async afterExecute(result, native) {
          workerThreadIds.push(result.workerThreadId);
          if (result.kind === "read-only") {
            expect(native.admission).toBeUndefined();
            expect(native.retained).toBeUndefined();
            readOnlySettled = true;
            if (boundary === "before-read-consumption" && !changed) {
              mutate();
            }
          }
          if (
            boundary !== "before-authorization" &&
            boundary !== "before-read-consumption" &&
            result.kind === "committed" &&
            !changed
          ) {
            expect(native.admission?.committed).toMatchObject({
              facts: { kind: "session-entry-replacements" },
            });
            expect(native.admission?.settlement).toMatchObject({ kind: "completed" });
            expect(await native.retained?.settled).toEqual({ kind: "completed" });
            // Native COMMIT has completed; parent result adoption has not run yet.
            mutate();
          }
        },
      });
      const rejectedSnapshots: string[] = [];
      const reclaim = reclamationRun.runSqliteSessionReclamation;
      vi.spyOn(reclamationRun, "runSqliteSessionReclamation").mockImplementation(async (params) => {
        const result = await reclaim(params);
        if (
          readOnlySettled &&
          result.kind === "maintenance-plan" &&
          result.readOnlyInput &&
          (boundary === "after-settlement" || boundary === "missing-after-settlement") &&
          !changed
        ) {
          // Read-only completion has no COMMIT receipt; retain the same caller-adoption race.
          mutate();
        }
        if (changed && result.kind === "maintenance-plan-stale") {
          rejectedSnapshots.push(params.plan.kind);
        }
        return result;
      });
      const completed = observeMaintenance((result) => result.archived === 1);
      await patchSessionEntryCore(active, () => ({ label: "change during planning" }), {
        maintenanceConfig: policy,
        workerGuard: {},
      });
      await completed;
      expect(changed).toBe(true);
      expect(workerThreadIds[0]).toBeGreaterThan(0);
      expect(new Set(workerThreadIds).size).toBe(1);
      if (warm) {
        expect(workerThreadIds[0]).toBe(warmWorkerThreadId);
      }
      if (boundary !== "before-authorization") {
        expect(workerThreadIds.length).toBeGreaterThanOrEqual(2);
      }
      if (boundary === "before-read-consumption") {
        expect(rejectedSnapshots).toContain("maintenance-plan");
      }
      expect(loadSessionEntry(victim)).toMatchObject({
        archivedAt: expect.any(Number),
        archiveReason: "age-retention",
      });
    });
  },
);

it("retains a managed backdate during synchronous maintenance publication reentry", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const active = { sessionKey: "agent:main:age-publication-active", storePath };
    const victim = { sessionKey: "agent:main:age-publication-victim", storePath };
    const stale = { sessionKey: "agent:main:age-publication-stale", storePath };
    const policy = resolveMaintenanceConfigFromInput({
      mode: "enforce",
      maxEntries: 100,
      pruneAfter: "1d",
    });
    replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
    replaceSessionEntrySync(victim, { sessionId: "victim", updatedAt: Date.now() });
    replaceSessionEntrySync(stale, { sessionId: "stale", updatedAt: 1 });
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
      const completed = observeMaintenance(
        (result) => result.archived === 1 && loadSessionEntry(victim)?.archivedAt !== undefined,
      );
      await patchSessionEntryCore(active, () => ({ label: "publish" }), {
        maintenanceConfig: policy,
      });
      await completed;
      expect(observed).toEqual([{ before: undefined, after: 1 }]);
      expect(loadSessionEntry(victim)?.archivedAt).toEqual(expect.any(Number));
      expect(loadSessionEntry(stale)?.archivedAt).toEqual(expect.any(Number));
    } finally {
      unsubscribe();
    }
  });
});

it("publishes exact archived keys without worktrees after Worker planning", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const active = { sessionKey: "agent:main:keyed-active", storePath };
    const stale = { sessionKey: "agent:main:keyed-stale", storePath };
    replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
    replaceSessionEntrySync(stale, { sessionId: "stale", updatedAt: 1 });
    const databaseOptions = { agentId: "main", env: state.env };
    const database = openOpenClawAgentDatabase(databaseOptions);
    const published: SessionRowChange[] = [];
    const unsubscribe = sessionChanges.subscribe((change) => published.push(change));
    const diagnostics = {};
    try {
      const result = await reclamationRun.runSqliteSessionReclamation({
        diagnostics,
        forceInProcess: false,
        plan: {
          kind: "maintenance-plan",
          databaseOptions: reclamation.resolveSessionReclamationDatabaseOptions(databaseOptions),
          materializedPlans: [],
          input: {
            activeSessionKey: active.sessionKey,
            archiveDirectory: state.sessionsDir(),
            maintenance: resolveMaintenanceConfigFromInput({
              mode: "enforce",
              maxEntries: 100,
              pruneAfter: "1s",
            }),
            preservation: { providerKeys: [], workIdentities: [], lifecycleIdentities: [] },
            storePath,
          },
        },
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
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const removed = { sessionKey: "agent:main:keyed-removed", storePath };
    const changed = { sessionKey: "agent:main:keyed-changed", storePath };
    const removedEntry = { sessionId: "removed", updatedAt: 1 };
    const previousEntry = { sessionId: "changed", updatedAt: 1 };
    replaceSessionEntrySync(removed, removedEntry);
    replaceSessionEntrySync(changed, previousEntry);
    const databaseOptions = { agentId: "main", env: state.env };
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
        forceInProcess: false,
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
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    replaceSessionEntrySync(
      { sessionKey: "agent:main:statistics-first", storePath },
      { sessionId: "first", updatedAt: Date.now() },
    );
    const databaseOptions = { agentId: "main", env: state.env };
    const database = openOpenClawAgentDatabase(databaseOptions);
    database.db.exec("ANALYZE; PRAGMA analysis_limit = 37;");
    const readStatistics = () =>
      database.db
        .prepare("SELECT stat FROM sqlite_stat1 WHERE idx = ?")
        .get("idx_agent_session_nodes_updated_at");
    expect(readStatistics()).toEqual({ stat: expect.stringMatching(/^1\b/u) });
    replaceSessionEntrySync(
      { sessionKey: "agent:main:statistics-second", storePath },
      { sessionId: "second", updatedAt: Date.now() },
    );
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
      forceInProcess: false,
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
        forceInProcess: false,
        plan: reclamation.createSessionMaintenanceStatisticsOperation(databaseOptions),
      }),
    ).resolves.toEqual({ kind: "maintenance-statistics", value: true });
    expect(second.workerThreadId).toBe(first.workerThreadId);
  });
});

it("invalidates the retained maintenance age when a worker commits a backdate", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const active = { sessionKey: "agent:main:age-recheck-active", storePath };
    const managedVictim = { sessionKey: "agent:main:age-recheck-managed", storePath };
    const policy = resolveMaintenanceConfigFromInput({
      mode: "enforce",
      maxEntries: 100,
      pruneAfter: "1d",
    });
    replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
    replaceSessionEntrySync(managedVictim, { sessionId: "managed", updatedAt: Date.now() });
    const observeDeadline = () => {
      const settled = createDeferredCore<number | undefined>();
      const reclaim = reclamationRun.runSqliteSessionReclamation;
      vi.spyOn(reclamationRun, "runSqliteSessionReclamation").mockImplementation(async (params) => {
        const consumption: { deadline?: { nextAt: number | undefined } } = {};
        const consume = params.consumeReadOnlyMaintenancePlan;
        const result = await reclaim({
          ...params,
          ...(consume
            ? {
                consumeReadOnlyMaintenancePlan(read, assertCurrent) {
                  consume(read, assertCurrent);
                  consumption.deadline = { nextAt: read.nextAt };
                },
              }
            : {}),
        });
        if (result.kind === "maintenance-plan" && consumption.deadline) {
          settled.resolve(consumption.deadline.nextAt);
        } else if (params.plan.kind === "maintenance-age" && result.kind === "maintenance-age") {
          settled.resolve(result.nextAt);
        }
        return result;
      });
      return settled.promise;
    };
    const warmDeadline = observeDeadline();
    const warm = observeMaintenance();
    await patchSessionEntryCore(active, () => ({ label: "warm" }), { maintenanceConfig: policy });
    await warm;
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
    const rechecked = observeMaintenance((result) => result.archived === 1);
    await patchSessionEntryCore(active, () => ({ label: "after managed backdate" }), {
      maintenanceConfig: policy,
    });
    await rechecked;
    expect(loadSessionEntry(managedVictim)?.archivedAt).toEqual(expect.any(Number));
    expect(loadSessionEntry(active)?.archivedAt).toBeUndefined();
  });
});

registerSessionMaintenanceProtectionTests();
registerSessionMaintenancePreparationTests();
