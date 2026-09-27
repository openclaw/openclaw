import { existsSync, linkSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import * as databaseIdentity from "../infra/sqlite-worker-identity.js";
import * as workerStore from "../infra/sqlite-worker-store.js";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createOpenClawStateDatabaseAsyncLifecycle } from "./openclaw-state-db-async-lifecycle.js";
import * as stateCache from "./openclaw-state-db-cache.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPath,
  publishOpenClawStateDatabaseWorkerAdmission,
} from "./openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { withOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { withExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { getOpenClawStateWorkerOwner } from "./openclaw-state-worker-owner.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

async function retainExistingReader(context: OpenClawStateWorkerContext) {
  await expect(
    runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({
          type: "plugins.metadata.read",
          input: { selector: "installed-index", artifactPreservingReadOnly: true },
        }),
      { existingOnly: true },
    ),
  ).resolves.toBeUndefined();
  const store = await getOpenClawStateWorkerOwner().open(context, { existingOnly: true });
  expect(store).toBeDefined();
  return store!;
}

it.each(["native", "zero", "changing"] as const)(
  "joins a stale worker's retirement after inode reuse with %s birth timestamps",
  async (birth) => {
    await withOpenClawTestState({ label: "state-worker-inode-reuse" }, async (state) => {
      const inspectedPath = state.statePath("inspected.sqlite");
      const inspected = new DatabaseSync(inspectedPath);
      inspected.exec("PRAGMA user_version = 0");
      inspected.close();
      const databasePath = resolveOpenClawStateSqlitePath(state.env);
      const readIdentity = databaseIdentity.readDatabasePathIdentitySync;
      const retiredKey = readIdentity(inspectedPath).key;
      let observedBirth = 1n;
      // Fix the allocator's reused-inode outcome, not the lifecycle decision.
      // Zero and changing values cannot act as a file-generation token.
      vi.spyOn(databaseIdentity, "readDatabasePathIdentitySync").mockImplementation((pathname) => {
        const identity = readIdentity(pathname);
        return {
          ...identity,
          key: pathname === databasePath ? retiredKey : identity.key,
          birthtime:
            birth === "zero"
              ? "0"
              : birth === "changing"
                ? (observedBirth++).toString()
                : identity.birthtime,
        };
      });
      const context = captureOpenClawStateWorkerContext({ path: inspectedPath, env: state.env });
      const retained = await retainExistingReader(context);
      const actor = workerStore.getSqliteWorkerActorIdentity(retained);
      unlinkSync(inspectedPath);
      mkdirSync(path.dirname(databasePath), { recursive: true });
      new DatabaseSync(databasePath).close();

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
      const store = createPluginStateKeyedStore<string>("discord", {
        namespace: "worker-inode-reuse",
        maxEntries: 1,
        env: state.env,
      });
      const registration = store.register("retained", "replacement");
      let settled = false;
      void registration.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
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
        expect(existsSync(inspectedPath)).toBe(false);
      } finally {
        releaseRetirement.resolve();
        await Promise.allSettled([registration]);
        retirement.mockRestore();
      }
    });
  },
);

it("reuses a current database actor across separate lexical schema scopes", async () => {
  await withOpenClawTestState({ label: "state-worker-schema-scope" }, async (state) => {
    const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
    await closeOpenClawStateDatabaseAsync();
    const read = () =>
      withExistingOpenClawStateSchema({ path: databasePath }, () =>
        retainExistingReader(
          captureOpenClawStateWorkerContext({ path: databasePath, env: state.env }),
        ),
      );
    const first = await read();
    const second = await read();
    expect(second).toBe(first);
    expect(workerStore.isSqliteWorkerStoreAvailable(first)).toBe(true);
  });
});

it("propagates an unexpected recorded-admission error without retiring the actor", async () => {
  await withOpenClawTestState({ label: "state-worker-admission-error" }, async (state) => {
    const databasePath = state.statePath("inspected.sqlite");
    new DatabaseSync(databasePath).close();
    const context = captureOpenClawStateWorkerContext({ path: databasePath, env: state.env });
    const capture = stateCache.captureOpenClawStateDatabaseReadAdmission;
    const failure = new Error("Unexpected database admission failure");
    let reject = false;
    const captureAdmission = vi
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
    captureAdmission.mockRestore();
    reject = true;
    try {
      await expect(
        getOpenClawStateWorkerOwner().open(context, { existingOnly: true }),
      ).rejects.toBe(failure);
      expect(workerStore.isSqliteWorkerStoreAvailable(retained)).toBe(true);
    } finally {
      reject = false;
    }
  });
});

it.each(["read", "refused-read", "closed-writer"] as const)(
  "admits worker creation after a %s file's inode is reused",
  async (kind) => {
    await withOpenClawTestState({ label: "state-read-admission" }, async (state) => {
      const inspectedPath = path.join(state.stateDir, "inspected.sqlite");
      const inspected = new DatabaseSync(inspectedPath);
      inspected.exec(
        `PRAGMA user_version = ${kind === "refused-read" ? OPENCLAW_STATE_SCHEMA_VERSION + 1 : 0}`,
      );
      inspected.close();
      const retiredIdentity = databaseIdentity.readDatabasePathIdentitySync(inspectedPath);
      const read = () =>
        withOpenClawStateDatabaseReadOnly(() => "inspected", {
          path: inspectedPath,
          env: state.env,
        });
      let assertRetiredAdmission: (() => void) | undefined;
      if (kind === "closed-writer") {
        openOpenClawStateDatabase({ path: inspectedPath, env: state.env });
        assertRetiredAdmission =
          captureOpenClawStateDatabaseReadAdmission(inspectedPath).assertCurrent;
        closeOpenClawStateDatabaseByPath(inspectedPath);
      } else if (kind === "refused-read") {
        expect(read).toThrow(/newer schema/);
      } else {
        expect(read()).toBe("inspected");
      }
      unlinkSync(inspectedPath);

      const databasePath = resolveOpenClawStateSqlitePath(state.env);
      const readIdentity = databaseIdentity.readDatabasePathIdentitySync;
      // Linux can reuse a deleted file's inode. Fix that allocator outcome while
      // keeping the real missing-path capture, worker open, and publication.
      vi.spyOn(databaseIdentity, "readDatabasePathIdentitySync").mockImplementation((pathname) => {
        const identity = readIdentity(pathname);
        return pathname === databasePath && identity.key.startsWith("file:")
          ? { ...identity, key: retiredIdentity.key }
          : identity;
      });
      const store = createPluginStateKeyedStore<string>("discord", {
        namespace: "read-admission",
        maxEntries: 1,
        env: state.env,
      });
      await store.register("retained", "original");
      await expect(store.lookup("retained")).resolves.toBe("original");
      if (assertRetiredAdmission) {
        expect(assertRetiredAdmission).toThrow(/admission changed/);
      }
    });
  },
);

it("binds an in-flight first creation when a native alias publishes first", async () => {
  await withOpenClawTestState({ label: "state-native-alias-admission" }, async (state) => {
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    const alias = path.join(path.dirname(databasePath), "alias.sqlite");
    const admission = captureOpenClawStateDatabaseReadAdmission(databasePath);
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const created = new DatabaseSync(databasePath);
    created.close();
    linkSync(databasePath, alias);

    openOpenClawStateDatabase({ path: alias, env: state.env });
    publishOpenClawStateDatabaseWorkerAdmission(admission);
    admission.assertCurrent();
  });
});

it("keeps live aliases when an earlier recorded path becomes a directory", async () => {
  await withOpenClawTestState({ label: "state-stale-alias-admission" }, async (state) => {
    const lifecycle = createOpenClawStateDatabaseAsyncLifecycle();
    const originalPath = state.statePath("original.sqlite");
    const retainedAlias = state.statePath("retained.sqlite");
    const newAlias = state.statePath("new-alias.sqlite");
    writeFileSync(originalPath, "original");
    const original = lifecycle.capture(originalPath);
    linkSync(originalPath, retainedAlias);
    const retained = lifecycle.capture(retainedAlias);
    linkSync(originalPath, newAlias);
    unlinkSync(originalPath);
    mkdirSync(originalPath);

    const observed = lifecycle.capture(newAlias);
    expect(observed.identity.key).toBe(original.identity.key);
    original.assertCurrent();
    retained.assertCurrent();
    observed.assertCurrent();
  });
});

it("keeps a replacement and its aliases sealed until file exclusion releases", async () => {
  await withOpenClawTestState({ label: "state-replacement-admission" }, async (state) => {
    const lifecycle = createOpenClawStateDatabaseAsyncLifecycle();
    const databasePath = state.statePath("replaced.sqlite");
    const alias = state.statePath("alias.sqlite");
    writeFileSync(databasePath, "original");
    const original = lifecycle.capture(databasePath);
    const release = lifecycle.holdExclusion(databasePath);
    try {
      renameSync(databasePath, state.statePath("retired.sqlite"));
      writeFileSync(databasePath, "replacement");
      linkSync(databasePath, alias);
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
