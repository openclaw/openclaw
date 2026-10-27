import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getEnvironmentData } from "node:worker_threads";
import { sql, type Compilable } from "kysely";
import { expect, it } from "vitest";
import {
  LEGACY_MISSING_TOOL_RESULT_TEXT,
  SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY,
} from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import {
  legacyModelContextEventSql,
  legacyModelNavigationSql,
} from "../../config/sessions/session-model-context-legacy.test-support.js";
import {
  projectModelContextEventSql,
  projectModelContextNavigationSql,
  projectResetBoundaryNavigationSql,
  projectPostgresModelContextRowsSql,
} from "../../config/sessions/session-model-context-projection.js";
import {
  copyRetainedTranscriptPayload,
  projectTranscriptRetainedDataSql,
} from "../../config/sessions/session-transcript-retained-data.js";
import { createTranscriptEventInserter } from "../../config/sessions/transcript-payload.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { PostgresSyncConnection } from "../postgres-sync/connection.js";
import { admitSqliteSchema } from "../sqlite-schema-facts.js";
import { withEngineStoreAdmission } from "./admission-scope.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const messageEvent = (message: Record<string, unknown>) => ({ type: "message", message });
const readRows = <Row>(db: DatabaseSync, query: Compilable<Row>) =>
  executeSqliteQuerySync(db, query).rows;
const decodeViews = (views: Record<string, string>) =>
  Object.fromEntries(Object.entries(views).map(([key, value]) => [key, JSON.parse(value)]));
const fixtures = [
  messageEvent({
    role: "user",
    content: "λ🦞",
    __openclaw: { upstreamUserText: "private" },
    providerReplay: { type: "fixture" },
  }),
  messageEvent({
    role: "assistant",
    content: [
      { type: "toolCall", id: "call", name: "tool", arguments: { opaque: true } },
      { type: "toolUse", id: "use" },
      { type: "functionCall", name: "fn" },
    ],
  }),
  messageEvent({
    role: "toolResult",
    content: [{ type: "text", text: "result" }],
    details: { [SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY]: true },
    providerReplay: { type: "fixture" },
  }),
  messageEvent({
    role: "toolResult",
    content: [{ type: "text", text: LEGACY_MISSING_TOOL_RESULT_TEXT }],
  }),
  ...["prompt-update", "runtime-context", "other"].flatMap((kind) => [
    messageEvent({ role: "user", customType: "openclaw.system-update", details: { kind } }),
    {
      type: "custom_message",
      customType: "openclaw.system-update",
      details: { kind },
      content: "private",
      display: true,
    },
  ]),
  ...[{}, { restart: false }, { restart: true }].map((data) => ({
    type: "custom",
    customType: "openclaw.system-prompt",
    data,
  })),
  { type: "custom", id: "retained", data: { opaque: "λ🦞", nested: [true, null] } },
  { type: "compaction", summary: "private summary", firstKeptEntryId: "kept" },
  { type: "branch_summary", summary: "private branch summary", fromId: "from" },
  { type: "reset", firstKeptEntryId: "kept", reason: "reset" },
  { type: "unknown", unknown: { content: "preserved" }, timestamp: null },
  messageEvent({ role: null, content: null, providerReplay: null }),
  messageEvent({ content: [{ type: "toolCall" }], providerReplay: {} }),
  messageEvent({ role: "unknown", content: [null, 17, "text", { type: "unknown" }] }),
].map((event, index) => Object.assign({ id: `entry-${index}`, parentId: "old-parent" }, event));
const exactJsonFixtures = [
  '{"type":"reset","timestamp":1.00}',
  '{"type":"reset","timestamp":1e-7}',
  '{"type":"reset","reason":"\\uD83E\\uDD9E \\u03bb \\n \\\""}',
  '{"type":"message","message":{"role":"user","content":"日本語 🦞","__openclaw":{"upstreamUserText":"private","runId":"kept"}}}',
  '{"type":"message","message":{"role":"toolResult","details":{"openclawSyntheticMissingToolResult":1.00},"content":[],"providerReplay":{"type":"checkpoint","number":1e20}}}',
  '{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":null,"name":{"unknown":1.00}}],"unknown":null}}',
];
const passthrough = ["{ malformed", "null", "true", "17", '"text"', "[]"];
const schema = `CREATE TABLE transcript_events (
  session_id TEXT NOT NULL, seq INTEGER PRIMARY KEY, event_json TEXT, event_zstd BYTEA,
  event_utf8_bytes INTEGER, navigation_json TEXT, navigation_type TEXT, navigation_custom_type TEXT,
  navigation_display INTEGER, message_role TEXT, navigation_last_type TEXT,
  navigation_last_custom_type TEXT, navigation_valid INTEGER, created_at INTEGER
)`;

it.skipIf(typeof connection !== "string")(
  "keeps transcript projections and retained copies equal on SQLite and PostgreSQL",
  () => {
    withEngineStoreAdmission(() => {
      using sqlite = openNodeSqliteDatabase(":memory:");
      using anchor = openNodeSqliteDatabase(":memory:");
      const namespace = `reader_${randomUUID().replaceAll("-", "")}`;
      const remote = new PostgresSyncConnection(connection!, namespace, anchor, namespace);
      // Session owners still annotate handles as DatabaseSync; exercise their real PostgreSQL branch.
      // @ts-expect-error -- The PostgreSQL bridge deliberately lacks unused SQLite-only methods.
      const postgres: DatabaseSync = remote;
      const databases = [sqlite, postgres];
      const table = (db: DatabaseSync) =>
        getNodeSqliteKysely<DB>(db).selectFrom("transcript_events").orderBy("seq");
      const setEnvelope = (navigation: string | null, eventJson: string) =>
        remote
          .prepare("UPDATE transcript_events SET navigation_json = ?, event_json = ? WHERE seq = 0")
          .run(navigation, eventJson);
      try {
        remote.exec(`CREATE SCHEMA "${namespace}"`);
        for (const db of databases) {
          db.exec(schema);
          if (db === sqlite) {
            admitSqliteSchema(db);
          }
          const insert = createTranscriptEventInserter(db, "conformance");
          [
            ...fixtures.map((event) => JSON.stringify(event)),
            ...passthrough,
            ...exactJsonFixtures,
          ].forEach((eventJson, seq) => insert({ seq, eventJson, createdAt: 1 }));
        }
        const event =
          /* kysely-allow-raw: The fixture table owns this fixed JSON column. */ sql.ref<string>(
            "event_json",
          );
        const validRows = table(postgres).where((eb) =>
          eb.or([
            eb("seq", "<", fixtures.length),
            eb("seq", ">=", fixtures.length + passthrough.length),
          ]),
        );
        const legacy = readRows(
          postgres,
          validRows.select([
            "seq",
            legacyModelNavigationSql(
              postgres,
              event,
              /* kysely-allow-raw: The original query extracted its discriminant from JSONB. */ sql`${event}::jsonb ->> 'type'`,
            ).as("navigation_json"),
            /* kysely-allow-raw: Frozen legacy model-byte expression is the independent oracle. */ sql<number>`octet_length(${legacyModelContextEventSql(postgres, event, sql.lit(0))})`.as(
              "model_bytes",
            ),
            /* kysely-allow-raw: Frozen legacy retained-byte expression is the independent oracle. */ sql<number>`octet_length(${legacyModelContextEventSql(postgres, event, sql.lit(1))})`.as(
              "retained_bytes",
            ),
          ]),
        );
        const native = () =>
          readRows(
            postgres,
            getNodeSqliteKysely(postgres)
              .selectFrom(
                projectPostgresModelContextRowsSql(
                  validRows.select(["seq", "event_json", "navigation_json"]),
                ).as("context"),
              )
              .selectAll(),
          );
        expect(native()).toEqual(legacy);
        // Existing stored envelopes bypass canonical JSON parsing even when its text is unavailable.
        setEnvelope(
          JSON.stringify({
            model: JSON.parse(legacy[0]!.navigation_json),
            modelBytes: legacy[0]!.model_bytes,
            modelWithoutCheckpointBytes: legacy[0]!.retained_bytes,
          }),
          "{ unavailable",
        );
        try {
          expect(native()).toEqual(legacy);
        } finally {
          setEnvelope(null, JSON.stringify(fixtures[0]));
        }
        for (const omit of [0, 1]) {
          for (const notice of [false, true]) {
            const projections = databases.map((db) =>
              readRows(
                db,
                table(db)
                  .select([
                    "seq",
                    projectModelContextNavigationSql(db, event).as("navigation"),
                    projectModelContextEventSql(
                      db,
                      event,
                      sql.lit(omit),
                      notice ? sql.lit("omitted result") : undefined,
                    ).as("model"),
                    projectResetBoundaryNavigationSql(db, event).as("reset"),
                    projectTranscriptRetainedDataSql(db, event, ["retained"]).as("retained"),
                  ])
                  .where("seq", "<", fixtures.length),
              ).map(({ seq, ...views }) => Object.assign({ seq }, decodeViews(views))),
            );
            expect(projections[0]).toHaveLength(fixtures.length);
            expect(projections[1], `omit=${omit}, notice=${String(notice)}`).toEqual(
              projections[0],
            );
          }
        }
        for (const db of databases) {
          const rows = readRows(
            db,
            table(db)
              .select(projectResetBoundaryNavigationSql(db, event).as("reset"))
              .where("seq", ">=", fixtures.length)
              .where("seq", "<", fixtures.length + passthrough.length),
          );
          expect(rows.map((row) => row.reset)).toEqual(passthrough);
        }
        const source = fixtures.findIndex((row) => row.id === "retained");
        const unused = (): never => {
          throw new Error("Copy must not access unrelated WAL maintenance");
        };
        const walMaintenance = {
          checkpoint: unused,
          reclaimFreePages: unused,
          stop: unused,
          close: unused,
        };
        for (const parentId of [null, "repaired-parent"]) {
          const copies = databases.map((db) => {
            const destination = parentId === null ? 1000 : 1001;
            const owner = { db, agentId: "conformance", path: ":memory:", walMaintenance };
            copyRetainedTranscriptPayload(owner, "conformance", source, destination, parentId);
            const row = readRows(
              db,
              table(db)
                .select(["event_json", "event_utf8_bytes"])
                .select((eb) =>
                  eb.fn<number>("octet_length", [eb.ref("event_json")]).as("actual_bytes"),
                )
                .where("seq", "=", destination),
            )[0]!;
            if (db === postgres) {
              expect(row.event_utf8_bytes).toBe(row.actual_bytes);
              expect(row.event_utf8_bytes).toBe(Buffer.byteLength(row.event_json!, "utf8"));
            }
            return JSON.parse(row.event_json!);
          });
          expect(copies[1]).toEqual(copies[0]);
          expect(copies[1]).toEqual({ ...fixtures[source], parentId });
        }
      } finally {
        try {
          remote.exec(`DROP SCHEMA "${namespace}" CASCADE`);
        } finally {
          remote.close();
        }
      }
    });
  },
);
