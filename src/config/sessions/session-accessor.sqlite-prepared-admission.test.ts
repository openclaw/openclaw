import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import * as sqlite from "../../infra/node-sqlite.js";
import * as integrity from "../../infra/sqlite-integrity-worker.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEventsSync,
  replaceSessionEntrySync,
  replaceTranscriptEventsSync,
} from "./session-accessor.js";
import type { SessionEntryLifecycleMutationResult } from "./session-accessor.sqlite-contract.js";
import {
  applySessionEntryLifecycleMutation,
  applySessionEntryReplacements,
  applySessionStoreProjection,
} from "./session-accessor.sqlite-projection.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";

const hooks = vi.hoisted(() => ({
  fork: undefined as ((child: ChildProcess) => void) | undefined,
  afterMaterialize: undefined as (() => Promise<void>) | undefined,
}));
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
const realOpen = sqlite.openNodeSqliteDatabase;
const realIntegrity = integrity.assertSqliteIntegrityInWorker;

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

function observeAdmission(databasePath: string, hold = false) {
  let parentChecks = 0;
  let admissions = 0;
  let settled = 0;
  let forkingIntegrity = false;
  const entered = createDeferred();
  const release = createDeferred();
  releases.push(() => release.resolve());
  if (!hold) {
    release.resolve();
  }
  const children: Array<{
    closed: boolean;
    code: number | null;
    signal: string | null;
    phases: integrity.SqliteIntegrityWorkerPhase[];
    resultOk?: boolean;
  }> = [];
  hooks.fork = (child) => {
    if (!forkingIntegrity) {
      return;
    }
    const row = {
      closed: false,
      code: null as number | null,
      signal: null as string | null,
      phases: [] as integrity.SqliteIntegrityWorkerPhase[],
      resultOk: undefined as boolean | undefined,
    };
    children.push(row);
    child.on("message", (message: integrity.SqliteIntegrityWorkerMessage) => {
      if ("type" in message) {
        row.phases.push(message.phase);
      } else {
        row.resultOk = message.ok;
      }
    });
    void own(
      new Promise<void>((resolve) => {
        child.once("close", (code, signal) => {
          row.closed = true;
          row.code = code;
          row.signal = signal;
          resolve();
        });
      }),
    );
  };
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((pathname, options) => {
    const database = realOpen(pathname, options);
    if (pathname !== databasePath || options?.readOnly) {
      return database;
    }
    const prepare = database.prepare.bind(database);
    database.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql === "PRAGMA integrity_check;") {
        const all = statement.all.bind(statement);
        statement.all = () => {
          parentChecks += 1;
          return all();
        };
      }
      return statement;
    };
    return database;
  });
  vi.spyOn(integrity, "assertSqliteIntegrityInWorker").mockImplementation(async (...args) => {
    if (args[0] !== databasePath) {
      return await realIntegrity(...args);
    }
    admissions += 1;
    let check: Promise<void>;
    forkingIntegrity = true;
    try {
      check = realIntegrity(...args);
    } finally {
      forkingIntegrity = false;
    }
    entered.resolve();
    try {
      await Promise.all([check, release.promise]);
    } finally {
      settled += 1;
    }
  });
  return {
    release,
    async expectPending(operation: Promise<unknown>) {
      expect(
        await Promise.race([
          entered.promise.then(() => "child"),
          operation.then(
            () => "completed",
            () => "failed",
          ),
        ]),
      ).toBe("child");
    },
    expectHealthy(count: number) {
      expect(parentChecks, "integrity ran on the caller thread").toBe(0);
      expect(admissions).toBe(count);
      expect(settled).toBe(count);
      expect(children).toHaveLength(count);
      for (const child of children) {
        expect(child).toEqual({
          closed: true,
          code: 0,
          signal: null,
          resultOk: true,
          phases: ["opening", "checking", "closing"],
        });
      }
    },
  };
}

const cases = (["whole-store", "lifecycle", "replacement"] as const).flatMap((owner) =>
  (["warm", "cold-preparation", "cold-commit"] as const).map((mode) => ({ owner, mode })),
);

it.each(cases)(
  "keeps $owner $mode validation and callback order inside the writer FIFO",
  async ({ owner, mode }) => {
    const f = fixture();
    if (mode === "cold-preparation") {
      expect(closeOpenClawAgentDatabaseByPath(f.databasePath)).toBe(true);
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
        expect(closeOpenClawAgentDatabaseByPath(f.databasePath)).toBe(true);
      }
    };
    const operation = own<string | SessionEntryLifecycleMutationResult>(
      owner === "whole-store"
        ? applySessionStoreProjection({
            storePath: f.databasePath,
            skipMaintenance: true,
            update: async (store) => {
              await update();
              store[f.input.sessionKey]!.label = "updated";
              return { persist: true, result: "done" };
            },
          })
        : owner === "replacement"
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
    expect(callbacks).toBe(mode === "cold-preparation" ? 0 : 1);
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
    probe.expectHealthy(mode === "warm" ? 0 : 1);
  },
);

it.each(["persist-false", "unchanged", "empty-replacements", "missing-replacement"] as const)(
  "does not reopen a disposed handle for a $0 result-only commit",
  async (mode) => {
    const f = fixture();
    const probe = observeAdmission(f.databasePath);
    let callbacks = 0;
    const close = () => {
      callbacks += 1;
      expect(closeOpenClawAgentDatabaseByPath(f.databasePath)).toBe(true);
    };
    const operation =
      mode === "persist-false" || mode === "unchanged"
        ? applySessionStoreProjection({
            storePath: f.databasePath,
            skipMaintenance: true,
            update: (store) => {
              close();
              if (mode === "persist-false") {
                delete store[f.input.sessionKey];
              }
              return { persist: mode !== "persist-false", result: "no-op" };
            },
          })
        : applySessionEntryReplacements({
            storePath: f.databasePath,
            sessionKeys: [
              mode === "missing-replacement" ? "agent:main:missing" : f.input.sessionKey,
            ],
            skipMaintenance: true,
            update: () => {
              close();
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
  "preserves replacement $0 error ordering across a cold commit",
  async (mode) => {
    const f = fixture();
    const probe = observeAdmission(f.databasePath);
    const denied = new Error("synthetic replacement denied");
    const guard = vi.fn(() => {
      throw denied;
    });
    const update = vi.fn(
      (entries: Parameters<Parameters<typeof applySessionEntryReplacements>[0]["update"]>[0]) => {
        if (mode === "stale") {
          replaceSessionEntrySync(f.input, {
            sessionId: "original",
            label: "newer",
            updatedAt: Date.now(),
          });
        }
        expect(closeOpenClawAgentDatabaseByPath(f.databasePath)).toBe(true);
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
    if (mode === "denied") {
      await expect(work).rejects.toBe(denied);
    } else {
      await expect(work).rejects.toThrow(
        mode === "selection" ? "outside the selected key set" : "changed before replacement",
      );
    }
    expect(update).toHaveBeenCalledOnce();
    expect(guard).toHaveBeenCalledTimes(mode === "denied" ? 1 : 0);
    probe.expectHealthy(mode === "selection" ? 0 : 1);
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
      expect(closeOpenClawAgentDatabaseByPath(f.databasePath)).toBe(true);
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
      expect(closeOpenClawAgentDatabaseByPath(f.databasePath)).toBe(true);
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

it("reacquires the split lifecycle commit after real archive materialization", async () => {
  const f = fixture();
  const transcript = seedTranscript(f);
  const probe = observeAdmission(f.databasePath, true);
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
    expect(closeOpenClawAgentDatabaseByPath(f.databasePath)).toBe(true);
  };
  const work = own(
    applySessionEntryLifecycleMutation({
      storePath: f.databasePath,
      skipMaintenance: true,
      removals: [{ sessionKey: f.input.sessionKey, archiveRemovedTranscript: true }],
    }),
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
  expect(loadSessionEntryReadOnly(f.input)?.sessionId).toBe("original");
  probe.release.resolve();
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
  probe.expectHealthy(1);
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
      expect(closeOpenClawAgentDatabaseByPath(f.databasePath)).toBe(true);
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
        applySessionStoreProjection({
          storePath: f.databasePath,
          skipMaintenance: true,
          update: (store) => {
            delete store[f.input.sessionKey];
            return { persist: true, result: "deleted" };
          },
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
      await expect(work).resolves.toBe("deleted");
    }
    await later;
    expect(prepare).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledTimes(revoked ? 0 : 1);
    expect(rollback).not.toHaveBeenCalled();
    probe.expectHealthy(1);
    expect(loadSessionEntryReadOnly(f.input)?.sessionId).toBe(revoked ? "original" : undefined);
  },
);
