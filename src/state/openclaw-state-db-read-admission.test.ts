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
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createOpenClawDatabaseMaintenanceScope,
  createOpenClawStateDatabaseAsyncLifecycle,
} from "./openclaw-state-db-async-lifecycle.js";
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
      using database = new DatabaseSync(pathname);
      if (version !== undefined) {
        database.exec(`PRAGMA user_version = ${version}`);
      }
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
  }
});

function observeHostBirthtime(pathname: string) {
  const readStat = fs.statSync;
  const readFstat = fs.fstatSync;
  const file = readStat(pathname, { bigint: true });
  let advanceNs = 0n;
  const applyBirthtime = <T extends fs.Stats | fs.BigIntStats | undefined>(result: T): T => {
    if (result && "ctimeNs" in result && result.dev === file.dev && result.ino === file.ino) {
      const ctimeNs = result.ctimeNs + advanceNs;
      Object.defineProperties(result, {
        ctimeNs: { value: ctimeNs },
        birthtimeNs: { value: ctimeNs },
      });
    }
    return result;
  };
  vi.spyOn(fs, "statSync").mockImplementation((...args) => applyBirthtime(readStat(...args)));
  vi.spyOn(fs, "fstatSync").mockImplementation((...args) => applyBirthtime(readFstat(...args)));
  // Native-passthrough identity modules must observe the same builtin as this test.
  syncBuiltinESMExports();
  return () => {
    advanceNs += 1n;
  };
}

it("permits a lazy native write after healthy peer changes when birthtime falls back to ctime", async () => {
  await fixture(async ({ open, statePath, context, prepare }) => {
    const pathname = open().path;
    await closeDatabases();
    const alias = statePath("same-file-alias.sqlite");
    const advanceCtime = observeHostBirthtime(pathname);
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
      {
        using peer = new DatabaseSync(pathname);
        peer.exec(
          `PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}; PRAGMA wal_checkpoint(TRUNCATE)`,
        );
      }
      fs.linkSync(pathname, alias);
      // Advance coarse filesystem timestamps so the ctime birthtime fallback moves.
      advanceCtime();
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
      let registration: Promise<unknown> | undefined;
      try {
        try {
          await runOperation(
            activeContext,
            async () => {
              relocate(inspectedPath, databasePath);
              registration = store.register("retained", "replacement");
              await expect(registration).rejects.toMatchObject({
                code: "PLUGIN_STATE_OPEN_FAILED",
                cause: { code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED" },
              });
              expect(workerStore.isSqliteWorkerStoreAvailable(retained)).toBe(true);
            },
            { existingOnly: true },
          );
        } finally {
          await Promise.allSettled([registration]);
        }
        await closeDatabases();
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
        // oxlint-disable-next-line typescript/unbound-method -- Called below with its original receiver.
        const postMessage = Worker.prototype.postMessage;
        const dispatch = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
          this: Worker,
          message,
          ...args
        ) {
          if (
            isRecord(message) &&
            message.type === "open" &&
            message.databasePath === canonicalTarget
          ) {
            dispatch.mockRestore();
            // The target is absent at admission, then gets the retained inode before native open.
            fs.renameSync(retainedPath, databasePath);
            if (kind !== "closed-writer") {
              fs.writeFileSync(databasePath, "");
            }
            expect(databaseIdentity.readDatabasePathIdentitySync(databasePath).key).toBe(
              retiredIdentity.key,
            );
            moved = true;
          }
          return postMessage.call(this, message, ...args);
        });
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
