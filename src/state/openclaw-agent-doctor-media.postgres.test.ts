import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData, Worker } from "node:worker_threads";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import {
  getDatabaseEngineSelection,
  installDatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../infra/runtime-worker-url.js";
import { captureSqliteDatabaseAdmissions } from "../infra/sqlite-database-admission.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import type { inspectPostgresMediaPersistence } from "../infra/state-migrations.media-persistence-inspection.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

type MediaInspection = Awaited<ReturnType<typeof inspectPostgresMediaPersistence>>;
const configured: unknown = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const prefix = `media_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let root: string;
let client: pg.Client;

describe.skipIf(!connection)("PostgreSQL Doctor media inspection", () => {
  beforeAll(async () => {
    root = tempDirs.make("doctor-media-postgres-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: connection!, schemaPrefix: prefix },
    });
    client = new pg.Client({ connectionString: connection });
    await client.connect();
    await client.query("CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public");
  });
  afterAll(async () => {
    withEngineStoreAdmission(closeOpenClawStateDatabaseForTest);
    await cleanupSessionStateForTest({ stateDir: root });
    resetDatabaseEngineSelectionForTest();
    try {
      const schemas = await client.query<{ nspname: string }>(
        "SELECT nspname FROM pg_namespace WHERE left(nspname, $1) = $2",
        [prefix.length + 1, `${prefix}_`],
      );
      for (const { nspname } of schemas.rows) {
        await client.query(`DROP SCHEMA "${nspname.replaceAll('"', '""')}" CASCADE`);
      }
    } finally {
      await client.end();
    }
  });

  it("inspects clean PostgreSQL media and preserves rows and archives requiring native repair", async () => {
    const agentId = "doctor-media";
    const sessionId = "doctor-media-session";
    const env = { OPENCLAW_STATE_DIR: root };
    const pathname = resolveOpenClawAgentSqlitePath({ agentId, env });
    const target = {
      agentId,
      env,
      sessionId,
      sessionKey: `agent:${agentId}:main`,
      storePath: path.join(root, "agents", agentId, "sessions", "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
    await appendTranscriptMessage(target, {
      message: { role: "user", content: "preserved" },
      now: 1,
    });
    const database = withEngineStoreAdmission(() =>
      openOpenClawAgentDatabase({ agentId, env, path: pathname }),
    );
    const namespace = getPostgresPhysicalFacts(database.db)?.namespace;
    assert(namespace);
    withEngineStoreAdmission(() => closeOpenClawAgentDatabaseByPath(pathname));
    await closeOpenClawAgentDatabaseByPathAsync(pathname);
    const anchorBytes = fs.readFileSync(pathname);
    // Raw Workers borrow their parent's admitted native anchor identity.
    using anchor = openNodeSqliteDatabase(pathname);
    admitSqliteSchema(anchor);
    expect(
      (
        await client.query(
          `SELECT agent_id, role, schema_version::integer AS schema_version FROM "${namespace}".schema_meta WHERE meta_key = 'primary'`,
        )
      ).rows,
    ).toEqual([
      { agent_id: agentId, role: "agent", schema_version: OPENCLAW_AGENT_SCHEMA_VERSION },
    ]);
    const clean =
      '{"type":"message","id":"media-message","timestamp":1,"message":{"role":"user","content":"preserved"},"opaqueCount":9007199254740993}';
    const legacy = clean.replace(
      '"content":"preserved"',
      '"content":"preserved","MediaPath":"/synthetic/media.png"',
    );
    const updateTranscript = (raw: string) =>
      client.query(
        `UPDATE "${namespace}".transcript_events SET event_json = $1 WHERE session_id = $2 AND message_role = 'user'`,
        [raw, sessionId],
      );
    const readTranscript = () =>
      client.query(
        `SELECT event_json FROM "${namespace}".transcript_events WHERE session_id = $1 AND message_role = 'user'`,
        [sessionId],
      );
    const inspect = async () => {
      const url = new URL(
        "./openclaw-agent-doctor-media.postgres.test-support.ts",
        import.meta.url,
      );
      const worker = new Worker(url, {
        execArgv: resolveRuntimeWorkerThreadExecArgv(url),
        workerData: {
          env,
          target: { agentId, path: pathname },
          selection: getDatabaseEngineSelection(),
          admissions: captureSqliteDatabaseAdmissions(undefined, { location: pathname }),
        },
      });
      try {
        return await new Promise<MediaInspection>((resolve, reject) => {
          let reply: { result: MediaInspection } | { error: string } | undefined;
          worker.on("message", (message: typeof reply) => {
            reply = message;
          });
          worker.once("error", reject);
          worker.once("exit", (code) => {
            if (code !== 0 || !reply) {
              reject(new Error(`Media inspection worker exited ${code} without a result`));
            } else if ("error" in reply) {
              reject(new Error(reply.error));
            } else {
              resolve(reply.result);
            }
          });
        });
      } finally {
        await worker.terminate();
      }
    };
    await updateTranscript(clean);
    expect(await inspect()).toEqual({
      deferred: false,
      rewrittenSessions: 0,
      rewrittenTrajectoryRows: 0,
      rewrittenArchives: 0,
      warnings: [],
      initialVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
      finalVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expect((await readTranscript()).rows).toEqual([{ event_json: clean }]);

    const expectRefused = async () => {
      await expect(inspect()).rejects.toThrow("PostgreSQL cannot use SQLite repair");
      expect(fs.readFileSync(pathname)).toEqual(anchorBytes);
    };
    await updateTranscript(legacy);
    await expectRefused();
    expect((await readTranscript()).rows).toEqual([{ event_json: legacy }]);

    await updateTranscript(clean);
    const trajectory =
      '{"data":{"messagesSnapshot":[{"role":"user","content":"preserved","MediaPath":"/synthetic/media.png"}]},"opaqueCount":9007199254740993}';
    await client.query(
      `INSERT INTO "${namespace}".trajectory_runtime_events (session_id, seq, run_id, event_json, created_at) VALUES ($1, 0, 'media-run', $2, 1)`,
      [sessionId, trajectory],
    );
    await expectRefused();
    expect(
      (await client.query(`SELECT event_json FROM "${namespace}".trajectory_runtime_events`)).rows,
    ).toEqual([{ event_json: trajectory }]);

    await client.query(`DELETE FROM "${namespace}".trajectory_runtime_events`);
    const archive = Buffer.from(`${legacy}\n`);
    await client.query(
      `INSERT INTO "${namespace}".session_transcript_archives (session_id, generation, session_key, reason, encoding, archive_blob, archive_sha256, archive_name, created_at, published_at) VALUES ($1, 'media-generation', $2, 'deleted', 'identity', $3, $4, 'media.jsonl', 1, 1)`,
      [sessionId, target.sessionKey, archive, createHash("sha256").update(archive).digest("hex")],
    );
    await expectRefused();
    expect(
      (await client.query(`SELECT archive_blob FROM "${namespace}".session_transcript_archives`))
        .rows,
    ).toEqual([{ archive_blob: archive }]);
    expect(anchor.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
      { name: "openclaw_engine_anchor" },
    ]);
  });
});
