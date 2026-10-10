import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runSqliteForeignUse } from "../infra/sqlite-foreign-observation.js";
import { prepareOpenClawStateCurrentReader } from "./openclaw-state-db-current-reader.js";
import * as readConnections from "./openclaw-state-db-read-connection.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    vi.restoreAllMocks();
    cleanup();
  });
});

function fixture() {
  const root = directories.make("state-foreign-observation-");
  const options = {
    path: path.join(root, "openclaw.sqlite"),
    env: { OPENCLAW_STATE_DIR: root, OPENCLAW_TEST_FAST: "1" },
  };
  const database = openOpenClawStateDatabase(options);
  const prepare = (pathname = options.path) =>
    prepareOpenClawStateCurrentReader(
      captureOpenClawStateWorkerContext({ ...options, path: pathname }),
    );
  return { root, options, database, prepare };
}

it("shares a physical probe across aliases and nested guards while retaining independent custody", async () => {
  const { root, options, prepare } = fixture();
  const alias = path.join(root, "alias.sqlite");
  fs.symlinkSync(options.path, alias);
  const first = await prepare();
  const second = await prepare(alias);
  if (!first || !second) {
    throw new Error("Existing source must admit both readers");
  }
  const a = first.createCertification();
  const b = second.createCertification();
  expect(a.beginRefresh().accept()).toBe(true);
  expect(b.beginRefresh().accept()).toBe(true);
  const trace = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
  try {
    runSqliteForeignUse((use) => {
      expect(a.isCurrent(use)).toBe(true);
      runSqliteForeignUse((nested) => expect(b.isCurrent(nested)).toBe(true));
    });
    expect(trace.queries).toEqual(["PRAGMA data_version"]);
    first.dispose();
    expect(() => runSqliteForeignUse((use) => a.isCurrent(use))).toThrow(/closed/);
    expect(runSqliteForeignUse((use) => b.isCurrent(use))).toBe(true);
    await closeOpenClawStateDatabaseAsync();
    expect(() => b.beginRefresh()).toThrow(/closed/);
  } finally {
    trace.restore();
    first.dispose();
    second.dispose();
  }
});

it("cannot adopt a reopened handle's observation", async () => {
  const { prepare } = fixture();
  const first = await prepare();
  if (!first) {
    throw new Error("Existing source must admit a reader");
  }
  const old = first.createCertification();
  expect(old.beginRefresh().accept()).toBe(true);
  first.dispose();
  const next = await prepare();
  if (!next) {
    throw new Error("Existing source must reopen");
  }
  try {
    expect(() => runSqliteForeignUse((use) => old.isCurrent(use))).toThrow(/closed/);
    const current = next.createCertification();
    expect(runSqliteForeignUse((use) => current.isCurrent(use))).toBe(false);
    expect(current.beginRefresh().accept()).toBe(true);
    expect(runSqliteForeignUse((use) => current.isCurrent(use))).toBe(true);
  } finally {
    next.dispose();
  }
});

it("accepts a coherent native fallback when its first read fills derived schema facts", async () => {
  const { prepare } = fixture();
  const reader = await prepare();
  if (!reader) {
    throw new Error("Existing source must admit a reader");
  }
  try {
    const certification = reader.createCertification();
    const refresh = certification.beginRefresh();
    expect(
      reader.read(({ db }) =>
        db.prepare("SELECT count(*) AS count FROM config_machine_state").get(),
      ),
    ).toHaveProperty("count");
    expect(refresh.accept()).toBe(true);
    expect(runSqliteForeignUse((use) => certification.isCurrent(use))).toBe(true);
  } finally {
    reader.dispose();
  }
});

it.each(["dispose", "prepare"] as const)(
  "retries incomplete native cleanup through %s without reusing the retired reader",
  async (retry) => {
    const { prepare } = fixture();
    const opening = vi.spyOn(readConnections, "openOpenClawStateReadConnection");
    const first = await prepare();
    const opened = opening.mock.results.at(-1);
    opening.mockRestore();
    if (!first || opened?.type !== "return") {
      throw new Error("Existing source must admit a reader");
    }
    const close = vi.spyOn(opened.value, "close").mockImplementationOnce(() => {
      if (retry === "dispose") {
        throw new Error("Synthetic incomplete native cleanup");
      }
      return false;
    });
    const old = first.createCertification();
    expect(old.beginRefresh().accept()).toBe(true);
    first.dispose();
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => old.beginRefresh()).toThrow(/closed/);
    if (retry === "dispose") {
      first.dispose();
      expect(close).toHaveBeenCalledTimes(2);
    }
    const next = await prepare();
    try {
      expect(close).toHaveBeenCalledTimes(2);
      expect(next?.createCertification().beginRefresh().accept()).toBe(true);
      expect(() => runSqliteForeignUse((use) => old.isCurrent(use))).toThrow(/closed/);
    } finally {
      next?.dispose();
    }
  },
);

it.runIf(process.platform !== "win32")(
  "retires observations after alias rebinding or identical-byte file replacement",
  async () => {
    const { root, options, database, prepare } = fixture();
    database.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
    const alias = path.join(root, "alias.sqlite");
    const replacement = path.join(root, "replacement.sqlite");
    fs.copyFileSync(options.path, replacement);
    fs.symlinkSync(options.path, alias);
    const reader = await prepare(alias);
    if (!reader) {
      throw new Error("Existing alias must admit a reader");
    }
    const certification = reader.createCertification();
    expect(certification.beginRefresh().accept()).toBe(true);
    const sibling = reader.createCertification();
    expect(sibling.beginRefresh().accept()).toBe(true);
    try {
      fs.unlinkSync(alias);
      fs.symlinkSync(replacement, alias);
      expect(() => runSqliteForeignUse((use) => certification.isCurrent(use))).toThrow(/identity/);
      fs.unlinkSync(alias);
      fs.symlinkSync(options.path, alias);
      expect(runSqliteForeignUse((use) => certification.isCurrent(use))).toBe(false);
      expect(runSqliteForeignUse((use) => sibling.isCurrent(use))).toBe(false);
      const next = reader.createCertification();
      expect(next.beginRefresh().accept()).toBe(true);
      const original = path.join(root, "original.sqlite");
      fs.renameSync(options.path, original);
      fs.renameSync(replacement, options.path);
      try {
        expect(() => runSqliteForeignUse((use) => next.isCurrent(use))).toThrow(/identity/);
      } finally {
        fs.renameSync(options.path, replacement);
        fs.renameSync(original, options.path);
      }
      expect(runSqliteForeignUse((use) => next.isCurrent(use))).toBe(false);
    } finally {
      reader.dispose();
    }
  },
);
