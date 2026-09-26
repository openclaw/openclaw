import { linkSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import * as databaseIdentity from "../infra/sqlite-worker-identity.js";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createOpenClawStateDatabaseAsyncLifecycle } from "./openclaw-state-db-async-lifecycle.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPath,
  publishOpenClawStateDatabaseWorkerAdmission,
} from "./openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { withOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
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
