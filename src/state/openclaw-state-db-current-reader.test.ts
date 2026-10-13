import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runSqliteSchemaReadSnapshotSync } from "../infra/sqlite-pinned-read-snapshot.js";
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
  const root = directories.make("state-current-reader-");
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

it("shares one physical reader and write receipt across aliases with independent custody and no probes", async () => {
  const { root, options, database, prepare } = fixture();
  const alias = path.join(root, "alias.sqlite");
  fs.symlinkSync(options.path, alias);
  const first = await prepare();
  const second = await prepare(alias);
  if (!first || !second) {
    throw new Error("Existing source must admit both readers");
  }
  expect(first.read(({ db }) => db)).toBe(second.read(({ db }) => db));
  const before = first.writeRevision();
  expect(before).toBeTypeOf("number");
  const trace = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
  try {
    expect(second.writeRevision()).toBe(before);
    expect(first.writeRevision()).toBe(before);
    expect(trace.queries).toEqual([]);
    database.db
      .prepare("INSERT INTO config_machine_state VALUES ('fixture.receipt', '1', 1)")
      .run();
    trace.queries.length = 0;
    const after = first.writeRevision();
    expect(after).toBeTypeOf("number");
    expect(after).not.toBe(before);
    expect(second.writeRevision()).toBe(after);
    expect(trace.queries).toEqual([]);
    first.dispose();
    expect(() => first.writeRevision()).toThrow(/closed/);
    expect(second.writeRevision()).toBe(after);
    await closeOpenClawStateDatabaseAsync();
    expect(() => second.writeRevision()).toThrow(/closed/);
  } finally {
    trace.restore();
    first.dispose();
    second.dispose();
  }
});

it("does not revive a disposed borrower when the physical reader reopens", async () => {
  const { prepare } = fixture();
  const first = await prepare();
  if (!first) {
    throw new Error("Existing source must admit a reader");
  }
  const original = first.read(({ db }) => db);
  first.dispose();
  expect(original.isOpen).toBe(false);
  const next = await prepare();
  if (!next) {
    throw new Error("Existing source must reopen");
  }
  try {
    expect(() => first.writeRevision()).toThrow(/closed/);
    const reopened = next.read(({ db }) => db);
    expect(reopened.isOpen).toBe(true);
    expect(reopened === original).toBe(false);
    expect(next.writeRevision()).toBeTypeOf("number");
  } finally {
    next.dispose();
  }
});

it("keeps the receipt stable while a coherent native read fills derived schema facts", async () => {
  const { prepare } = fixture();
  const reader = await prepare();
  if (!reader) {
    throw new Error("Existing source must admit a reader");
  }
  try {
    const before = reader.writeRevision();
    expect(before).toBeTypeOf("number");
    expect(
      reader.read(({ db }) =>
        db.prepare("SELECT count(*) AS count FROM config_machine_state").get(),
      ),
    ).toHaveProperty("count");
    expect(reader.writeRevision()).toBe(before);
    const database = reader.read(({ db }) => db);
    runSqliteSchemaReadSnapshotSync(database, () => {
      expect(() => reader.writeRevision()).toThrow(/transaction or snapshot/);
    });
    expect(reader.writeRevision()).toBe(before);
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
    expect(first.writeRevision()).toBeTypeOf("number");
    first.dispose();
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => first.writeRevision()).toThrow(/closed/);
    if (retry === "dispose") {
      first.dispose();
      expect(close).toHaveBeenCalledTimes(2);
    }
    const next = await prepare();
    try {
      expect(close).toHaveBeenCalledTimes(2);
      expect(next?.writeRevision()).toBeTypeOf("number");
      expect(() => first.writeRevision()).toThrow(/closed/);
    } finally {
      next?.dispose();
    }
  },
);

it.runIf(process.platform !== "win32")(
  "retires every borrower after alias rebinding or identical-byte canonical replacement",
  async () => {
    const { root, options, database, prepare } = fixture();
    database.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
    const alias = path.join(root, "alias.sqlite");
    const replacement = path.join(root, "replacement.sqlite");
    fs.copyFileSync(options.path, replacement);
    fs.symlinkSync(options.path, alias);
    const reader = await prepare(alias);
    const sibling = await prepare();
    if (!reader || !sibling) {
      throw new Error("Existing aliases must admit readers");
    }
    try {
      expect(reader.writeRevision()).toBeTypeOf("number");
      fs.unlinkSync(alias);
      fs.symlinkSync(replacement, alias);
      expect(() => reader.writeRevision()).toThrow(/identity/);
      fs.unlinkSync(alias);
      fs.symlinkSync(options.path, alias);
      expect(() => reader.writeRevision()).toThrow(/closed/);
      expect(() => sibling.writeRevision()).toThrow(/closed/);

      const next = await prepare();
      const hardAlias = path.join(root, "hard-alias.sqlite");
      fs.linkSync(options.path, hardAlias);
      const hardReader = await prepare(hardAlias);
      if (!next || !hardReader) {
        throw new Error("Restored aliases must admit new readers");
      }
      const original = path.join(root, "original.sqlite");
      try {
        expect(hardReader.writeRevision()).toBeTypeOf("number");
        fs.renameSync(options.path, original);
        fs.renameSync(replacement, options.path);
        try {
          // The hard-link path still selects the old file; the pooled canonical source changed.
          expect(() => hardReader.writeRevision()).toThrow(/identity/);
        } finally {
          fs.renameSync(options.path, replacement);
          fs.renameSync(original, options.path);
        }
        expect(() => next.writeRevision()).toThrow(/closed/);
        expect(() => hardReader.writeRevision()).toThrow(/closed/);
      } finally {
        next.dispose();
        hardReader.dispose();
      }
    } finally {
      reader.dispose();
      sibling.dispose();
    }
  },
);
