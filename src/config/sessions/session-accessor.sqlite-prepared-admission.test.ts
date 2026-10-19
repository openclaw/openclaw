import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { WorkerOptions } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import { revokeSqliteDatabaseAdmissionsForPath as revokeAdmission } from "../../infra/sqlite-database-admission.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope as withRegistry } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { closeCachedOpenClawAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  getOpenClawAgentDatabaseValidation as validation,
  invalidateOpenClawAgentDatabaseValidation as invalidateValidation,
} from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPathAsync as closeDatabase,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen as cachedDatabase,
  openOpenClawAgentDatabase as openDatabase,
  runOpenClawAgentWriteTransaction as transaction,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import {
  loadSessionEntryReadOnly as readEntry,
  loadTranscriptEventsSync as readEvents,
  replaceSessionEntrySync as replaceEntry,
} from "./session-accessor.js";
import type { SessionEntryLifecycleMutationResult } from "./session-accessor.sqlite-contract.js";
import { withWorkerSqliteIntegrityCounter } from "./session-accessor.sqlite-integrity-counter.test-support.js";
import {
  applySessionEntryMaintenance,
  finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort as finalizeMaintenance,
} from "./session-accessor.sqlite-maintenance.js";
import {
  holdReclamationAdmission,
  observePreparedAdmission,
  observePreparedWorkerAdmission,
  observeRetainedMaintenanceFinalizer,
  type PreparedAdmissionHooks,
  type PreparedIntegrityOwner,
} from "./session-accessor.sqlite-prepared-admission.test-support.js";
import {
  applySessionEntryLifecycleMutation as mutateEntries,
  applySessionEntryReplacements as replaceEntries,
} from "./session-accessor.sqlite-projection.js";
import {
  resolveSqliteScope,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite as exclusiveWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { prepareSessionMaintenancePreservation } from "./store-maintenance-preserve.js";

const hooks = vi.hoisted((): PreparedAdmissionHooks => ({}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      private readonly integrityProbe: typeof hooks.integrityPhase;
      private readonly integrityOwner: PreparedIntegrityOwner;

      constructor(filename: string | URL, options?: WorkerOptions) {
        super(
          filename,
          withWorkerSqliteIntegrityCounter(
            options,
            hooks.integrityChecks,
            hooks.integrityRelease,
            hooks.integrityPath,
            hooks.integrityFirstCheck,
          ),
        );
        const data: unknown = options?.workerData;
        this.integrityOwner = filename
          .toString()
          .replaceAll("\\", "/")
          .includes("/infra/sqlite-store.worker.")
          ? "executor"
          : isRecord(data) && data.operation === "reclaim"
            ? "reclamation"
            : "other";
        this.integrityProbe = hooks.integrityPhase;
        hooks.worker?.(this, this.integrityOwner);
      }

      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const message = args[0];
        if (
          this.integrityProbe &&
          event === "message" &&
          args.length === 1 &&
          isRecord(message) &&
          (Object.keys(message).length === 2 ||
            (Object.keys(message).length === 3 && typeof message.held === "boolean")) &&
          message.type === "test-integrity-check" &&
          (message.phase === "checking" || message.phase === "checked")
        ) {
          this.integrityProbe(this, this.integrityOwner, message.phase, message.held === true);
          return true;
        }
        return super.emit(event, ...args);
      }
    },
  };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    fork: (...args: Parameters<typeof actual.fork>) => {
      const child = actual.fork(...args);
      hooks.fork?.(child);
      return child;
    },
  };
});

vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    materializeSessionStateDeletePlans: async (
      ...args: Parameters<typeof actual.materializeSessionStateDeletePlans>
    ) => {
      const result = await actual.materializeSessionStateDeletePlans(...args);
      await hooks.afterMaterialize?.();
      return result;
    },
  };
});

const roots = createTempDirTracker();
const pending: Promise<unknown>[] = [];
const releases: Array<() => void> = [];

beforeEach(() => {
  resetConfigRuntimeState();
  const config = { session: { maintenance: { mode: "warn" as const } } };
  setRuntimeConfigSnapshot(config, config);
});

afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await Promise.allSettled(pending.splice(0));
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  // Timeouts can bypass the health probe's shared-state cleanup.
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  hooks.fork = undefined;
  hooks.afterMaterialize = undefined;
  hooks.integrityChecks = undefined;
  hooks.integrityRelease = undefined;
  hooks.integrityPath = undefined;
  hooks.integrityFirstCheck = undefined;
  hooks.integrityPhase = undefined;
  hooks.worker = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetConfigRuntimeState();
  roots.cleanup();
});

function own<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise);
  void promise.catch(() => {});
  return promise;
}

function fixture() {
  const root = roots.make("prepared-writer-admission-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const input = {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: root },
    sessionKey: "agent:main:prepared-admission",
  };
  replaceEntry(input, { sessionId: "original", updatedAt: Date.now() });
  const scope = resolveSqliteScope(input);
  const options = toDatabaseOptions(scope);
  const database = openDatabase(options);
  const databasePath = database.path;
  const replace = <T>(
    update: Parameters<typeof replaceEntries<T>>[0]["update"],
    params: Partial<Omit<Parameters<typeof replaceEntries<T>>[0], "update">> = {},
  ) =>
    replaceEntries({
      storePath: databasePath,
      sessionKeys: [input.sessionKey],
      skipMaintenance: true,
      ...params,
      update,
    });
  return {
    input,
    scope,
    options,
    databasePath,
    read: () => readEntry(input),
    write: <T>(run: () => Promise<T>) => exclusiveWrite(scope, run, "session.transcript.batch"),
    mutate: (params: Omit<Parameters<typeof mutateEntries>[0], "storePath">) =>
      mutateEntries({
        storePath: databasePath,
        skipMaintenance: true,
        ...params,
      }),
    replace,
    label: (label: string, skipMaintenance = true) =>
      replace(
        (entries) => ({
          result: undefined,
          replacements: labelEntries(entries, label),
        }),
        { skipMaintenance },
      ),
    finalize: (
      plans: Parameters<typeof finalizeMaintenance>[1],
      finalizerOptions?: Parameters<typeof finalizeMaintenance>[2],
    ) => finalizeMaintenance(scope, plans, finalizerOptions),
  };
}

type Fixture = ReturnType<typeof fixture>;

function labelEntries(
  entries: Parameters<Parameters<typeof replaceEntries>[0]["update"]>[0],
  label: string,
) {
  return entries.map(({ sessionKey, entry }) => ({ sessionKey, entry: { ...entry, label } }));
}

function nativeRegistry(
  id: string,
  prepare: () => Promise<void>,
  commit: () => void,
  rollback: () => void,
) {
  const registry = createEmptyPluginRegistry();
  const harness: AgentHarness = {
    id,
    label: id,
    supports: () => ({ supported: true }),
    runAttempt: async () => {
      throw new Error("unused test harness");
    },
    withSessionDeletion: async (params, run) => {
      await prepare();
      params.assertCurrent();
      return await run({ commit, rollback });
    },
  };
  const record = createPluginRecord({ id: `${id}-owner` });
  registry.plugins.push(record);
  registry.agentHarnesses.push({ harness, pluginId: record.id, source: "runtime" });
  markPluginRegistryActive(registry);
  return registry;
}

function invalidateAdmission(f: Fixture) {
  invalidateValidation(f.databasePath);
  revokeAdmission(f.databasePath);
}

async function closeForIntegrityAdmission(f: Fixture) {
  expect(await closeDatabase(f.databasePath)).toBe(true);
  invalidateAdmission(f);
}

async function closeWorkerForIntegrityAdmission(f: Fixture) {
  await runInDetachedAsyncContext(() => closeDatabase(f.databasePath));
  invalidateAdmission(f);
}

function evictCachedHandle(f: Fixture) {
  const database = cachedDatabase(f.options);
  assert(database, "Fixture lost its cached handle before eviction");
  closeCachedOpenClawAgentDatabase(database);
  expect(database.db.isOpen).toBe(false);
}

function evictCachedHandleForIntegrityAdmission(f: Fixture) {
  evictCachedHandle(f);
  invalidateAdmission(f);
}

function observeAdmission(databasePath: string, hold = false) {
  return observePreparedAdmission(databasePath, { hooks, releases, own }, hold);
}

function observeWorkerAdmission(databasePath: string, mode: "warm" | "cold") {
  const parent = observeAdmission(databasePath);
  return observePreparedWorkerAdmission({
    databasePath,
    mode,
    hooks,
    releases,
    expectParentHealthy: () => parent.expectHealthy(0),
  });
}

const cases = (["lifecycle", "replacement"] as const).flatMap((owner) =>
  (["warm", "cold-preparation", "cold-commit"] as const).map((mode) => ({ owner, mode })),
);

it.each(cases)(
  "keeps $owner $mode validation and callback order inside the writer FIFO",
  async ({ owner, mode }) => {
    const f = fixture();
    if (mode === "cold-preparation") {
      await closeForIntegrityAdmission(f);
    }
    const probe = observeAdmission(f.databasePath);
    const workerProbe =
      owner === "lifecycle"
        ? observePreparedWorkerAdmission({
            databasePath: f.databasePath,
            mode: "warm",
            hooks,
            releases,
            expectParentHealthy: () => probe.expectHealthy(0),
          })
        : undefined;
    const entered = createDeferred();
    const release = createDeferred();
    releases.push(() => release.resolve());
    let callbacks = 0;
    const order: string[] = [];
    const update = async () => {
      callbacks += 1;
      order.push("update");
      entered.resolve();
      await release.promise;
      if (mode === "cold-commit") {
        if (owner === "lifecycle") {
          evictCachedHandleForIntegrityAdmission(f);
        } else {
          await closeWorkerForIntegrityAdmission(f);
        }
      }
    };
    const operation = own<string | SessionEntryLifecycleMutationResult>(
      owner === "replacement"
        ? f.replace(async (entries) => {
            await update();
            return {
              replacements: labelEntries(entries, "updated"),
              result: "done",
            };
          })
        : f.mutate({
            upserts: [
              {
                sessionKey: f.input.sessionKey,
                buildEntry: async ({ currentEntry }) => {
                  await update();
                  assert(currentEntry, "fixture entry missing");
                  return { ...currentEntry, label: "updated" };
                },
              },
            ],
          }),
    );
    expect(callbacks).toBe(0);
    const later = own(
      f.write(async () => {
        order.push("later");
        return f.read()?.label;
      }),
    );
    await entered.promise;
    await yieldToEventLoop();
    expect(order).toEqual(["update"]);
    release.resolve();
    await operation;
    expect(await later).toBe("updated");
    expect(f.read()).toMatchObject({
      sessionId: "original",
      label: "updated",
    });
    expect({ callbacks, order }).toEqual({ callbacks: 1, order: ["update", "later"] });
    if (workerProbe) {
      await own(
        workerProbe.expectHealthy({
          executor: mode === "warm" ? 0 : 1,
          reclamation: 0,
          other: 0,
        }),
      );
    } else {
      probe.expectHealthy(0);
    }
  },
);

it("does not reopen a disposed handle for a missing replacement's result-only commit", async () => {
  const f = fixture();
  const probe = observeAdmission(f.databasePath);
  const update = vi.fn(async () => {
    expect(await runInDetachedAsyncContext(() => closeDatabase(f.databasePath))).toBe(true);
    return {
      result: "no-op",
      replacements: [
        { sessionKey: "agent:main:missing", entry: { sessionId: "missing", updatedAt: 1 } },
      ],
    };
  });
  await expect(own(f.replace(update, { sessionKeys: ["agent:main:missing"] }))).resolves.toBe(
    "no-op",
  );
  expect(update).toHaveBeenCalledOnce();
  expect(cachedDatabase(f.options)).toBeUndefined();
  probe.expectHealthy(0);
  expect(f.read()?.sessionId).toBe("original");
});

it("checks replacement commit authority before stale rows or worker admission", async () => {
  const f = fixture();
  const probe = observeAdmission(f.databasePath);
  const denied = new Error("synthetic replacement denied");
  const guard = vi.fn(() => {
    throw denied;
  });
  const update = vi.fn(
    async (entries: Parameters<Parameters<typeof replaceEntries>[0]["update"]>[0]) => {
      replaceEntry(f.input, {
        sessionId: "original",
        label: "newer",
        updatedAt: Date.now(),
      });
      await closeWorkerForIntegrityAdmission(f);
      return {
        result: undefined,
        replacements: labelEntries(entries, "uncommitted"),
      };
    },
  );
  await expect(own(f.replace(update, { assertCommitAllowed: guard }))).rejects.toBe(denied);
  expect(update).toHaveBeenCalledOnce();
  expect(guard).toHaveBeenCalledOnce();
  probe.expectHealthy(0);
  expect(f.read()?.label).toBe("newer");
});

function seedTranscript(f: Fixture) {
  const scope = { ...f.input, sessionId: "original" };
  const events = [{ type: "session", id: "original", content: "retained prepared history" }];
  expect(replaceTranscriptEventsSync(scope, events)).toBe(true);
  return { scope, events };
}

it("reacquires post-builder references before planning lifecycle transcript deletion", async () => {
  const f = fixture();
  const transcript = seedTranscript(f);
  const survivor = { ...f.input, sessionKey: "agent:main:surviving-reference" };
  replaceEntry(survivor, { sessionId: "survivor", updatedAt: Date.now() });
  const probe = observeAdmission(f.databasePath);
  let sql: ReturnType<typeof observeHostDataSql> | undefined;
  const builder = vi.fn(
    ({ currentEntry }: { currentEntry?: import("./types.js").SessionEntry }) => {
      evictCachedHandleForIntegrityAdmission(f);
      sql = observeHostDataSql();
      return { ...currentEntry!, usageFamilySessionIds: ["original"] };
    },
  );
  await expect(
    own(
      f.mutate({
        removals: [{ sessionKey: f.input.sessionKey, archiveRemovedTranscript: true }],
        upserts: [{ sessionKey: survivor.sessionKey, buildEntry: builder }],
      }),
    ).finally(() => sql?.restore()),
  ).resolves.toMatchObject({ removedEntries: 1, archivedTranscriptDirectories: [] });
  expect(builder).toHaveBeenCalledOnce();
  probe.expectHealthy(0);
  expect(sql?.queries, "post-builder reference planning stays off the caller thread").toEqual([]);
  expect(f.read()).toBeUndefined();
  expect(readEntry(survivor)?.usageFamilySessionIds).toEqual(["original"]);
  expect(readEvents(transcript.scope)).toEqual(transcript.events);
});

it("reacquires the split lifecycle writer after archive materialization with retained admission", async () => {
  const f = fixture();
  const transcript = seedTranscript(f);
  const probe = observeAdmission(f.databasePath);
  const admission = holdReclamationAdmission(f.databasePath);
  releases.push(() => admission.release.resolve());
  let materializations = 0;
  let preparationWriterRan = false;
  hooks.afterMaterialize = async () => {
    materializations += 1;
    await f.write(async () => {
      preparationWriterRan = true;
    });
    evictCachedHandle(f);
  };
  const work = own(
    f.mutate({
      removals: [{ sessionKey: f.input.sessionKey, archiveRemovedTranscript: true }],
    }),
  );
  await admission.expectPending(work);
  let laterRan = false;
  const later = own(
    f.write(async () => {
      laterRan = true;
    }),
  );
  await yieldToEventLoop();
  expect(laterRan).toBe(false);
  expect(preparationWriterRan).toBe(true);
  expect(f.read()?.sessionId).toBe("original");
  admission.release.resolve();
  const result = await work;
  await later;
  expect(materializations).toBe(1);
  expect(result.removedEntries).toBe(1);
  expect(result.archivedTranscriptDirectories).toHaveLength(1);
  expect(
    fs
      .readdirSync(result.archivedTranscriptDirectories[0]!)
      .some((name) => name.startsWith("original.jsonl.deleted.")),
  ).toBe(true);
  expect(f.read()).toBeUndefined();
  expect(readEvents(transcript.scope)).toEqual([]);
  // Cache eviction preserves the native admission and its completed integrity proof.
  probe.expectHealthy(0);
  expect(admission.count()).toBe(1);
});

it.each([false, true])(
  "rechecks native deletion ownership during split cold admission (revoked: %s)",
  async (revoked) => {
    const f = fixture();
    replaceEntry(f.input, {
      sessionId: "original",
      updatedAt: Date.now(),
      agentHarnessId: "prepared-native",
      lifecycleRevision: "generation-1",
    });
    const commit = vi.fn();
    const rollback = vi.fn();
    let preparationWriterRan = false;
    const prepare = vi.fn(async () => {
      await f.write(async () => {
        preparationWriterRan = true;
      });
      // Evict the handle without revoking the lifecycle operation's captured execution owner.
      evictCachedHandleForIntegrityAdmission(f);
    });
    const registry = nativeRegistry("prepared-native", prepare, commit, rollback);
    const probe = observeWorkerAdmission(f.databasePath, "cold");
    const work = own(
      withRegistry(registry, () =>
        f.mutate({
          removals: [{ sessionKey: f.input.sessionKey }],
        }),
      ),
    );
    await probe.expectPending(work);
    let laterRan = false;
    const later = own(
      f.write(async () => {
        laterRan = true;
      }),
    );
    await yieldToEventLoop();
    expect(laterRan).toBe(false);
    expect(preparationWriterRan).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    if (revoked) {
      markPluginRegistryRetired(registry);
    }
    probe.release.resolve();
    if (revoked) {
      await expect(work).rejects.toThrow("harness owner changed");
    } else {
      await expect(work).resolves.toMatchObject({ removedSessionKeys: [f.input.sessionKey] });
    }
    await later;
    expect(prepare).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledTimes(revoked ? 0 : 1);
    expect(rollback).not.toHaveBeenCalled();
    await own(probe.expectHealthy({ executor: 1, reclamation: 0, other: 0 }));
    expect(f.read()?.sessionId).toBe(revoked ? "original" : undefined);
  },
);

function maintenanceFixture(native = false) {
  const f = fixture();
  const stale = { ...f.input, sessionKey: "agent:main:subagent:maintenance-old", sessionId: "old" };
  replaceEntry(stale, {
    sessionId: stale.sessionId,
    updatedAt: 1,
    ...(native ? { agentHarnessId: "maintenance-native", lifecycleRevision: "generation-1" } : {}),
  });
  const events = [{ type: "session", id: "old", content: "retained maintenance history" }];
  replaceTranscriptEventsSync(stale, events);
  const config = {
    session: { maintenance: { mode: "enforce" as const, maxEntries: 1, pruneAfter: "1000000d" } },
  };
  setRuntimeConfigSnapshot(config, config);
  const archiveDirectory = resolveSqliteTranscriptArchiveDirectory(f.scope);
  return { ...f, stale, events, archiveDirectory };
}

function expectMaintenanceArchived(f: ReturnType<typeof maintenanceFixture>) {
  expect(readEntry(f.stale)).toBeUndefined();
  expect(f.read()?.sessionId).toBe("original");
  expect(readEvents(f.stale)).toEqual([]);
  const archives = fs
    .readdirSync(f.archiveDirectory)
    .filter((name) => name.startsWith("old.jsonl.deleted."));
  expect(archives).toHaveLength(1);
  expect(
    readSessionArchiveContentSync(path.join(f.archiveDirectory, archives[0]!))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual(f.events);
}

it.each(
  (["lifecycle", "replacement"] as const).flatMap((owner) =>
    ([false, true] as const).map((cold) => ({ owner, cold })),
  ),
)(
  "keeps $owner maintenance commits after validation without blocking writers (cold: $cold)",
  async ({ owner, cold }) => {
    const f = maintenanceFixture();
    const probe = observeWorkerAdmission(f.databasePath, cold ? "cold" : "warm");
    let preparationWriterRan = false;
    hooks.afterMaterialize = async () => {
      await f.write(async () => {
        preparationWriterRan = true;
      });
      if (cold) {
        if (owner === "lifecycle") {
          evictCachedHandleForIntegrityAdmission(f);
        } else {
          await closeWorkerForIntegrityAdmission(f);
        }
      }
    };
    const work = own<void | SessionEntryLifecycleMutationResult>(
      owner === "replacement"
        ? f.label("kept", false)
        : f.mutate({
            skipMaintenance: false,
            upserts: [
              {
                sessionKey: f.input.sessionKey,
                buildEntry: ({ currentEntry }) => ({ ...currentEntry!, label: "kept" }),
              },
            ],
          }),
    );
    if (cold) {
      expect(await probe.expectPending(work), "cold validation owner").toBe("reclamation");
      expect(readEntry(f.stale)?.sessionId).toBe("old");
      expect(f.read()?.label).toBe("kept");
      const later = own(f.label("foreground"));
      // Validation has no writer permit; the finalizer acquires it for its native commit.
      await later;
      expect(preparationWriterRan).toBe(true);
      expect(f.read()?.label).toBe("foreground");
      expect(readEntry(f.stale)?.sessionId).toBe("old");
      probe.release.resolve();
      await work;
    } else {
      await work;
    }
    expect(preparationWriterRan).toBe(true);
    expect(f.read()?.label).toBe(cold ? "foreground" : "kept");
    expectMaintenanceArchived(f);
    await own(
      probe.expectHealthy({
        executor: cold && owner === "replacement" ? 1 : 0,
        reclamation: cold ? 1 : 0,
        other: 0,
      }),
    );
  },
);

async function maintenancePlan(f: ReturnType<typeof maintenanceFixture>) {
  const preservation = await prepareSessionMaintenancePreservation(f.databasePath);
  try {
    return transaction(
      (database) =>
        applySessionEntryMaintenance(database, {
          preservation: preservation.capture,
          activeSessionKey: f.input.sessionKey,
          archiveDirectory: f.archiveDirectory,
          storePath: f.databasePath,
        }),
      f.options,
    );
  } finally {
    preservation.dispose();
  }
}

it("revalidates expired proof before the maintenance finalizer commits", async () => {
  const f = maintenanceFixture();
  const plan = await maintenancePlan(f);
  const database = openDatabase(f.options);
  const retained = observeRetainedMaintenanceFinalizer(f.databasePath);
  const probe = observeWorkerAdmission(f.databasePath, "cold");
  hooks.afterMaterialize = async () => {
    expect(cachedDatabase(f.options)).toBe(database);
    expect(validation(database)).toBeDefined();
    invalidateValidation(f.databasePath);
    revokeAdmission(f.databasePath);
    expect(database.db.isOpen).toBe(true);
  };
  const work = own(f.finalize([plan]));
  expect(await probe.expectPending(work), "expired proof validation owner").toBe("reclamation");
  retained.expectExpired(database);
  expect(readEntry(f.stale)?.sessionId).toBe("old");
  expect(readEvents(f.stale)).toEqual(f.events);
  await own(f.label("foreground"));
  expect(f.read()?.label).toBe("foreground");
  expect(readEntry(f.stale)?.sessionId).toBe("old");
  probe.release.resolve();
  await expect(work).resolves.toMatchObject({ capped: 1 });
  retained.expectExpired(database);
  expectMaintenanceArchived(f);
  await own(probe.expectHealthy({ executor: 1, reclamation: 1, other: 0 }));
});

it("rechecks maintenance lifetime after cold finalizer admission", async () => {
  const f = maintenanceFixture();
  const plan = await maintenancePlan(f);
  const probe = observeWorkerAdmission(f.databasePath, "cold");
  hooks.afterMaterialize = async () => {
    await closeForIntegrityAdmission(f);
  };
  let current = true;
  const work = own(
    f.finalize([plan], {
      isCurrent: () => current,
    }),
  );
  expect(await probe.expectPending(work), "cold validation owner").toBe("reclamation");
  current = false;
  probe.release.resolve();
  await expect(work).resolves.toMatchObject({ capped: 0, archivedTranscripts: [] });
  // The transcript postcondition reopens a writable reader and may validate on the caller.
  await own(probe.expectHealthy({ executor: 0, reclamation: 1, other: 0 }));
  expect(readEntry(f.stale)?.sessionId).toBe("old");
  expect(readEvents(f.stale)).toEqual(f.events);
});

it.each([false, true])(
  "rechecks native deletion ownership after cold maintenance admission (revoked: %s)",
  async (revoked) => {
    const f = maintenanceFixture(true);
    const plan = await maintenancePlan(f);
    const commit = vi.fn();
    const rollback = vi.fn();
    const registry = nativeRegistry(
      "maintenance-native",
      () => closeForIntegrityAdmission(f),
      commit,
      rollback,
    );
    const probe = observeWorkerAdmission(f.databasePath, "cold");
    const work = own(withRegistry(registry, () => f.finalize([plan])));
    await probe.expectPending(work);
    expect(commit).not.toHaveBeenCalled();
    if (revoked) {
      markPluginRegistryRetired(registry);
    }
    probe.release.resolve();
    await expect(work).resolves.toMatchObject({ capped: revoked ? 0 : 1 });
    expect(commit).toHaveBeenCalledTimes(revoked ? 0 : 1);
    expect(rollback).not.toHaveBeenCalled();
    await own(probe.expectHealthy({ executor: 1, reclamation: 0, other: 0 }));
    if (revoked) {
      expect(readEntry(f.stale)?.sessionId).toBe("old");
      expect(readEvents(f.stale)).toEqual(f.events);
    } else {
      expectMaintenanceArchived(f);
    }
  },
);
