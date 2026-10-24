import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { deriveDeliveryQueueRetentionColumns } from "../infra/delivery-queue-retention-columns.js";
import {
  deriveMeetingTranscriptSessionColumns,
  deriveMeetingTranscriptSummaryColumns,
} from "../transcripts/store-columns.js";
import { OPENCLAW_STATE_SCHEMA_VERSION as SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { expectRow, readRow } from "./openclaw-state-db-fixtures.test-support.js";
import { migratePredicateColumnsV21 } from "./openclaw-state-db-schema-v21-columns.js";
import {
  closeOpenClawStateDatabaseAsync as closeState,
  openOpenClawStateDatabase as openState,
  repairOpenClawStateDatabaseSchema as repairSchema,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath as resolveStatePath } from "./openclaw-state-db.paths.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  withStateMigrationBackupForTest,
} from "./openclaw-state-schema.test-support.js";

const sessionColumns = [
  "source_account_id",
  "source_guild_id",
  "source_channel_id",
  "source_meeting_url",
  "source_thread_ts",
  "source_file_id",
  "metadata_agent_id",
] as const;
const retentionColumns = [
  "retention_id_prefix",
  "retention_max_age_ms",
  "retention_max_entries",
] as const;
const policy = (prefix: string, age = "1", count = "2") =>
  `{"completionRetention":{"idPrefix":${prefix},"maxAgeMs":${age},"maxEntries":${count}}}`;
const retention = (values?: readonly [string, number, number]) =>
  Object.fromEntries(retentionColumns.map((column, i) => [column, values?.[i] ?? null]));

function openMigrationFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE meeting_transcript_sessions (
    id INTEGER PRIMARY KEY, source_json TEXT, metadata_json TEXT
  ) STRICT;
  CREATE TABLE meeting_transcript_summaries (id INTEGER PRIMARY KEY, summary_json TEXT) STRICT;
  CREATE TABLE delivery_queue_entries (
    fixture_id INTEGER PRIMARY KEY, id TEXT NOT NULL, entry_json TEXT NOT NULL
  ) STRICT;`);
  return db;
}

it("derives historical transcript strings without converting other JSON types", () => {
  using db = openMigrationFixture();
  const specimen = (
    source: string,
    metadata: string | null,
    summary: string | null,
    value: string | null,
  ) => ({
    source,
    metadata,
    summary,
    values: sessionColumns.map(() => value),
    overview: value,
  });
  const cases = [
    { raw: '"text"', expected: "text" },
    { raw: '""', expected: "" },
    { raw: '"\\u0061\\n"', expected: "a\n" },
    ...["true", "false", "1", "1.0", "1e0", "null", "[]", '["text"]', '{"nested":"text"}'].map(
      (raw) => ({ raw, expected: null }),
    ),
  ];
  const specimens = [
    ...cases.map(({ raw, expected }) =>
      specimen(
        `{"accountId":${raw},"guildId":${raw},"channelId":${raw},"meetingUrl":${raw},"threadTs":${raw},"fileId":${raw}}`,
        `{"agentId":${raw}}`,
        `{"overview":${raw}}`,
        expected,
      ),
    ),
    ...["{}", "[]", '[{"accountId":"text"}]', '"text"', "1", "null", "{"].map((parent) =>
      specimen(parent, parent, parent, null),
    ),
    specimen(
      '{"accountId":"first","accountId":"last","guildId":"first","guildId":"last","channelId":"first","channelId":"last","meetingUrl":"first","meetingUrl":"last","threadTs":"first","threadTs":"last","fileId":"first","fileId":"last"}',
      '{"agentId":"first","agentId":"last"}',
      '{"overview":"first","overview":"last"}',
      "first",
    ),
    specimen("{}", null, null, null),
    {
      source:
        '{"accountId":"account","guildId":"guild","channelId":"channel","meetingUrl":"url","threadTs":"thread","fileId":"file"}',
      metadata: '{"agentId":"agent"}',
      summary: "{}",
      overview: null,
      values: ["account", "guild", "channel", "url", "thread", "file", "agent"],
    },
  ];
  const insertSession = db.prepare("INSERT INTO meeting_transcript_sessions VALUES (?, ?, ?)");
  const insertSummary = db.prepare("INSERT INTO meeting_transcript_summaries VALUES (?, ?)");
  for (const [index, entry] of specimens.entries()) {
    insertSession.run(index, entry.source, entry.metadata);
    insertSummary.run(index, entry.summary);
  }
  migratePredicateColumnsV21(db, 20);
  for (const [index, entry] of specimens.entries()) {
    const expected = Object.fromEntries(
      sessionColumns.map((column, i) => [column, entry.values[i]]),
    );
    expectRow(
      db,
      "SELECT " + sessionColumns.join(", ") + " FROM meeting_transcript_sessions WHERE id = ?",
      expected,
      index,
    );
    expect(
      deriveMeetingTranscriptSessionColumns(entry.source, entry.metadata),
      entry.source,
    ).toEqual(expected);
    expectRow(
      db,
      "SELECT overview FROM meeting_transcript_summaries WHERE id = ?",
      { overview: entry.overview },
      index,
    );
    expect(deriveMeetingTranscriptSummaryColumns(entry.summary)).toEqual({
      overview: entry.overview,
    });
  }
});
it("preserves the shipped retention predicate for raw JSON scalar and compound values", () => {
  using db = openMigrationFixture();
  type Case = { json: string; id?: string; expected?: [string, number, number] };
  const cases: Case[] = [
    { json: policy('"kept:"'), expected: ["kept:", 1, 2] },
    {
      json: policy('"kept:"', "9007199254740991", "9007199254740991"),
      expected: ["kept:", 9007199254740991, 9007199254740991],
    },
    { json: policy('"kept:"', "true", "true"), expected: ["kept:", 1, 1] },
    ...["false", "1.0", "1e0", "1.5", "0", "-1"].map((age) => ({ json: policy('"kept:"', age) })),
    { json: policy('"kept:"', "1", "1.0") },
    { json: policy('"kept:"', "1", "1e0") },
    { json: policy('"kept:"', "9007199254740992") },
    { json: policy('"kept:"', "9223372036854775808") },
    ...['"1"', "null", "[]", "{}"].map((age) => ({ json: policy('"kept:"', age) })),
    ...['""', '"different:"', "true", "false", "1", "null"].map((prefix) => ({
      json: policy(prefix),
    })),
    { json: policy('[ "kept:" ]'), id: '["kept:"]row', expected: ['["kept:"]', 1, 2] },
    { json: policy("[ 1.0, true ]"), id: "[1.0,true]row", expected: ["[1.0,true]", 1, 2] },
    { json: policy("[ 1.0, true ]"), id: "[1,true]row" },
    { json: policy('{ "a": 1e0 }'), id: '{"a":1e0}row', expected: ['{"a":1e0}', 1, 2] },
    { json: policy('{ "a": 1e0 }'), id: '{"a":1}row' },
    { json: policy('[ "kept:" ]') },
    { json: '{"completionRetention":{"idPrefix":"kept:","maxAgeMs":1}}' },
    { json: '{"completionRetention":{"idPrefix":"kept:","maxEntries":2}}' },
    { json: '{"completionRetention":{"maxAgeMs":1,"maxEntries":2}}' },
    {
      json: '{"completionRetention":{"idPrefix":"kept:","idPrefix":"other:","maxAgeMs":1,"maxEntries":2}}',
      expected: ["kept:", 1, 2],
    },
    {
      json: '{"completionRetention":{"idPrefix":"kept:","maxAgeMs":false,"maxAgeMs":1,"maxEntries":2}}',
    },
    ...["{}", "[]", "null", "1", '"text"', "{"].map((json) => ({ json })),
    ...["[]", "null", "1", '"text"'].map((parent) => ({
      json: `{"completionRetention":${parent}}`,
    })),
  ];
  const insert = db.prepare("INSERT INTO delivery_queue_entries VALUES (?, ?, ?)");
  for (const [index, specimen] of cases.entries()) {
    insert.run(index, specimen.id ?? "kept:row", specimen.json);
  }
  migratePredicateColumnsV21(db, 20);
  for (const [index, specimen] of cases.entries()) {
    const expected = retention(specimen.expected);
    expect(
      readRow(
        db,
        `SELECT ${retentionColumns.join(", ")} FROM delivery_queue_entries WHERE fixture_id = ?`,
        index,
      ),
      specimen.json,
    ).toEqual(expected);
    expect(
      deriveDeliveryQueueRetentionColumns(specimen.id ?? "kept:row", specimen.json),
      specimen.json,
    ).toEqual(expected);
  }
});

it("keeps promoted JSON paths out of runtime reader and retention SQL", () => {
  const owners = [
    "../transcripts/store-read.ts",
    "../transcripts/store-sqlite.ts",
    "../infra/delivery-queue-sqlite-bound.ts",
  ];
  for (const owner of owners) {
    const source = fs.readFileSync(new URL(owner, import.meta.url), "utf8");
    expect(source, owner).not.toMatch(
      /\$\.(?:accountId|guildId|channelId|meetingUrl|threadTs|fileId|agentId|overview|completionRetention)\b/u,
    );
  }
});

describe("schema 20 migration through shared-state owners", () => {
  const retainedJson = policy('"kept:"', "86400000");
  const directories = useAutoCleanupTempDirTracker((cleanup) => {
    afterAll(async () => {
      await closeState();
      cleanup();
    });
  });
  let template: string;

  beforeAll(async () => {
    const stateDir = directories.make("state-v20-column-template-");
    const current = openState({ env: { OPENCLAW_STATE_DIR: stateDir } });
    template = current.path;
    await closeState();
    using db = new DatabaseSync(template);
    addPreCutoverClientCredentialTablesForTest(db);
    db.exec(`DROP INDEX idx_meeting_transcript_sessions_source;
      DROP INDEX idx_meeting_transcript_sessions_account;
      DROP INDEX idx_meeting_transcript_sessions_agent;
      DROP INDEX idx_delivery_queue_bounded_retention;`);
    for (const column of sessionColumns) {
      db.exec(`ALTER TABLE meeting_transcript_sessions DROP COLUMN ${column}`);
    }
    db.exec("ALTER TABLE meeting_transcript_summaries DROP COLUMN overview");
    for (const column of retentionColumns) {
      db.exec(`ALTER TABLE delivery_queue_entries DROP COLUMN ${column}`);
    }
    db.exec(`PRAGMA user_version = 20;
      UPDATE schema_meta SET schema_version = 20;
      DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion';
      INSERT INTO meeting_transcript_sessions
        (session_id, started_at, selector, export_key, session_slug, provider_id, source_json, metadata_json, created_at_ms, updated_at_ms)
        VALUES ('capture', '2026-10-01', 'capture-selector', 'capture-export', 'capture-slug', 'synthetic', '{"accountId":"account","channelId":"channel"}', '{"agentId":"main"}', 1, 1);
      INSERT INTO meeting_transcript_summaries
        (session_id, session_started_at, summary_json, utterance_count)
        VALUES ('capture', '2026-10-01', '{"overview":"retained overview"}', 0);`);
    const now = Date.now();
    db.prepare(`INSERT INTO delivery_queue_entries
      (queue_name, id, status, recovery_state, entry_json, enqueued_at, updated_at)
      VALUES ('synthetic', 'kept:row', 'completed', 'completed_bounded', ?, ?, ?)`).run(
      retainedJson,
      now,
      now,
    );
  });

  it.each(["runtime", "doctor"] as const)(
    "migrates retained rows through captured %s without rewriting canonical JSON",
    async (owner) => {
      const stateDir = directories.make(`state-v20-${owner}-`);
      const pathname = resolveStatePath({ OPENCLAW_STATE_DIR: stateDir });
      fs.mkdirSync(path.dirname(pathname), { recursive: true });
      fs.copyFileSync(template, pathname);
      const options = { env: { OPENCLAW_STATE_DIR: stateDir }, path: pathname };
      const historicalFailures = [
        {
          id: "boolean:row",
          json: policy('"boolean:"', "86400000", "true"),
          expected: retention(["boolean:", 86400000, 1]),
        },
        {
          id: "real:row",
          json: policy('"real:"', "1.0"),
          expected: retention(),
        },
      ];
      if (owner === "runtime") {
        using old = new DatabaseSync(pathname);
        const insert = old.prepare(`INSERT INTO delivery_queue_entries
          (queue_name, id, status, recovery_state, entry_json, enqueued_at, updated_at, failed_at)
          VALUES ('synthetic', ?, 'failed', 'completed_bounded', ?, ?, ?, ?)`);
        const now = Date.now();
        for (const row of historicalFailures) {
          insert.run(row.id, row.json, now, now, now);
        }
      }
      await withStateMigrationBackupForTest(options, () => {
        if (owner === "doctor") {
          expect(repairSchema(options).warnings).toEqual([]);
        }
        openState(options);
      });
      const { db } = openState(options);
      expectRow(db, "PRAGMA user_version", {
        user_version: SCHEMA_VERSION,
      });
      expectRow(db, "SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'", {
        schema_version: SCHEMA_VERSION,
      });
      expectRow(
        db,
        "SELECT source_account_id, source_channel_id, metadata_agent_id, source_json, metadata_json FROM meeting_transcript_sessions",
        {
          source_account_id: "account",
          source_channel_id: "channel",
          metadata_agent_id: "main",
          source_json: '{"accountId":"account","channelId":"channel"}',
          metadata_json: '{"agentId":"main"}',
        },
      );
      expectRow(db, "SELECT overview, summary_json FROM meeting_transcript_summaries", {
        overview: "retained overview",
        summary_json: '{"overview":"retained overview"}',
      });
      expectRow(
        db,
        `SELECT ${retentionColumns.join(", ")}, entry_json FROM delivery_queue_entries WHERE id = 'kept:row'`,
        {
          ...retention(["kept:", 86400000, 2]),
          entry_json: retainedJson,
        },
      );
      if (owner === "runtime") {
        for (const row of historicalFailures) {
          expectRow(
            db,
            `SELECT ${retentionColumns.join(", ")}, entry_json, status FROM delivery_queue_entries WHERE id = ?`,
            {
              ...row.expected,
              entry_json: row.json,
              status: "failed",
            },
            row.id,
          );
        }
      }
      await closeState();
    },
  );
});
