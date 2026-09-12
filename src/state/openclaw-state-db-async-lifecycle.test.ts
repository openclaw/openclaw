import { existsSync, linkSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import * as databaseIdentity from "../infra/sqlite-worker-identity.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { createOpenClawStateDatabaseAsyncLifecycle } from "./openclaw-state-db-async-lifecycle.js";
import {
  acquireOpenClawStateDatabaseFileExclusion,
  captureOpenClawStateDatabaseReadAdmission,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseByPathAsync,
  registerOpenClawStateDatabaseAsyncResource,
} from "./openclaw-state-db-cache.js";
import { openOpenClawStateReadConnection } from "./openclaw-state-db-read-connection.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function databasePath(name = "state") {
  return path.join(dirs.make("openclaw-async-drain-"), `${name}.sqlite`);
}

describe("canonical shared-state resource drainage", () => {
  it.each(["missing", "directory"] as const)(
    "keeps unrelated owners while closing a never-admitted %s path",
    async (kind) => {
      const pathname = databasePath(kind);
      if (kind === "directory") {
        mkdirSync(pathname);
        expect(() => captureOpenClawStateDatabaseReadAdmission(pathname)).toThrow(/regular file/);
        expect(() => openOpenClawStateDatabase({ path: pathname })).toThrow(
          /EISDIR|directory|open database/u,
        );
      }
      const owner = openOpenClawStateDatabase({ path: databasePath("retained") });
      const admission = captureOpenClawStateDatabaseReadAdmission(owner.path);
      const unregister = registerOpenClawStateDatabaseAsyncResource({
        async close(identity) {
          if (identity === undefined) {
            throw new Error("Unexpected global resource drain");
          }
          if (identity.key === admission.identity.key) {
            owner.db.close();
          }
        },
      });
      try {
        expect(closeOpenClawStateDatabaseByPath(pathname)).toBe(false);
        expect(await closeOpenClawStateDatabaseByPathAsync(pathname)).toBe(false);
        expect(owner.db.isOpen).toBe(true);
        admission.assertCurrent();
        expect(existsSync(pathname)).toBe(kind === "directory");
      } finally {
        unregister();
      }
    },
  );

  it("keeps first-creation admission when an alias supplies the physical identity", async () => {
    const lifecycle = createOpenClawStateDatabaseAsyncLifecycle();
    const pathname = databasePath();
    const alias = path.join(path.dirname(pathname), "created-alias.sqlite");
    const original = lifecycle.capture(pathname);
    expect(original.identity.key).toMatch(/^path:/);
    writeFileSync(pathname, "");
    linkSync(pathname, alias);
    const observed = lifecycle.capture(alias);
    expect(original.identity.key).toBe(observed.identity.key);
    lifecycle.publish(pathname);
    original.assertCurrent();
    observed.assertCurrent();
    const closing = lifecycle.close(alias, () => false);
    expect(original.assertCurrent).toThrow(/admission is closed/);
    await closing;
    expect(original.assertCurrent).toThrow(/admission changed/);
    expect(observed.assertCurrent).toThrow(/admission changed/);
  });

  it("shares recorded admission and closes native owners for one physical database", async () => {
    const pathname = databasePath();
    const original = openOpenClawStateDatabase({ path: pathname });
    const alias = path.join(path.dirname(pathname), "alias.sqlite");
    linkSync(pathname, alias);
    const originalAdmission = captureOpenClawStateDatabaseReadAdmission(pathname);
    const aliasAdmission = captureOpenClawStateDatabaseReadAdmission(alias);
    expect(aliasAdmission.identity.key).toBe(originalAdmission.identity.key);
    expect(aliasAdmission.databasePath).toBe(alias);
    const identityReads = vi.spyOn(databaseIdentity, "readDatabasePathIdentitySync");
    captureOpenClawStateDatabaseReadAdmission(pathname).assertCurrent();
    captureOpenClawStateDatabaseReadAdmission(alias).assertCurrent();
    expect(identityReads).not.toHaveBeenCalled();
    identityReads.mockRestore();
    const closed = vi.fn(async (_identity?: DatabasePathIdentity) => {});
    const unregister = registerOpenClawStateDatabaseAsyncResource({ close: closed });
    try {
      const closing = closeOpenClawStateDatabaseByPathAsync(alias);
      expect(originalAdmission.assertCurrent).toThrow(/admission is closed/);
      expect(aliasAdmission.assertCurrent).toThrow(/admission is closed/);
      await closing;
      expect(closed).toHaveBeenCalledWith(originalAdmission.identity);
      expect(original.db.isOpen).toBe(false);
    } finally {
      unregister();
    }
  });

  it.each(["path", "all", "restart"] as const)(
    "joins the native reader before %s retirement and invalidates old admissions",
    async (scope) => {
      const pathname = databasePath();
      const admitted = captureOpenClawStateDatabaseReadAdmission(pathname);
      const writer = openOpenClawStateDatabase({ path: pathname });
      // Successful native admission does not invalidate its own captured generation.
      admitted.assertCurrent();
      const reader = openOpenClawStateReadConnection(pathname, pathname);
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      const unregister = registerOpenClawStateDatabaseAsyncResource({
        async close(target) {
          if (target !== undefined && target.key !== admitted.identity.key) {
            return;
          }
          entered.resolve();
          await finish.promise;
          reader.close();
        },
      });
      const closing =
        scope === "path"
          ? closeOpenClawStateDatabaseByPathAsync(pathname)
          : scope === "all"
            ? closeOpenClawStateDatabaseAsync()
            : drainGlobalSingletonLifecycleState("restart");
      try {
        expect(admitted.assertCurrent).toThrow(/admission is closed/);
        await entered.promise;
        expect(writer.db.isOpen).toBe(true);
        expect(reader.database.db.isOpen).toBe(true);
        finish.resolve();
        await closing;
        expect(reader.database.db.isOpen).toBe(false);
        expect(writer.db.isOpen).toBe(false);
        expect(admitted.assertCurrent).toThrow(/admission changed/);
        captureOpenClawStateDatabaseReadAdmission(pathname).assertCurrent();
        const reopened = openOpenClawStateDatabase({ path: pathname });
        expect(reopened.db.isOpen).toBe(true);
      } finally {
        finish.resolve();
        await closing;
        unregister();
      }
    },
  );

  it("retains an unregistered multipath resource after failure and retries only requested paths", async () => {
    const first = openOpenClawStateDatabase({ path: databasePath("first") });
    const second = openOpenClawStateDatabase({ path: databasePath("second") });
    const firstReader = openOpenClawStateReadConnection(first.path, first.path);
    const secondReader = openOpenClawStateReadConnection(second.path, second.path);
    const firstIdentity = captureOpenClawStateDatabaseReadAdmission(first.path).identity;
    const secondIdentity = captureOpenClawStateDatabaseReadAdmission(second.path).identity;
    const failure = new Error("reader close incomplete");
    let failFirst = true;
    const close = vi.fn(async (target?: DatabasePathIdentity) => {
      if (target === undefined || target.key === firstIdentity.key) {
        if (failFirst) {
          throw failure;
        }
        firstReader.close();
      }
      if (target === undefined || target.key === secondIdentity.key) {
        secondReader.close();
      }
    });
    const unregister = registerOpenClawStateDatabaseAsyncResource({ close });
    try {
      await expect(closeOpenClawStateDatabaseByPathAsync(first.path)).rejects.toBe(failure);
      unregister();
      expect(first.db.isOpen).toBe(true);
      expect(firstReader.database.db.isOpen).toBe(true);
      expect(() => captureOpenClawStateDatabaseReadAdmission(first.path)).toThrow(/closed/);
      captureOpenClawStateDatabaseReadAdmission(second.path).assertCurrent();
      await closeOpenClawStateDatabaseByPathAsync(second.path);
      expect(close).toHaveBeenLastCalledWith(secondIdentity);
      expect(second.db.isOpen).toBe(false);
      expect(secondReader.database.db.isOpen).toBe(false);
      expect(firstReader.database.db.isOpen).toBe(true);
      failFirst = false;
      await closeOpenClawStateDatabaseByPathAsync(first.path);
      expect(firstReader.database.db.isOpen).toBe(false);
      expect(first.db.isOpen).toBe(false);
      captureOpenClawStateDatabaseReadAdmission(first.path).assertCurrent();
    } finally {
      failFirst = false;
      await closeOpenClawStateDatabaseAsync();
      unregister();
    }
  });

  it("coalesces pending closes and retains the read seal after a native close failure", async () => {
    const owner = openOpenClawStateDatabase({ path: databasePath() });
    const nativeClose = owner.db.close.bind(owner.db);
    const failure = new Error("native close incomplete");
    const close = vi.spyOn(owner.db, "close").mockImplementationOnce(() => {
      throw failure;
    });
    try {
      const first = closeOpenClawStateDatabaseByPathAsync(owner.path);
      expect(closeOpenClawStateDatabaseByPathAsync(owner.path)).toBe(first);
      await expect(first).rejects.toBe(failure);
      expect(owner.db.isOpen).toBe(true);
      expect(() => captureOpenClawStateDatabaseReadAdmission(owner.path)).toThrow(/closed/);
      close.mockImplementation(nativeClose);
      await closeOpenClawStateDatabaseByPathAsync(owner.path);
      expect(owner.db.isOpen).toBe(false);
      captureOpenClawStateDatabaseReadAdmission(owner.path).assertCurrent();
    } finally {
      close.mockRestore();
      await closeOpenClawStateDatabaseByPathAsync(owner.path);
    }
  });

  it("keeps worker admission sealed through exclusion and native binding until release", async () => {
    const owner = openOpenClawStateDatabase({ path: databasePath() });
    const identity = captureOpenClawStateDatabaseReadAdmission(owner.path).identity;
    const reader = openOpenClawStateReadConnection(owner.path, owner.path);
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    const unregister = registerOpenClawStateDatabaseAsyncResource({
      async close(target) {
        if (target === undefined || target.key === identity.key) {
          entered.resolve();
          await finish.promise;
          reader.close();
        }
      },
    });
    const acquiring = acquireOpenClawStateDatabaseFileExclusion(owner.path);
    let exclusion: Awaited<typeof acquiring> | undefined;
    try {
      expect(() => captureOpenClawStateDatabaseReadAdmission(owner.path)).toThrow(/closed/);
      await entered.promise;
      expect(reader.database.db.isOpen).toBe(true);
      finish.resolve();
      exclusion = await acquiring;
      expect(reader.database.db.isOpen).toBe(false);
      await exclusion.bindCaptured(exclusion.assertCurrent, () => {
        openOpenClawStateDatabase({ path: owner.path });
        expect(() => captureOpenClawStateDatabaseReadAdmission(owner.path)).toThrow(/closed/);
        return undefined;
      });
      expect(() => captureOpenClawStateDatabaseReadAdmission(owner.path)).toThrow(/closed/);
      exclusion.release();
      exclusion = undefined;
      captureOpenClawStateDatabaseReadAdmission(owner.path).assertCurrent();
    } finally {
      finish.resolve();
      exclusion ??= await acquiring;
      exclusion.release();
      unregister();
    }
  });
});
