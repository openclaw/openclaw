import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createCoordinatorResourceTestHarness,
  resolveCoordinatorModuleUrl,
  runCoordinatorSource,
} from "./state-database-coordinator.resources.test-support.js";

const { createStandaloneOwner } = createCoordinatorResourceTestHarness();

describe("failed state coordinator acquisition", () => {
  it.each([false, true])(
    "retains both owners when native annotation fails (release also fails: %s)",
    (refuseRelease) => {
      const databaseOwner = createStandaloneOwner("openclaw-annotation-database-");
      const coordinatorOwner = createStandaloneOwner("openclaw-annotation-coordinator-");
      const result = runCoordinatorSource(
        `
        import fs from "node:fs";
        import path from "node:path";
        const { acquireStateDatabaseCoordinator } = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
        const { closeIdleSqliteCoordinators } = await import(${JSON.stringify(
          pathToFileURL(path.join(import.meta.dirname, "sqlite-coordinator.ts")).href,
        )});
        const databaseRoot = ${JSON.stringify(databaseOwner.ownedRoot)};
        const coordinatorRoot = ${JSON.stringify(coordinatorOwner.ownedRoot)};
        const coordinatorPath = path.join(coordinatorRoot, "lock.sqlite");
        const annotationError = new Error("native annotation refused");
        const releaseError = new Error("annotation compensation refused");
        const nativeWrite = fs.writeFileSync;
        fs.writeFileSync = function(file, ...args) {
          if (String(file).startsWith(coordinatorRoot + path.sep)) {
            if (path.basename(String(file)) === "native-worker") throw annotationError;
            if (${refuseRelease} && path.basename(String(file)) === "released") throw releaseError;
          }
          return nativeWrite.call(this, file, ...args);
        };
        const receipts = root => {
          const claims = path.join(root, ".vitest-resource-owner", "claims");
          return fs.readdirSync(claims).map(id => ({
            released: fs.existsSync(path.join(claims, id, "released")),
            nativeExited: fs.existsSync(path.join(claims, id, "native-exited")),
          }));
        };
        let observed;
        let beforeRetry;
        let retryError;
        try {
          try {
            acquireStateDatabaseCoordinator({
              databasePath: path.join(databaseRoot, "state.sqlite"), coordinatorPath,
            });
          } catch (error) { observed = error; }
          beforeRetry = { database: receipts(databaseRoot), coordinator: receipts(coordinatorRoot) };
          try { closeIdleSqliteCoordinators(coordinatorRoot); }
          catch (error) { retryError = error; }
        } finally { fs.writeFileSync = nativeWrite; }
        closeIdleSqliteCoordinators(path.join(databaseRoot, "unrelated"));
        const wrongScope = { database: receipts(databaseRoot), coordinator: receipts(coordinatorRoot) };
        closeIdleSqliteCoordinators(databaseRoot);
        console.log(JSON.stringify({
          originalPreserved: observed === annotationError || observed?.cause === annotationError,
          cleanupPreserved: observed instanceof AggregateError && observed.errors.includes(releaseError),
          retryRefused: retryError === releaseError,
          noNativeAllocation: !fs.existsSync(coordinatorPath), beforeRetry, wrongScope,
          afterRetry: { database: receipts(databaseRoot), coordinator: receipts(coordinatorRoot) },
        }));
        `,
        {
          VITEST_OPENCLAW_RESOURCE_ROOT: databaseOwner.ownedRoot,
          VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
            { root: databaseOwner.ownedRoot, identity: databaseOwner.owner.identity },
            { root: coordinatorOwner.ownedRoot, identity: coordinatorOwner.owner.identity },
          ]),
        },
      );
      const pending = [{ released: !refuseRelease, nativeExited: false }];
      const released = [{ released: true, nativeExited: false }];
      expect(result).toEqual({
        originalPreserved: true,
        cleanupPreserved: refuseRelease,
        retryRefused: refuseRelease,
        noNativeAllocation: true,
        beforeRetry: { database: pending, coordinator: pending },
        wrongScope: { database: pending, coordinator: pending },
        afterRetry: { database: released, coordinator: released },
      });
      expect(() => databaseOwner.owner.assertReleased()).not.toThrow();
      expect(() => coordinatorOwner.owner.assertReleased()).not.toThrow();
    },
  );

  it.each(["open", "acquisition", "close"])(
    "settles failed %s custody only after native acquisition cleanup succeeds",
    (failure) => {
      const { ownedRoot, owner } = createStandaloneOwner("openclaw-coordinator-acquire-failure-");
      const result = runCoordinatorSource(
        `
        import fs from "node:fs";
        import path from "node:path";
        import { DatabaseSync } from "node:sqlite";
        const coordinatorModule = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
        const { closeIdleSqliteCoordinators } = await import(${JSON.stringify(
          pathToFileURL(path.join(import.meta.dirname, "sqlite-coordinator.ts")).href,
        )});
        // Validate the SQLite runtime before injecting failure into the target handle's close.
        const { requireNodeSqlite } = await import(${JSON.stringify(
          pathToFileURL(path.join(import.meta.dirname, "node-sqlite.ts")).href,
        )});
        requireNodeSqlite();
        const root = ${JSON.stringify(ownedRoot)};
        const failure = ${JSON.stringify(failure)};
        const coordinatorPath = path.join(root, "invalid.sqlite");
        if (failure === "open") fs.mkdirSync(coordinatorPath);
        const blocker = failure === "open" ? undefined : new DatabaseSync(coordinatorPath);
        blocker?.exec("PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE");
        const nativeClose = DatabaseSync.prototype.close;
        let database;
        const refused = new Error("native acquisition close refused");
        DatabaseSync.prototype.close = function() {
          database = this;
          if (failure === "close") throw refused;
          return nativeClose.call(this);
        };
        const claims = path.join(root, ".vitest-resource-owner", "claims");
        const receipts = () => fs.readdirSync(claims).map(id => fs.existsSync(path.join(claims, id, "released")));
        let observed;
        let beforeRetry;
        let openBeforeRetry;
        try {
          try {
            coordinatorModule.acquireStateDatabaseCoordinator({
              databasePath: path.join(root, "state.sqlite"), coordinatorPath, busyTimeoutMs: 0,
            });
          } catch (error) { observed = error; }
          beforeRetry = receipts();
          openBeforeRetry = database?.isOpen ?? false;
        } finally {
          DatabaseSync.prototype.close = nativeClose;
          blocker?.close();
          closeIdleSqliteCoordinators(root);
        }
        console.log(JSON.stringify({
          message: observed?.message,
          acquisitionMessage: observed?.cause?.message,
          closePreserved: observed instanceof AggregateError && observed.errors.includes(refused),
          beforeRetry, openBeforeRetry, afterRetry: receipts(), openAfterRetry: database?.isOpen ?? false,
        }));
      `,
        {
          VITEST_OPENCLAW_RESOURCE_ROOT: ownedRoot,
          VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
            { root: ownedRoot, identity: owner.identity },
          ]),
        },
      );
      expect(result).toMatchObject({
        beforeRetry: [failure !== "close"],
        openBeforeRetry: failure === "close",
        afterRetry: [true],
        openAfterRetry: false,
        closePreserved: failure === "close",
      });
      if (failure === "close") {
        expect(result.message).toBe("SQLite coordinator acquisition and cleanup both failed");
        expect(result.acquisitionMessage).toContain("locked");
      } else {
        expect(result.message).toContain(
          failure === "open" ? "unable to open" : "another OpenClaw process owns",
        );
      }
      expect(() => owner.assertReleased()).not.toThrow();
    },
  );

  it.each(["open", "directory"])(
    "retries failed receipt publication after %s failure without a native handle",
    (failure) => {
      const { ownedRoot, owner } = createStandaloneOwner("openclaw-no-handle-receipt-");
      const result = runCoordinatorSource(
        `
        import fs from "node:fs";
        import path from "node:path";
        const coordinatorModule = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
        const { closeIdleSqliteCoordinators } = await import(${JSON.stringify(
          pathToFileURL(path.join(import.meta.dirname, "sqlite-coordinator.ts")).href,
        )});
        const root = ${JSON.stringify(ownedRoot)};
        const failure = ${JSON.stringify(failure)};
        const target = path.join(root, "invalid");
        if (failure === "open") fs.mkdirSync(target);
        else fs.writeFileSync(target, "not a directory");
        const coordinatorPath = failure === "open" ? target : path.join(target, "lock.sqlite");
        const claims = path.join(root, ".vitest-resource-owner", "claims");
        const receipts = () => fs.readdirSync(claims).map(id => fs.existsSync(path.join(claims, id, "released")));
        const nativeWrite = fs.writeFileSync;
        const refused = new Error("release receipt refused");
        fs.writeFileSync = function(file, ...args) {
          if (path.basename(String(file)) === "released") throw refused;
          return nativeWrite.call(this, file, ...args);
        };
        let observed;
        let beforeRetry;
        let wrongScope;
        let retryRefused = false;
        try {
          try {
            coordinatorModule.acquireStateDatabaseCoordinator({
              databasePath: path.join(root, "state.sqlite"), coordinatorPath, busyTimeoutMs: 0,
            });
          } catch (error) { observed = error; }
          beforeRetry = receipts();
          try { closeIdleSqliteCoordinators(root); } catch (error) { retryRefused = error === refused; }
        } finally {
          fs.writeFileSync = nativeWrite;
        }
        closeIdleSqliteCoordinators(path.join(root, "unrelated"));
        wrongScope = receipts();
        closeIdleSqliteCoordinators(root);
        console.log(JSON.stringify({
          original: observed?.cause?.message,
          receiptPreserved: observed instanceof AggregateError && observed.errors.includes(refused),
          beforeRetry, retryRefused, wrongScope, afterRetry: receipts(),
        }));
        `,
        {
          VITEST_OPENCLAW_RESOURCE_ROOT: ownedRoot,
          VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
            { root: ownedRoot, identity: owner.identity },
          ]),
        },
      );
      expect(result).toMatchObject({
        original: expect.stringMatching(
          failure === "open" ? /unable to open/ : /directory must be a real directory/,
        ),
        receiptPreserved: true,
        beforeRetry: [false],
        retryRefused: true,
        wrongScope: [false],
        afterRetry: [true],
      });
      expect(() => owner.assertReleased()).not.toThrow();
    },
  );

  it.each(["directory", "open", "close"])(
    "retries %s failure from either distinct resource owner's root",
    (failure) => {
      const databaseOwner = createStandaloneOwner("openclaw-acquire-database-owner-");
      const coordinatorOwner = createStandaloneOwner("openclaw-acquire-lock-owner-");
      const result = runCoordinatorSource(
        `
        import fs from "node:fs";
        import path from "node:path";
        import { DatabaseSync } from "node:sqlite";
        const { acquireStateDatabaseCoordinator } = await import(${JSON.stringify(resolveCoordinatorModuleUrl())});
        const { closeIdleSqliteCoordinators } = await import(${JSON.stringify(
          pathToFileURL(path.join(import.meta.dirname, "sqlite-coordinator.ts")).href,
        )});
        const { requireNodeSqlite } = await import(${JSON.stringify(
          pathToFileURL(path.join(import.meta.dirname, "node-sqlite.ts")).href,
        )});
        requireNodeSqlite();
        const databaseRoot = ${JSON.stringify(databaseOwner.ownedRoot)};
        const coordinatorRoot = ${JSON.stringify(coordinatorOwner.ownedRoot)};
        const failure = ${JSON.stringify(failure)};
        const target = path.join(coordinatorRoot, "invalid");
        if (failure === "directory") fs.writeFileSync(target, "not a directory");
        else if (failure === "open") fs.mkdirSync(target);
        const coordinatorPath = failure === "directory" ? path.join(target, "lock.sqlite") : target;
        const blocker = failure === "close" ? new DatabaseSync(coordinatorPath) : undefined;
        blocker?.exec("PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE");
        const nativeClose = DatabaseSync.prototype.close;
        const nativeWrite = fs.writeFileSync;
        let retained;
        if (failure === "close") {
          DatabaseSync.prototype.close = function() {
            retained = this;
            throw new Error("native close refused");
          };
        }
        fs.writeFileSync = function(file, ...args) {
          if (String(file).startsWith(databaseRoot + path.sep) && path.basename(String(file)) === "released") {
            throw new Error("database receipt refused");
          }
          return nativeWrite.call(this, file, ...args);
        };
        const receipts = root => {
          const claims = path.join(root, ".vitest-resource-owner", "claims");
          return fs.readdirSync(claims).map(id => fs.existsSync(path.join(claims, id, "released")));
        };
        let original;
        let firstRetryFailed = false;
        let beforeDatabaseRetry;
        try {
          try {
            acquireStateDatabaseCoordinator({
              databasePath: path.join(databaseRoot, "state.sqlite"), coordinatorPath, busyTimeoutMs: 0,
            });
          } catch (error) { original = error.cause?.message; }
          DatabaseSync.prototype.close = nativeClose;
          blocker?.close();
          try { closeIdleSqliteCoordinators(coordinatorRoot); }
          catch (error) { firstRetryFailed = error.message === "database receipt refused"; }
          beforeDatabaseRetry = {
            database: receipts(databaseRoot), coordinator: receipts(coordinatorRoot),
            nativeOpen: retained?.isOpen ?? false,
          };
        } finally {
          DatabaseSync.prototype.close = nativeClose;
          fs.writeFileSync = nativeWrite;
          if (blocker?.isOpen) blocker.close();
        }
        closeIdleSqliteCoordinators(path.join(databaseRoot, "unrelated"));
        const wrongScope = receipts(databaseRoot);
        closeIdleSqliteCoordinators(databaseRoot);
        console.log(JSON.stringify({
          original, firstRetryFailed, beforeDatabaseRetry, wrongScope,
          afterDatabaseRetry: { database: receipts(databaseRoot), coordinator: receipts(coordinatorRoot) },
        }));
        // Preserve fixture cleanup even when the caller's assertion exposes missing root indexing.
        closeIdleSqliteCoordinators(coordinatorRoot);
        `,
        {
          VITEST_OPENCLAW_RESOURCE_ROOT: databaseOwner.ownedRoot,
          VITEST_OPENCLAW_RESOURCE_ROOT_CHAIN: JSON.stringify([
            { root: databaseOwner.ownedRoot, identity: databaseOwner.owner.identity },
            { root: coordinatorOwner.ownedRoot, identity: coordinatorOwner.owner.identity },
          ]),
        },
      );
      expect(result).toEqual({
        original: expect.stringMatching(
          failure === "directory"
            ? /directory must be a real directory/
            : failure === "open"
              ? /unable to open/
              : /locked/,
        ),
        firstRetryFailed: true,
        beforeDatabaseRetry: { database: [false], coordinator: [true], nativeOpen: false },
        wrongScope: [false],
        afterDatabaseRetry: { database: [true], coordinator: [true] },
      });
      expect(() => databaseOwner.owner.assertReleased()).not.toThrow();
      expect(() => coordinatorOwner.owner.assertReleased()).not.toThrow();
    },
  );
});
