import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runWithAgentDatabaseMaintenanceAuthority } from "../state/openclaw-agent-db-lease.js";
import { ensureSessionTranscriptArchiveSchema } from "../state/openclaw-agent-session-transcript-archive-schema.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "./kysely-sync.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { withSqliteReadOnlyWorkerScope } from "./sqlite-readonly-worker.js";
import {
  migrateCanonicalTranscriptArchives,
  TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE,
  transcriptDirectiveArchivesNeedMigration,
} from "./state-migrations.transcript-directives-archives.js";
import * as directiveTransform from "./state-migrations.transcript-directives-transform.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const databases: DatabaseSync[] = [];
const original = Buffer.from('{"type":"custom","data":"original"}\n');
const replacement = '{"type":"custom","data":"normalized"}\n';
const count = 202;
const key = (index: number) => String(index).padStart(3, "0");

afterEach(() => {
  vi.restoreAllMocks();
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
  database.exec(`CREATE TABLE schema_meta (
    meta_key TEXT PRIMARY KEY, role TEXT, agent_id TEXT, schema_version INTEGER,
    app_version TEXT, created_at INTEGER, updated_at INTEGER
  )`);
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
  const run = (operation: () => Promise<unknown>) =>
    runWithAgentDatabaseMaintenanceAuthority(authority, path.join(root, "state.sqlite"), operation);
  const options = {
    agentId: "main",
    database,
    pathname,
    start: { generation: "", sessionId: "" },
    transformContent: (content: string) => ({
      changed: content !== replacement,
      content: replacement,
    }),
    writeCursor(cursor: { sessionId: string } | { phase: "complete" }) {
      database
        .prepare(`INSERT INTO schema_meta(meta_key,app_version) VALUES('cursor',?)
        ON CONFLICT(meta_key) DO UPDATE SET app_version=excluded.app_version`)
        .run(JSON.stringify(cursor));
    },
  };
  const cursor = () => {
    const row = database
      .prepare("SELECT app_version FROM schema_meta WHERE meta_key='cursor'")
      .get();
    return row ? JSON.parse(String(row.app_version)) : undefined;
  };
  const rewritten = () =>
    Number(
      database
        .prepare("SELECT count(*) AS n FROM session_transcript_archives WHERE archive_blob != ?")
        .get(original)?.n,
    );
  return { database, controller, authority, run, options, cursor, rewritten };
}

describe("canonical archive migration progress", () => {
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
        await f.run(() =>
          migrateCanonicalTranscriptArchives({
            ...f.options,
            transformContent(content) {
              visit();
              return f.options.transformContent(content);
            },
          }),
        );
        expect(f.rewritten()).toBe(count);
        expect(f.cursor()).toEqual({ phase: "complete" });
      } else {
        const parse = directiveTransform.parseDirectiveMigrationTranscriptEvent;
        vi.spyOn(directiveTransform, "parseDirectiveMigrationTranscriptEvent").mockImplementation(
          (...args) => {
            visit();
            return parse(...args);
          },
        );
        expect(await transcriptDirectiveArchivesNeedMigration(f.database, f.options.start)).toBe(
          false,
        );
        expect(f.rewritten()).toBe(0);
      }
      expect(visited).toBe(count);
    },
  );

  it("rolls back a failing batch, retains its committed prefix and resumes once", async () => {
    const f = fixture();
    f.database.exec(`CREATE TRIGGER reject_archive BEFORE UPDATE OF archive_blob
      ON session_transcript_archives WHEN OLD.session_id = '040'
      BEGIN SELECT RAISE(ABORT, 'OpenClaw state database read admission is closed'); END`);
    const failure = await f
      .run(() => migrateCanonicalTranscriptArchives(f.options))
      .catch((error: unknown) => error);
    expect(f.database.isTransaction).toBe(false);
    expect(f.rewritten()).toBe(TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE);
    expect(String(failure)).toMatch(
      /040:retained.*OpenClaw state database read admission is closed/,
    );
    expect(f.cursor()).toEqual({ sessionId: "031", generation: "retained" });
    f.database.exec("DROP TRIGGER reject_archive");
    await f.run(() => migrateCanonicalTranscriptArchives({ ...f.options, start: f.cursor() }));
    expect(f.rewritten()).toBe(count);
    expect(f.cursor()).toEqual({ phase: "complete" });
  });

  it("honors Doctor cancellation at the first committed batch boundary", async () => {
    const f = fixture();
    const interrupted = new Error("Doctor interrupted by SIGINT");
    let scheduled = false;
    await expect(
      withSqliteReadOnlyWorkerScope(
        () =>
          f.run(() =>
            migrateCanonicalTranscriptArchives({
              ...f.options,
              transformContent(content) {
                if (!scheduled) {
                  scheduled = true;
                  setImmediate(() => f.controller.abort(interrupted));
                }
                return f.options.transformContent(content);
              },
            }),
          ),
        { signal: f.controller.signal, deadlineOwnedByCaller: true },
      ),
    ).rejects.toThrow(interrupted);
    expect(f.database.isTransaction).toBe(false);
    expect(f.rewritten()).toBe(TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE);
    expect(f.cursor()).toEqual({ sessionId: "031", generation: "retained" });
  });

  it("cancels archive inspection between batches", async () => {
    const f = fixture();
    const interrupted = new Error("Doctor interrupted by SIGINT");
    const parsed = vi.spyOn(directiveTransform, "parseDirectiveMigrationTranscriptEvent");
    await expect(
      withSqliteReadOnlyWorkerScope(
        async () => {
          setImmediate(() => f.controller.abort(interrupted));
          return transcriptDirectiveArchivesNeedMigration(f.database, f.options.start);
        },
        { signal: f.controller.signal, deadlineOwnedByCaller: true },
      ),
    ).rejects.toBe(interrupted);
    expect(parsed).toHaveBeenCalledTimes(TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE);
    expect(f.rewritten()).toBe(0);
  });

  it("preserves a failed archive write when interruption arrives with it", async () => {
    const f = fixture();
    const interrupted = new Error("Doctor interrupted by SIGTERM");
    const failure = new Error("archive cursor write failed");
    await expect(
      withSqliteReadOnlyWorkerScope(
        () =>
          f.run(() =>
            migrateCanonicalTranscriptArchives({
              ...f.options,
              writeCursor(cursor) {
                f.options.writeCursor(cursor);
                f.controller.abort(interrupted);
                throw failure;
              },
            }),
          ),
        { signal: f.controller.signal, deadlineOwnedByCaller: true },
      ),
    ).rejects.toMatchObject({ cause: failure });
    expect(f.database.isTransaction).toBe(false);
    expect(f.cursor()).toBeUndefined();
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
    await f.run(() =>
      migrateCanonicalTranscriptArchives({
        ...f.options,
        transformContent(content, owner) {
          if (Number(owner.split(":")[0]) % TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE === 0) {
            now += 75;
          }
          return f.options.transformContent(content);
        },
      }),
    );
    expect(now).toBeGreaterThan(100);
    expect(f.rewritten()).toBe(count);
    expect(f.cursor()).toEqual({ phase: "complete" });
  });

  it("rolls back publication and cursor together when interrupted before commit", async () => {
    const f = fixture();
    for (let index = 0; index < 64; index++) {
      fs.writeFileSync(path.join(path.dirname(f.options.pathname), `${index}.jsonl`), original);
    }
    const interrupted = new Error("Doctor interrupted by SIGTERM");
    await expect(
      withSqliteReadOnlyWorkerScope(
        () =>
          f.run(() =>
            migrateCanonicalTranscriptArchives({
              ...f.options,
              writeCursor(cursor) {
                f.options.writeCursor(cursor);
                if ("sessionId" in cursor && cursor.sessionId === "063") {
                  f.controller.abort(interrupted);
                }
              },
            }),
          ),
        { signal: f.controller.signal, deadlineOwnedByCaller: true },
      ),
    ).rejects.toThrow(interrupted);
    expect(f.database.isTransaction).toBe(false);
    expect(f.cursor()).toEqual({ sessionId: "031", generation: "retained" });
    expect(f.rewritten()).toBe(64);
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
  });
});
