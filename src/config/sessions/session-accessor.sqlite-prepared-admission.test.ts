import fs from "node:fs";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { WorkerOptions } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { closeCachedOpenClawAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  getOpenClawAgentDatabaseValidation,
  invalidateOpenClawAgentDatabaseValidation,
} from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { clearOpenClawAgentIntegrityVerification } from "../../state/openclaw-quarantine-store.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEventsSync,
  replaceSessionEntrySync,
  replaceTranscriptEventsSync,
} from "./session-accessor.js";
import type { SessionEntryLifecycleMutationResult } from "./session-accessor.sqlite-contract.js";
import { withWorkerSqliteIntegrityCounter } from "./session-accessor.sqlite-integrity-counter.test-support.js";
import {
  applySessionEntryMaintenance,
  finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort,
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
  applySessionEntryLifecycleMutation,
  applySessionEntryReplacements,
} from "./session-accessor.sqlite-projection.js";
import {
  resolveSqliteScope,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";

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
  replaceSessionEntrySync(input, { sessionId: "original", updatedAt: Date.now() });
  const scope = resolveSqliteScope(input);
  const options = toDatabaseOptions(scope);
  const database = openOpenClawAgentDatabase(options);
  return { input, scope, options, databasePath: database.path };
}

type Fixture = ReturnType<typeof fixture>;

function closeForIntegrityAdmission(f: Fixture) {
  expect(closeOpenClawAgentDatabaseByPath(f.databasePath)).toBe(true);
  invalidateOpenClawAgentDatabaseValidation(f.databasePath);
  clearOpenClawAgentIntegrityVerification(f.databasePath, f.input.env);
}

async function closeWorkerForIntegrityAdmission(f: Fixture) {
  await closeOpenClawAgentDatabaseByPathAsync(f.databasePath);
  invalidateOpenClawAgentDatabaseValidation(f.databasePath);
  clearOpenClawAgentIntegrityVerification(f.databasePath, f.input.env);
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
      closeForIntegrityAdmission(f);
    }
    const probe = observeAdmission(f.databasePath);
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
        await closeWorkerForIntegrityAdmission(f);
      }
    };
    const operation = own<string | SessionEntryLifecycleMutationResult>(
      owner === "replacement"
        ? applySessionEntryReplacements({
            storePath: f.databasePath,
            sessionKeys: [f.input.sessionKey],
            skipMaintenance: true,
            update: async (entries) => {
              await update();
              return {
                replacements: entries.map(({ sessionKey, entry }) => ({
                  sessionKey,
                  entry: { ...entry, label: "updated" },
                })),
                result: "done",
              };
            },
          })
        : applySessionEntryLifecycleMutation({
            storePath: f.databasePath,
            skipMaintenance: true,
            upserts: [
              {
                sessionKey: f.input.sessionKey,
                buildEntry: async ({ currentEntry }) => {
                  await update();
                  if (!currentEntry) {
                    throw new Error("fixture entry missing");
                  }
                  return { ...currentEntry, label: "updated" };
                },
              },
            ],
          }),
    );
    expect(callbacks).toBe(0);
    const later = own(
      runExclusiveSqliteSessionWrite(
        f.scope,
        async () => {
          order.push("later");
          return loadSessionEntryReadOnly(f.input)?.label;
        },
        "session.transcript.batch",
      ),
    );
    await entered.promise;
    await yieldToEventLoop();
    expect(order).toEqual(["update"]);
    release.resolve();
    await operation;
    expect(await later).toBe("updated");
    expect(loadSessionEntryReadOnly(f.input)).toMatchObject({
      sessionId: "original",
      label: "updated",
    });
    expect(callbacks).toBe(1);
    expect(order).toEqual(["update", "later"]);
    probe.expectHealthy(owner === "replacement" || mode === "warm" ? 0 : 1);
  },
);

it.each(["empty-replacements", "missing-replacement"] as const)(
  "does not reopen a disposed handle for a $0 result-only commit",
  async (mode) => {
    const f = fixture();
    const probe = observeAdmission(f.databasePath);
    let callbacks = 0;
    const close = async () => {
      callbacks += 1;
      expect(await closeOpenClawAgentDatabaseByPathAsync(f.databasePath)).toBe(true);
    };
    const operation = applySessionEntryReplacements({
      storePath: f.databasePath,
      sessionKeys: [mode === "missing-replacement" ? "agent:main:missing" : f.input.sessionKey],
      skipMaintenance: true,
      update: async () => {
        await close();
        return {
          result: "no-op",
          ...(mode === "missing-replacement"
            ? {
                replacements: [
                  {
                    sessionKey: "agent:main:missing",
                    entry: { sessionId: "missing", updatedAt: 1 },
                  },
                ],
              }
            : {}),
        };
      },
    });
    await expect(own(operation)).resolves.toBe("no-op");
    expect(callbacks).toBe(1);
    expect(getOpenClawAgentDatabaseIfOpen(f.options)).toBeUndefined();
    probe.expectHealthy(0);
    expect(loadSessionEntryReadOnly(f.input)?.sessionId).toBe("original");
  },
);

it.each(["selection", "stale", "denied"] as const)(
  "refuses replacement $0 before an unauthorized worker commit",
  async (mode) => {
    const f = fixture();
    const probe = observeAdmission(f.databasePath);
    const denied = new Error("synthetic replacement denied");
    const guard = vi.fn(() => {
      throw denied;
    });
    const update = vi.fn(
      async (
        entries: Parameters<Parameters<typeof applySessionEntryReplacements>[0]["update"]>[0],
      ) => {
        if (mode === "stale") {
          replaceSessionEntrySync(f.input, {
            sessionId: "original",
            label: "newer",
            updatedAt: Date.now(),
          });
        }
        await closeWorkerForIntegrityAdmission(f);
        return {
          result: undefined,
          replacements: entries.map(({ entry, sessionKey }) => ({
            sessionKey: mode === "selection" ? "agent:main:outside-selection" : sessionKey,
            entry: { ...entry, label: "uncommitted" },
          })),
        };
      },
    );
    const work = own(
      applySessionEntryReplacements({
        storePath: f.databasePath,
        sessionKeys: [f.input.sessionKey],
        skipMaintenance: true,
        assertCommitAllowed: guard,
        update,
      }),
    );
    if (mode === "selection") {
      await expect(work).rejects.toThrow("outside the selected key set");
    } else {
      await expect(work).rejects.toBe(denied);
    }
    expect(update).toHaveBeenCalledOnce();
    expect(guard).toHaveBeenCalledTimes(mode === "selection" ? 0 : 1);
    probe.expectHealthy(0);
    expect(loadSessionEntryReadOnly(f.input)?.label).toBe(mode === "stale" ? "newer" : undefined);
  },
);

it("keeps lifecycle commit denial before its stale-row check after admission", async () => {
  const f = fixture();
  const probe = observeAdmission(f.databasePath);
  const denied = new Error("synthetic lifecycle denied");
  const guard = vi.fn(() => {
    throw denied;
  });
  const committed = vi.fn();
  const buildEntry = vi.fn(
    ({ currentEntry }: { currentEntry?: import("./types.js").SessionEntry }) => {
      replaceSessionEntrySync(f.input, {
        sessionId: "original",
        label: "newer",
        updatedAt: Date.now(),
      });
      closeForIntegrityAdmission(f);
      return { ...currentEntry!, label: "uncommitted" };
    },
  );
  const work = own(
    applySessionEntryLifecycleMutation({
      storePath: f.databasePath,
      skipMaintenance: true,
      beforeCommitInTransaction: guard,
      onLifecycleCommitted: committed,
      upserts: [{ sessionKey: f.input.sessionKey, buildEntry }],
    }),
  );
  await expect(work).rejects.toBe(denied);
  expect(buildEntry).toHaveBeenCalledOnce();
  expect(guard).toHaveBeenCalledOnce();
  expect(committed).not.toHaveBeenCalled();
  probe.expectHealthy(1);
  expect(loadSessionEntryReadOnly(f.input)?.label).toBe("newer");
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
  replaceSessionEntrySync(survivor, { sessionId: "survivor", updatedAt: Date.now() });
  const probe = observeAdmission(f.databasePath);
  const builder = vi.fn(
    ({ currentEntry }: { currentEntry?: import("./types.js").SessionEntry }) => {
      closeForIntegrityAdmission(f);
      return { ...currentEntry!, usageFamilySessionIds: ["original"] };
    },
  );
  await expect(
    own(
      applySessionEntryLifecycleMutation({
        storePath: f.databasePath,
        skipMaintenance: true,
        removals: [{ sessionKey: f.input.sessionKey, archiveRemovedTranscript: true }],
        upserts: [{ sessionKey: survivor.sessionKey, buildEntry: builder }],
      }),
    ),
  ).resolves.toMatchObject({ removedEntries: 1, archivedTranscriptDirectories: [] });
  expect(builder).toHaveBeenCalledOnce();
  probe.expectHealthy(1);
  expect(loadSessionEntryReadOnly(f.input)).toBeUndefined();
  expect(loadSessionEntryReadOnly(survivor)?.usageFamilySessionIds).toEqual(["original"]);
  expect(loadTranscriptEventsSync(transcript.scope)).toEqual(transcript.events);
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
    await runExclusiveSqliteSessionWrite(
      f.scope,
      async () => {
        preparationWriterRan = true;
      },
      "session.transcript.batch",
    );
    const cached = getOpenClawAgentDatabaseIfOpen(f.options);
    if (!cached) {
      throw new Error("Fixture lost its cached handle before materialization");
    }
    closeCachedOpenClawAgentDatabase(cached, { eviction: true });
    expect(cached.db.isOpen).toBe(false);
  };
  const work = own(
    applySessionEntryLifecycleMutation({
      storePath: f.databasePath,
      skipMaintenance: true,
      removals: [{ sessionKey: f.input.sessionKey, archiveRemovedTranscript: true }],
    }),
  );
  await admission.expectPending(work);
  let laterRan = false;
  const later = own(
    runExclusiveSqliteSessionWrite(
      f.scope,
      async () => {
        laterRan = true;
      },
      "session.transcript.batch",
    ),
  );
  await yieldToEventLoop();
  expect(laterRan).toBe(false);
  expect(preparationWriterRan).toBe(true);
  expect(loadSessionEntryReadOnly(f.input)?.sessionId).toBe("original");
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
  expect(loadSessionEntryReadOnly(f.input)).toBeUndefined();
  expect(loadTranscriptEventsSync(transcript.scope)).toEqual([]);
  // Cache eviction preserves the native admission and its completed integrity proof.
  probe.expectHealthy(0);
  expect(admission.count()).toBe(1);
});

it.each([false, true])(
  "rechecks native deletion ownership during split cold admission (revoked: %s)",
  async (revoked) => {
    const f = fixture();
    replaceSessionEntrySync(f.input, {
      sessionId: "original",
      updatedAt: Date.now(),
      agentHarnessId: "prepared-native",
      lifecycleRevision: "generation-1",
    });
    const registry = createEmptyPluginRegistry();
    const commit = vi.fn();
    const rollback = vi.fn();
    let preparationWriterRan = false;
    const prepare = vi.fn(async () => {
      await runExclusiveSqliteSessionWrite(
        f.scope,
        async () => {
          preparationWriterRan = true;
        },
        "session.transcript.batch",
      );
      const cached = getOpenClawAgentDatabaseIfOpen(f.options);
      if (!cached) {
        throw new Error("Fixture lost its cached handle before native deletion preparation");
      }
      // Evict the handle without revoking the lifecycle operation's captured execution owner.
      closeCachedOpenClawAgentDatabase(cached, { eviction: true });
      expect(cached.db.isOpen).toBe(false);
      invalidateOpenClawAgentDatabaseValidation(f.databasePath);
      clearOpenClawAgentIntegrityVerification(f.databasePath, f.input.env);
    });
    const harness: AgentHarness = {
      id: "prepared-native",
      label: "Prepared native test",
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
    const record = createPluginRecord({ id: "prepared-native-owner" });
    registry.plugins.push(record);
    registry.agentHarnesses.push({ harness, pluginId: record.id, source: "runtime" });
    markPluginRegistryActive(registry);
    const probe = observeAdmission(f.databasePath, true);
    const work = own(
      withPluginRuntimeRegistryScope(registry, () =>
        applySessionEntryLifecycleMutation({
          storePath: f.databasePath,
          skipMaintenance: true,
          removals: [{ sessionKey: f.input.sessionKey }],
        }),
      ),
    );
    await probe.expectPending(work);
    let laterRan = false;
    const later = own(
      runExclusiveSqliteSessionWrite(
        f.scope,
        async () => {
          laterRan = true;
        },
        "session.transcript.batch",
      ),
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
    probe.expectHealthy(1);
    expect(loadSessionEntryReadOnly(f.input)?.sessionId).toBe(revoked ? "original" : undefined);
  },
);

function maintenanceFixture(native = false) {
  const f = fixture();
  const stale = { ...f.input, sessionKey: "agent:main:subagent:maintenance-old", sessionId: "old" };
  replaceSessionEntrySync(stale, {
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
  expect(loadSessionEntryReadOnly(f.stale)).toBeUndefined();
  expect(loadSessionEntryReadOnly(f.input)?.sessionId).toBe("original");
  expect(loadTranscriptEventsSync(f.stale)).toEqual([]);
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
      await runExclusiveSqliteSessionWrite(
        f.scope,
        async () => {
          preparationWriterRan = true;
        },
        "session.transcript.batch",
      );
      if (cold) {
        await closeWorkerForIntegrityAdmission(f);
      }
    };
    const work = own<void | SessionEntryLifecycleMutationResult>(
      owner === "replacement"
        ? applySessionEntryReplacements({
            storePath: f.databasePath,
            sessionKeys: [f.input.sessionKey],
            skipMaintenance: false,
            update: (entries) => ({
              result: undefined,
              replacements: entries.map(({ entry, sessionKey }) => ({
                sessionKey,
                entry: { ...entry, label: "kept" },
              })),
            }),
          })
        : applySessionEntryLifecycleMutation({
            storePath: f.databasePath,
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
      expect(loadSessionEntryReadOnly(f.stale)?.sessionId).toBe("old");
      expect(loadSessionEntryReadOnly(f.input)?.label).toBe("kept");
      const later = own(
        applySessionEntryReplacements({
          storePath: f.databasePath,
          sessionKeys: [f.input.sessionKey],
          skipMaintenance: true,
          update: (entries) => ({
            result: undefined,
            replacements: entries.map(({ entry, sessionKey }) => ({
              sessionKey,
              entry: { ...entry, label: "foreground" },
            })),
          }),
        }),
      );
      // Validation has no writer permit; the finalizer acquires it for its native commit.
      await later;
      expect(preparationWriterRan).toBe(true);
      expect(loadSessionEntryReadOnly(f.input)?.label).toBe("foreground");
      expect(loadSessionEntryReadOnly(f.stale)?.sessionId).toBe("old");
      probe.release.resolve();
      await work;
    } else {
      await work;
    }
    expect(preparationWriterRan).toBe(true);
    expect(loadSessionEntryReadOnly(f.input)?.label).toBe(cold ? "foreground" : "kept");
    expectMaintenanceArchived(f);
    await probe.expectHealthy({ executor: cold ? 1 : 0, reclamation: cold ? 1 : 0, other: 0 });
  },
);

function maintenancePlan(f: ReturnType<typeof maintenanceFixture>) {
  return runOpenClawAgentWriteTransaction(
    (database) =>
      applySessionEntryMaintenance(database, {
        activeSessionKey: f.input.sessionKey,
        archiveDirectory: f.archiveDirectory,
        storePath: f.databasePath,
      }),
    f.options,
  );
}

it("revalidates expired proof before the maintenance finalizer commits", async () => {
  const f = maintenanceFixture();
  const plan = maintenancePlan(f);
  const database = openOpenClawAgentDatabase(f.options);
  const retained = observeRetainedMaintenanceFinalizer(f.databasePath);
  const probe = observeWorkerAdmission(f.databasePath, "cold");
  hooks.afterMaterialize = async () => {
    expect(getOpenClawAgentDatabaseIfOpen(f.options)).toBe(database);
    expect(getOpenClawAgentDatabaseValidation(database)).toBeDefined();
    invalidateOpenClawAgentDatabaseValidation(f.databasePath);
    clearOpenClawAgentIntegrityVerification(f.databasePath, f.input.env);
    expect(database.db.isOpen).toBe(true);
  };
  const work = own(
    finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(f.scope, [plan]),
  );
  expect(await probe.expectPending(work), "expired proof validation owner").toBe("reclamation");
  retained.expectExpired(database);
  expect(loadSessionEntryReadOnly(f.stale)?.sessionId).toBe("old");
  expect(loadTranscriptEventsSync(f.stale)).toEqual(f.events);
  await own(
    applySessionEntryReplacements({
      storePath: f.databasePath,
      sessionKeys: [f.input.sessionKey],
      skipMaintenance: true,
      update: (entries) => ({
        result: undefined,
        replacements: entries.map(({ entry, sessionKey }) => ({
          sessionKey,
          entry: { ...entry, label: "foreground" },
        })),
      }),
    }),
  );
  expect(loadSessionEntryReadOnly(f.input)?.label).toBe("foreground");
  expect(loadSessionEntryReadOnly(f.stale)?.sessionId).toBe("old");
  probe.release.resolve();
  await expect(work).resolves.toMatchObject({ capped: 1 });
  retained.expectExpired(database);
  expectMaintenanceArchived(f);
  await probe.expectHealthy({ executor: 1, reclamation: 1, other: 0 });
});

it("rechecks maintenance lifetime after cold finalizer admission", async () => {
  const f = maintenanceFixture();
  const plan = maintenancePlan(f);
  const probe = observeWorkerAdmission(f.databasePath, "cold");
  hooks.afterMaterialize = async () => {
    closeForIntegrityAdmission(f);
  };
  let current = true;
  const work = own(
    finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(f.scope, [plan], {
      isCurrent: () => current,
    }),
  );
  expect(await probe.expectPending(work), "cold validation owner").toBe("reclamation");
  current = false;
  probe.release.resolve();
  await expect(work).resolves.toMatchObject({ capped: 0, archivedTranscripts: [] });
  // The transcript postcondition reopens a writable reader and may validate on the caller.
  await probe.expectHealthy({ executor: 0, reclamation: 1, other: 0 });
  expect(loadSessionEntryReadOnly(f.stale)?.sessionId).toBe("old");
  expect(loadTranscriptEventsSync(f.stale)).toEqual(f.events);
});

it.each([false, true])(
  "rechecks native deletion ownership after cold maintenance admission (revoked: %s)",
  async (revoked) => {
    const f = maintenanceFixture(true);
    const plan = maintenancePlan(f);
    const registry = createEmptyPluginRegistry();
    const commit = vi.fn();
    const rollback = vi.fn();
    const harness: AgentHarness = {
      id: "maintenance-native",
      label: "Maintenance native test",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("unused test harness");
      },
      withSessionDeletion: async (params, run) => {
        closeForIntegrityAdmission(f);
        params.assertCurrent();
        return await run({ commit, rollback });
      },
    };
    const record = createPluginRecord({ id: "maintenance-native-owner" });
    registry.plugins.push(record);
    registry.agentHarnesses.push({ harness, pluginId: record.id, source: "runtime" });
    markPluginRegistryActive(registry);
    const probe = observeAdmission(f.databasePath, true);
    const work = own(
      withPluginRuntimeRegistryScope(registry, () =>
        finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(f.scope, [plan]),
      ),
    );
    await probe.expectPending(work);
    expect(commit).not.toHaveBeenCalled();
    if (revoked) {
      markPluginRegistryRetired(registry);
    }
    probe.release.resolve();
    await expect(work).resolves.toMatchObject({ capped: revoked ? 0 : 1 });
    expect(commit).toHaveBeenCalledTimes(revoked ? 0 : 1);
    expect(rollback).not.toHaveBeenCalled();
    probe.expectHealthy(1);
    if (revoked) {
      expect(loadSessionEntryReadOnly(f.stale)?.sessionId).toBe("old");
      expect(loadTranscriptEventsSync(f.stale)).toEqual(f.events);
    } else {
      expectMaintenanceArchived(f);
    }
  },
);
