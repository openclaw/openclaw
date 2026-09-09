import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readSqliteBusyTimeout, setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import {
  openClawStateDatabaseCache,
  registerOpenClawStateDatabaseLifecycleListener,
} from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  openClawStateDatabaseCache.closeOpenClawStateDatabaseForTest();
});

it("releases closed shared database wrappers after path and global retirement", () => {
  const stateDir = tempDirs.make("openclaw-state-retention-");
  const moduleUrl = new URL("./openclaw-state-db.ts", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import {
      closeOpenClawStateDatabase,
      closeOpenClawStateDatabaseByPath,
      openOpenClawStateDatabase,
    } from ${JSON.stringify(moduleUrl)};

    function retire(byPath) {
      const owner = openOpenClawStateDatabase();
      const ref = new WeakRef(owner.db);
      for (let i = 0; i < 3; i++) {
        assert.equal(openOpenClawStateDatabase(), owner);
      }
      if (byPath) {
        assert.equal(closeOpenClawStateDatabaseByPath(owner.path), true);
      } else {
        closeOpenClawStateDatabase();
      }
      assert.equal(owner.db.isOpen, false);
      return ref;
    }
    const refs = [retire(true), retire(false)];
    for (let i = 0; i < 30; i++) {
      await new Promise(setImmediate);
      globalThis.gc();
    }
    process.stdout.write(JSON.stringify(refs.map(ref => ref.deref() === undefined)));
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--expose-gc",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([true, true]);
});

it("runs cached owner reads without publishing another state database owner", () => {
  const stateDir = tempDirs.make("openclaw-state-owner-read-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const owner = openOpenClawStateDatabase({ env });
  owner.db.exec("CREATE TABLE owner_read_probe(value TEXT);");
  owner.db.prepare("INSERT INTO owner_read_probe(value) VALUES(?)").run("cached");

  let openedEvents = 0;
  const unregister = registerOpenClawStateDatabaseLifecycleListener((event) => {
    if (event.kind === "opened") {
      openedEvents += 1;
    }
  });
  openedEvents = 0;
  try {
    expect(
      openClawStateDatabaseCache.withCachedOpenClawStateDatabaseOwnerRead(owner.path, ({ db }) => {
        expect(db).toBe(owner.db);
        return db.prepare("SELECT value FROM owner_read_probe").get();
      }),
    ).toMatchObject({ value: "cached" });
    expect(
      openClawStateDatabaseCache.withCachedOpenClawStateDatabaseOwnerRead(owner.path, ({ db }) => {
        expect(db).toBe(owner.db);
        return db.prepare("SELECT value FROM owner_read_probe").get();
      }),
    ).toMatchObject({ value: "cached" });
    expect(openedEvents).toBe(0);
  } finally {
    unregister();
  }
});

it("returns undefined for closed, unlinked, and transaction-held cached owners", () => {
  const stateDir = tempDirs.make("openclaw-state-owner-read-boundary-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const owner = openOpenClawStateDatabase({ env });
  owner.db.exec("CREATE TABLE owner_read_probe(value TEXT);");
  owner.db.prepare("INSERT INTO owner_read_probe(value) VALUES(?)").run("cached");

  owner.db.exec("BEGIN;");
  try {
    expect(
      openClawStateDatabaseCache.withCachedOpenClawStateDatabaseOwnerRead(owner.path, () => {
        throw new Error("transaction-held owner should not be read");
      }),
    ).toBeUndefined();
  } finally {
    owner.db.exec("ROLLBACK;");
  }

  const closedOwner = openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-state-owner-read-closed-") },
  });
  expect(fs.existsSync(closedOwner.path)).toBe(true);
  expect(openClawStateDatabaseCache.closeOpenClawStateDatabaseByPath(closedOwner.path)).toBe(true);
  expect(fs.existsSync(closedOwner.path)).toBe(true);
  expect(
    openClawStateDatabaseCache.withCachedOpenClawStateDatabaseOwnerRead(closedOwner.path, () => {
      throw new Error("closed owner should not be read");
    }),
  ).toBeUndefined();

  fs.unlinkSync(owner.path);
  expect(
    openClawStateDatabaseCache.withCachedOpenClawStateDatabaseOwnerRead(owner.path, () => {
      throw new Error("unlinked owner should not be read");
    }),
  ).toBeUndefined();

  openClawStateDatabaseCache.closeOpenClawStateDatabaseByPath(owner.path);
});

it("restores cached owner busy timeout after successful and locked owner reads", () => {
  const stateDir = tempDirs.make("openclaw-state-owner-read-busy-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const owner = openOpenClawStateDatabase({ env });
  setSqliteBusyTimeout(owner.db, 1234);

  expect(
    openClawStateDatabaseCache.withCachedOpenClawStateDatabaseOwnerRead(owner.path, ({ db }) => {
      expect(readSqliteBusyTimeout(db)).toBe(0);
      return "ok";
    }),
  ).toBe("ok");
  expect(readSqliteBusyTimeout(owner.db)).toBe(1234);

  const busy = Object.assign(new Error("synthetic busy"), { code: "SQLITE_BUSY" });
  expect(
    openClawStateDatabaseCache.withCachedOpenClawStateDatabaseOwnerRead(owner.path, () => {
      throw busy;
    }),
  ).toBeUndefined();
  expect(readSqliteBusyTimeout(owner.db)).toBe(1234);
});
