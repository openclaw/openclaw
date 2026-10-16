import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { SQLITE_WORKER_PREPARE_COMMAND } from "../infra/sqlite-worker-contract.js";
import * as databaseIdentity from "../infra/sqlite-worker-identity.js";
import { runWithSqliteWorkerStateContext as runInContext } from "../infra/sqlite-worker-state-context.js";
import * as workerStore from "../infra/sqlite-worker-store.js";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createOpenClawDatabaseMaintenanceScope,
  createOpenClawStateDatabaseAsyncLifecycle,
} from "./openclaw-state-db-async-lifecycle.js";
import * as stateCache from "./openclaw-state-db-cache.js";
import {
  captureOpenClawStateDatabaseReadAdmission as captureAdmission,
  closeOpenClawStateDatabaseAsync as closeDatabases,
  closeOpenClawStateDatabaseByPath,
  publishOpenClawStateDatabaseWorkerAdmission as publishAdmission,
} from "./openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { withOpenClawStateDatabaseReadOnly as readOnly } from "./openclaw-state-db-readonly.js";
import { withExistingOpenClawStateSchema as withSchema } from "./openclaw-state-db-schema-policy.js";
import { openOpenClawStateDatabase as openDatabase } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  captureOpenClawStateWorkerContext as captureContext,
  prepareOpenClawStateReadSource,
} from "./openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { getOpenClawStateWorkerOwner as workerOwner } from "./openclaw-state-worker-owner.js";
import { runOpenClawStateWorkerOperation as runOperation } from "./openclaw-state-worker-store.js";
import { openExistingSqliteWorkerBackend as openBackend } from "./openclaw-state.worker.js";

const hostBirth: {
  paths: Set<string>;
  mode: "zero" | "changing" | "ctime" | undefined;
  relocated: boolean;
  ctimeAdvanceNs: bigint;
} = { paths: new Set(), mode: undefined, relocated: false, ctimeAdvanceNs: 0n };
const ignoresHostBirthtime = process.platform === "linux" || process.platform === "android";

function fixture(run: (fixture: ReturnType<typeof bindFixture>) => Promise<void>) {
  return withOpenClawTestState({ label: "read-admission" }, (state) => run(bindFixture(state)));
}

function bindFixture({ env, statePath }: OpenClawTestState) {
  return {
    statePath,
    databasePath: resolveOpenClawStateSqlitePath(env),
    context: (pathname?: string) => captureContext({ path: pathname, env }),
    open: (pathname?: string) => openDatabase({ path: pathname, env }),
    read: (pathname: string) => readOnly(() => "inspected", { path: pathname, env }),
    prepare: (pathname: string) => prepareOpenClawStateReadSource({ path: pathname, env }),
    store: (namespace: string) =>
      createPluginStateKeyedStore<string>("discord", { namespace, maxEntries: 1, env }),
    empty: (version?: number) => {
      const pathname = statePath("inspected.sqlite");
      const database = new DatabaseSync(pathname);
      if (version !== undefined) {
        database.exec(`PRAGMA user_version = ${version}`);
      }
      database.close();
      return pathname;
    },
  };
}

function relocate(inspectedPath: string, databasePath: string) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.renameSync(inspectedPath, databasePath);
}

afterEach(async () => {
  try {
    await closeDatabases();
  } finally {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    hostBirth.paths.clear();
    hostBirth.mode = undefined;
    hostBirth.relocated = false;
    hostBirth.ctimeAdvanceNs = 0n;
  }
});

function observeHostBirthtime(mode: typeof hostBirth.mode, paths: string[]): void {
  hostBirth.mode = mode;
  for (const pathname of paths) {
    hostBirth.paths.add(pathname);
    hostBirth.paths.add(
      path.join(fs.realpathSync.native(path.dirname(pathname)), path.basename(pathname)),
    );
  }
  if (!mode) {
    return;
  }
  const readStat = fs.statSync;
  const readFstat = fs.fstatSync;
  const selectedFiles = new Set<string>();
  for (const pathname of hostBirth.paths) {
    const file = readStat(pathname, { bigint: true, throwIfNoEntry: false });
    if (file) {
      selectedFiles.add(`${file.dev}:${file.ino}`);
    }
  }
  const applyBirthtime = (result: fs.Stats | fs.BigIntStats) => {
    if (mode === "ctime" && "ctimeNs" in result) {
      const ctimeNs = result.ctimeNs + hostBirth.ctimeAdvanceNs;
      Object.defineProperty(result, "ctimeNs", { value: ctimeNs });
      Object.defineProperty(result, "birthtimeNs", { value: ctimeNs });
    } else {
      Object.defineProperty(result, "birthtimeNs", {
        value: mode === "zero" ? 0n : hostBirth.relocated ? 2n : 1n,
      });
    }
  };
  vi.spyOn(fs, "statSync").mockImplementation((...args) => {
    const result = readStat(...args);
    if (result && args[1]?.bigint && hostBirth.paths.has(String(args[0]))) {
      selectedFiles.add(`${result.dev}:${result.ino}`);
      applyBirthtime(result);
    }
    return result;
  });
  vi.spyOn(fs, "fstatSync").mockImplementation((...args) => {
    const result = readFstat(...args);
    if (args[1]?.bigint && selectedFiles.has(`${result.dev}:${result.ino}`)) {
      applyBirthtime(result);
    }
    return result;
  });
  // Native-passthrough identity modules must observe the same builtin as this test.
  syncBuiltinESMExports();
}

// Coarse-timestamp filesystems (ext4 before Linux 6.13, CI overlays) keep ctime across a
// write or link within one clock tick; advance it explicitly so fallback birthtime moves.
function advanceHostCtime(): void {
  hostBirth.ctimeAdvanceNs += 1n;
}

it("permits a lazy native write after healthy peer changes when birthtime falls back to ctime", async () => {
  await fixture(async ({ open, statePath, context, prepare }) => {
    const pathname = open().path;
    await closeDatabases();
    const alias = statePath("same-file-alias.sqlite");
    observeHostBirthtime("ctime", [pathname, alias]);
    const before = fs.statSync(pathname, { bigint: true });
    const captured = context();
    const preparedRead = ignoresHostBirthtime ? prepare(pathname) : undefined;
    const backend = runInContext(captured, () =>
      openBackend(undefined, {
        databasePath: pathname,
        existingIdentity: captured.admission.identity.key,
      }),
    );
    try {
      await backend[SQLITE_WORKER_PREPARE_COMMAND]?.("config.health.patch");
      const peer = new DatabaseSync(pathname);
      peer.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`);
      peer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      peer.close();
      fs.linkSync(pathname, alias);
      advanceHostCtime();
      const after = fs.statSync(pathname, { bigint: true });
      expect(after.ino).toBe(before.ino);
      expect(after.birthtimeNs).not.toBe(before.birthtimeNs);
      const linked = captureAdmission(alias);
      expect(linked.identity.key).toBe(captured.admission.identity.key);
      expect(captured.admission.assertCurrent).not.toThrow();
      expect(linked.assertCurrent).not.toThrow();
      await withSchema({ path: pathname }, async () => {
        const current = preparedRead?.workerContext() ?? context();
        expect(
          runInContext(current, () =>
            backend.execute({
              type: "config.health.patch",
              input: {
                configPath: "/synthetic-ctime.json",
                patch: { last_observed_suspicious_signature: "healthy-peer" },
                expected: null,
                updatedAtMs: 100,
              },
            }),
          ),
        ).toBe(true);
        expect(captured.admission.identity.birthtime).toBe(
          ignoresHostBirthtime ? "0" : before.ctimeNs.toString(),
        );
        const database = open();
        expect(
          database.db
            .prepare(
              "SELECT last_observed_suspicious_signature FROM config_health_entries WHERE config_path = ?",
            )
            .get("/synthetic-ctime.json"),
        ).toEqual({ last_observed_suspicious_signature: "healthy-peer" });
      });
    } finally {
      await backend.close();
    }
  });
});

async function retainExistingReader(context: OpenClawStateWorkerContext) {
  // Actor admission and retirement do not require a domain schema in this inspection fixture.
  const store = await workerOwner().open(context, { existingOnly: true });
  expect(store).toBeDefined();
  return store!;
}

it.each(["native", "zero", "changing"] as const)(
  "joins a stale worker's retirement after same-inode relocation with %s birth timestamps",
  async (birth) => {
    await fixture(async ({ empty, databasePath, context: capture, store: keyedStore }) => {
      const inspectedPath = empty(0);
      const readIdentity = databaseIdentity.readDatabasePathIdentitySync;
      const retiredKey = readIdentity(inspectedPath).key;
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      observeHostBirthtime(birth === "native" ? undefined : birth, [inspectedPath, databasePath]);
      const context = capture(inspectedPath);
      const retained = await retainExistingReader(context);
      const actor = workerStore.getSqliteWorkerActorIdentity(retained);
      fs.renameSync(inspectedPath, databasePath);
      hostBirth.relocated = true;
      expect(readIdentity(databasePath).key).toBe(retiredKey);

      const retiring = createDeferredCore();
      const releaseRetirement = createDeferredCore();
      const retireActor = workerStore.retireSqliteWorkerActor;
      const retirement = vi
        .spyOn(workerStore, "retireSqliteWorkerActor")
        .mockImplementationOnce(async (identity) => {
          expect(identity).toBe(actor);
          retiring.resolve();
          await releaseRetirement.promise;
          await retireActor(identity);
        });
      const store = keyedStore("worker-inode-reuse");
      const registration = store.register("retained", "replacement");
      let settled = false;
      const settle = () => {
        settled = true;
      };
      void registration.then(settle, settle);
      try {
        await Promise.race([
          retiring.promise,
          registration.then(() => {
            throw new Error("Replacement bypassed actor retirement");
          }),
        ]);
        expect(settled).toBe(false);
        expect(context.admission.assertCurrent).toThrow(/admission changed/);
        releaseRetirement.resolve();
        await registration;
        await expect(store.lookup("retained")).resolves.toBe("replacement");
        expect(retirement).toHaveBeenCalledExactlyOnceWith(actor);
        expect(workerStore.isSqliteWorkerStoreAvailable(retained)).toBe(false);
        expect(fs.existsSync(inspectedPath)).toBe(false);
      } finally {
        releaseRetirement.resolve();
        await Promise.allSettled([registration]);
        retirement.mockRestore();
      }
    });
  },
);

it.each(["same scope", "different scope"] as const)(
  "refuses replacement from an active callback on a stale actor (%s)",
  async (ownership) => {
    await fixture(async ({ empty, context: capture, databasePath, store: keyedStore }) => {
      const inspectedPath = empty();
      const context = capture(inspectedPath);
      const retained = await retainExistingReader(context);
      const maintenance =
        ownership === "different scope" ? createOpenClawDatabaseMaintenanceScope() : undefined;
      const activeContext = maintenance ? maintenance.run(() => capture(inspectedPath)) : context;
      const store = keyedStore("active-replacement");
      const retiring = createDeferredCore();
      const retireActor = workerStore.retireSqliteWorkerActor;
      const retirement = vi
        .spyOn(workerStore, "retireSqliteWorkerActor")
        .mockImplementation((identity) => {
          retiring.resolve();
          return retireActor(identity);
        });
      let registration: Promise<unknown> | undefined;
      try {
        try {
          await runOperation(
            activeContext,
            async () => {
              relocate(inspectedPath, databasePath);
              registration = store.register("retained", "replacement");
              // Observe retirement to fail without stranding the callback on its own close.
              await expect(
                Promise.race([
                  registration.then(
                    () => ({ outcome: "written" }),
                    (error: unknown) => ({ outcome: "refused", error }),
                  ),
                  retiring.promise.then(() => ({ outcome: "retiring" })),
                ]),
              ).resolves.toMatchObject({
                outcome: "refused",
                error: {
                  code: "PLUGIN_STATE_OPEN_FAILED",
                  cause: { code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED" },
                },
              });
              expect(workerStore.isSqliteWorkerStoreAvailable(retained)).toBe(true);
            },
            { existingOnly: true },
          );
        } finally {
          await Promise.allSettled([registration]);
          retirement.mockRestore();
        }
        await store.register("retained", "replacement");
        await expect(store.lookup("retained")).resolves.toBe("replacement");
        expect(fs.existsSync(inspectedPath)).toBe(false);
      } finally {
        await maintenance?.close();
      }
    });
  },
);

it("reuses a current database actor across separate lexical schema scopes", async () => {
  await fixture(async ({ open, context }) => {
    const databasePath = open().path;
    await closeDatabases();
    const read = () =>
      withSchema({ path: databasePath }, () => retainExistingReader(context(databasePath)));
    const first = await read();
    const second = await read();
    expect(second).toBe(first);
    expect(workerStore.isSqliteWorkerStoreAvailable(first)).toBe(true);
  });
});

it("propagates an unexpected recorded-admission error without retiring the actor", async () => {
  await fixture(async ({ empty, context: makeContext }) => {
    const context = makeContext(empty());
    const capture = stateCache.captureOpenClawStateDatabaseReadAdmission;
    const failure = new Error("Unexpected database admission failure");
    let reject = false;
    const captureSpy = vi
      .spyOn(stateCache, "captureOpenClawStateDatabaseReadAdmission")
      .mockImplementationOnce((pathname) => {
        const admission = capture(pathname);
        return {
          ...admission,
          assertCurrent() {
            if (reject) {
              throw failure;
            }
            admission.assertCurrent();
          },
        };
      });
    const retained = await retainExistingReader(context);
    captureSpy.mockRestore();
    reject = true;
    try {
      await expect(workerOwner().open(context, { existingOnly: true })).rejects.toBe(failure);
      expect(workerStore.isSqliteWorkerStoreAvailable(retained)).toBe(true);
    } finally {
      reject = false;
    }
  });
});

it.each(["read", "refused-read", "closed-writer"] as const)(
  "admits a new target path when a retired %s physical database moves into it",
  async (kind) => {
    await fixture(
      async ({ empty, read: readPath, open, statePath, databasePath, store: keyedStore }) => {
        const inspectedPath = empty(
          kind === "refused-read" ? OPENCLAW_STATE_SCHEMA_VERSION + 1 : 0,
        );
        const retiredIdentity = databaseIdentity.readDatabasePathIdentitySync(inspectedPath);
        const read = () => readPath(inspectedPath);
        let assertRetiredAdmission: (() => void) | undefined;
        if (kind === "closed-writer") {
          open(inspectedPath);
          assertRetiredAdmission = captureAdmission(inspectedPath).assertCurrent;
          closeOpenClawStateDatabaseByPath(inspectedPath);
        } else if (kind === "refused-read") {
          expect(read).toThrow(/newer schema/);
        } else {
          expect(read()).toBe("inspected");
        }
        const retainedPath = statePath("retained-inode.sqlite");
        fs.renameSync(inspectedPath, retainedPath);
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        const canonicalTarget = path.join(
          fs.realpathSync.native(path.dirname(databasePath)),
          path.basename(databasePath),
        );
        let moved = false;
        const interceptOpen = () => {
          const dispatch = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
            this: Worker,
            message,
            ...args
          ) {
            dispatch.mockRestore();
            if (
              isRecord(message) &&
              message.type === "open" &&
              message.databasePath === canonicalTarget
            ) {
              // The target is absent at admission, then gets the real retained inode before native open.
              fs.renameSync(retainedPath, databasePath);
              if (kind !== "closed-writer") {
                fs.writeFileSync(databasePath, "");
              }
              expect(databaseIdentity.readDatabasePathIdentitySync(databasePath).key).toBe(
                retiredIdentity.key,
              );
              moved = true;
            }
            try {
              return this.postMessage(message, ...args);
            } finally {
              if (!moved) {
                interceptOpen();
              }
            }
          });
        };
        interceptOpen();
        const store = keyedStore("read-admission");
        await store.register("retained", "original");
        expect(moved).toBe(true);
        expect(fs.existsSync(inspectedPath)).toBe(false);
        await expect(store.lookup("retained")).resolves.toBe("original");
        if (assertRetiredAdmission) {
          expect(assertRetiredAdmission).toThrow(/admission changed/);
        }
      },
    );
  },
);

it("binds an in-flight first creation when a native alias publishes first", async () => {
  await fixture(async ({ databasePath, open }) => {
    const alias = path.join(path.dirname(databasePath), "alias.sqlite");
    const admission = captureAdmission(databasePath);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const created = new DatabaseSync(databasePath);
    created.close();
    fs.linkSync(databasePath, alias);

    open(alias);
    publishAdmission(admission);
    admission.assertCurrent();
  });
});

it("keeps live aliases when an earlier recorded path becomes a directory", async () => {
  await fixture(async ({ statePath }) => {
    const lifecycle = createOpenClawStateDatabaseAsyncLifecycle();
    const originalPath = statePath("original.sqlite");
    const retainedAlias = statePath("retained.sqlite");
    const newAlias = statePath("new-alias.sqlite");
    fs.writeFileSync(originalPath, "original");
    const original = lifecycle.capture(originalPath);
    fs.linkSync(originalPath, retainedAlias);
    const retained = lifecycle.capture(retainedAlias);
    fs.linkSync(originalPath, newAlias);
    fs.unlinkSync(originalPath);
    fs.mkdirSync(originalPath);

    const observed = lifecycle.capture(newAlias);
    expect(observed.identity.key).toBe(original.identity.key);
    expect(original.assertCurrent).toThrow(/admission changed/);
    retained.assertCurrent();
    observed.assertCurrent();
  });
});

it("keeps a replacement and its aliases sealed until file exclusion releases", async () => {
  await fixture(async ({ statePath }) => {
    const lifecycle = createOpenClawStateDatabaseAsyncLifecycle();
    const databasePath = statePath("replaced.sqlite");
    const alias = statePath("alias.sqlite");
    fs.writeFileSync(databasePath, "original");
    const original = lifecycle.capture(databasePath);
    const release = lifecycle.holdExclusion(databasePath);
    try {
      fs.renameSync(databasePath, statePath("retired.sqlite"));
      fs.writeFileSync(databasePath, "replacement");
      fs.linkSync(databasePath, alias);
      lifecycle.publish(databasePath);
      expect(() => lifecycle.capture(alias)).toThrow(/admission is closed/);
    } finally {
      release();
    }
    expect(original.assertCurrent).toThrow(/admission changed/);
    const replacement = lifecycle.capture(alias);
    expect(replacement.identity.key).not.toBe(original.identity.key);
    replacement.assertCurrent();
  });
});
