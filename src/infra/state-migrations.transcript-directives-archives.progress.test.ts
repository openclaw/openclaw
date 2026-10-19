import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runWithAgentDatabaseMaintenanceAuthority } from "../state/openclaw-agent-db-lease.js";
import { ensureSessionTranscriptArchiveSchema } from "../state/openclaw-agent-session-transcript-archive-schema.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "./kysely-sync.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { withSqliteReadOnlyWorkerScope } from "./sqlite-readonly-worker.js";
import {
  migrateCanonicalTranscriptArchives as migrateArchives,
  TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE as BATCH_SIZE,
  transcriptDirectiveArchivesNeedMigration as needsMigration,
} from "./state-migrations.transcript-directives-archives.js";
import { repairHistoricalTranscriptEventJson } from "./state-migrations.transcript-directives-transform.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const databases: DatabaseSync[] = [];
const original = Buffer.from('{"type":"custom","data":"original"}\n');
const replacementLine = '{"type":"custom","data":"normalized"}';
const replacement = `${replacementLine}\n`;
const count = 202;
const key = (index: number) => String(index).padStart(3, "0");
const directiveLine = (raw: string, owner: string) =>
  repairHistoricalTranscriptEventJson({
    raw,
    owner,
    scope: "all",
    resolveMaskedProvider: () => undefined,
  });

afterEach(() => {
  for (const database of databases.splice(0)) {
    clearNodeSqliteKyselyCacheForDatabase(database);
    database.close();
  }
});

function fixture(emptySessionIds = false) {
  const root = dirs.make("archive-migration-progress-");
  const pathname = path.join(root, "agent.sqlite");
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(pathname);
  databases.push(database);
  ensureSessionTranscriptArchiveSchema(database);
  database.exec("CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, app_version TEXT)");
  const insert = database.prepare(`INSERT INTO session_transcript_archives
    (session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,
      archive_name,created_at,published_at)
    VALUES(?, ?, ?, 'deleted', 'identity', ?, ?, ?, 1, 1)`);
  const digest = createHash("sha256").update(original).digest("hex");
  database.exec("BEGIN");
  for (let index = 0; index < count; index++) {
    insert.run(
      emptySessionIds ? "" : key(index),
      emptySessionIds ? (index === 0 ? "" : key(index)) : "retained",
      `agent:main:${index}`,
      original,
      digest,
      `${index}.jsonl`,
    );
  }
  database.exec("COMMIT");
  const controller = new AbortController();
  const authority = {
    signal: controller.signal,
    assertOwned() {},
    assertOwnedInTransaction() {},
    renew() {},
  };
  const options = {
    agentId: "main",
    database,
    pathname,
    start: { generation: "", sessionId: "" },
    transformLine: (content: string) => ({
      changed: content !== replacementLine,
      content: replacementLine,
    }),
    writeCursor(cursor: { sessionId: string } | { phase: "complete" }) {
      database
        .prepare(`INSERT INTO schema_meta(meta_key,app_version) VALUES('cursor',?)
        ON CONFLICT(meta_key) DO UPDATE SET app_version=excluded.app_version`)
        .run(JSON.stringify(cursor));
    },
  };
  const state = () => {
    const row = database
      .prepare(`SELECT count(*) AS rewritten,
      (SELECT app_version FROM schema_meta WHERE meta_key='cursor') AS cursor
      FROM session_transcript_archives WHERE archive_blob != ?`)
      .get(original);
    return {
      rewritten: Number(row?.rewritten),
      cursor: row?.cursor == null ? undefined : JSON.parse(String(row.cursor)),
      transaction: database.isTransaction,
    };
  };
  const migrate = (
    overrides: Partial<
      Pick<Parameters<typeof migrateArchives>[0], "start" | "onArchive" | "writeCursor">
    > = {},
  ) =>
    runWithAgentDatabaseMaintenanceAuthority(authority, path.join(root, "state.sqlite"), () =>
      migrateArchives({ ...options, ...overrides }),
    );
  const inspect = <T>(operation: () => Promise<T>) =>
    withSqliteReadOnlyWorkerScope(operation, {
      signal: controller.signal,
      deadlineOwnedByCaller: true,
    });
  const expectProgress = (rewrites = BATCH_SIZE) => {
    expect(state()).toEqual({
      transaction: false,
      rewritten: rewrites,
      cursor: { sessionId: "031", generation: "retained" },
    });
  };
  const expectComplete = () => {
    const { rewritten, cursor } = state();
    expect({ rewritten, cursor }).toEqual({ rewritten: count, cursor: { phase: "complete" } });
  };
  return {
    database,
    controller,
    authority,
    migrate,
    inspect,
    options,
    state,
    expectProgress,
    expectComplete,
  };
}

it.each(["repair", "inspection"] as const)(
  "advances %s through 202 archives with empty session IDs",
  async (mode) => {
    const f = fixture(true);
    let visited = 0;
    const visit = () => {
      if (++visited > count) {
        throw new Error("Archive pagination reselected an already visited key");
      }
    };
    if (mode === "repair") {
      await f.migrate({ onArchive: visit });
      f.expectComplete();
    } else {
      expect(
        await needsMigration(f.database, f.options.start, (raw, owner) => {
          visit();
          return directiveLine(raw, owner);
        }),
      ).toBe(false);
      expect(f.state().rewritten).toBe(0);
    }
    expect(visited).toBe(count);
  },
);

it("rolls back a failing batch, retains its committed prefix and resumes once", async () => {
  const f = fixture();
  f.database.exec(`CREATE TRIGGER reject_archive BEFORE UPDATE OF archive_blob
    ON session_transcript_archives WHEN OLD.session_id = '040'
    BEGIN SELECT RAISE(ABORT, 'OpenClaw state database read admission is closed'); END`);
  const failure = await f.migrate().catch((error: unknown) => error);
  expect(String(failure)).toMatch(/040:retained.*OpenClaw state database read admission is closed/);
  f.expectProgress();
  f.database.exec("DROP TRIGGER reject_archive");
  await f.migrate({ start: f.state().cursor });
  f.expectComplete();
});

it.each([true, false])("cancels at a batch boundary (deferred: %s)", async (deferred) => {
  const f = fixture();
  if (!deferred) {
    for (let index = 0; index < 64; index++) {
      fs.writeFileSync(path.join(path.dirname(f.options.pathname), `${index}.jsonl`), original);
    }
  }
  const interrupted = new Error(`Doctor interrupted by ${deferred ? "SIGINT" : "SIGTERM"}`);
  const migration = f.inspect(() =>
    f.migrate({
      writeCursor(cursor) {
        f.options.writeCursor(cursor);
        if ("sessionId" in cursor && cursor.sessionId === (deferred ? "031" : "063")) {
          if (deferred) {
            queueMicrotask(() => f.controller.abort(interrupted));
          } else {
            f.controller.abort(interrupted);
          }
        }
      },
    }),
  );
  await expect(migration).rejects.toThrow(interrupted);
  f.expectProgress(deferred ? BATCH_SIZE : 64);
  if (!deferred) {
    const publication = f.database
      .prepare(
        "SELECT published_at FROM session_transcript_archives WHERE session_id < '064' ORDER BY session_id",
      )
      .all()
      .map((row) => row.published_at);
    expect(publication).toEqual(Array.from({ length: 64 }, (_, index) => (index < 32 ? 1 : null)));
    expect(fs.readFileSync(path.join(path.dirname(f.options.pathname), "63.jsonl"), "utf8")).toBe(
      replacement,
    );
  }
});

it("cancels archive inspection while decoding a batch", async () => {
  const f = fixture();
  const interrupted = new Error("Doctor interrupted by SIGINT");
  let calls = 0;
  const inspection = f.inspect(() =>
    needsMigration(f.database, f.options.start, (raw, owner) => {
      const line = directiveLine(raw, owner);
      if (++calls === BATCH_SIZE) {
        f.controller.abort(interrupted);
      }
      return line;
    }),
  );
  await expect(inspection).rejects.toBe(interrupted);
  expect(calls).toBe(BATCH_SIZE);
  expect(f.state().rewritten).toBe(0);
});

it("preserves a failed archive write when interruption arrives with it", async () => {
  const f = fixture();
  const interrupted = new Error("Doctor interrupted by SIGTERM");
  const failure = new Error("archive cursor write failed");
  const migration = f.inspect(() =>
    f.migrate({
      writeCursor(cursor) {
        f.options.writeCursor(cursor);
        f.controller.abort(interrupted);
        throw failure;
      },
    }),
  );
  await expect(migration).rejects.toMatchObject({ cause: failure });
  expect(f.state()).toMatchObject({ transaction: false, cursor: undefined });
});

it("renews its existing maintenance owner before each synchronous batch", async () => {
  const f = fixture();
  let now = 0;
  let expires = 100;
  f.authority.assertOwned = () => {
    if (now >= expires) {
      throw new Error("maintenance lease expired");
    }
  };
  f.authority.renew = () => {
    f.authority.assertOwned();
    expires = now + 100;
  };
  await f.migrate({
    onArchive(archivePath) {
      if (Number(path.basename(archivePath, ".jsonl")) % BATCH_SIZE === 0) {
        now += 75;
      }
    },
  });
  expect(now).toBeGreaterThan(100);
  f.expectComplete();
});
