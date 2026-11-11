import { sql } from "kysely";
import { beforeAll, describe, expect, it } from "vitest";
import { readSqliteSessionGenerationWindows } from "../../config/sessions/session-accessor.sqlite-generation-copy.js";
import { readTranscriptAppendIdentities } from "../../config/sessions/session-accessor.sqlite-transcript-identity.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { executeSqliteQuerySync, getNodeSqliteKysely, sqliteStringSet } from "../kysely-sync.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { runSqliteImmediateTransactionSync } from "../sqlite-transaction.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

const selectionCases = [
  { name: "empty", values: [], expected: [] },
  { name: "duplicates", values: ["beta", "alpha", "beta", "absent"], expected: ["alpha", "beta"] },
];

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(
    `${engine} string-set semantics`,
    () => {
      useMixedAgentPair(engine, engine);
      const database = () => openOpenClawAgentDatabase({ agentId: "string-set" });

      beforeAll(() =>
        withEngineStoreAdmission(() => {
          const { db } = database();
          runSqliteImmediateTransactionSync(db, () => {
            const node = db.prepare(
              "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, '{}', 1)",
            );
            const window = db.prepare(
              "INSERT INTO session_windows (session_id, session_key, created_at, updated_at) VALUES (?, ?, 1, 1)",
            );
            const event = db.prepare(
              "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES ('alpha', ?, '{}', 1)",
            );
            const identity = db.prepare(
              "INSERT INTO transcript_event_identities (session_id, event_id, seq, message_idempotency_key, created_at) VALUES ('alpha', ?, ?, ?, 1)",
            );
            for (const [index, id] of ["alpha", "beta", "unrelated"].entries()) {
              node.run(`key-${id}`, id);
              window.run(id, `key-${id}`);
              event.run(index);
              identity.run(id, index, `message-${id}`);
            }
          });
        }),
      );

      it.each(selectionCases)(
        "preserves $name session-generation selection",
        ({ values, expected }) =>
          withEngineStoreAdmission(() => {
            const current = database();
            const keys = values.map((id) => `key-${id}`);
            expect(
              readSqliteSessionGenerationWindows(current, keys, values).map(
                (row) => row.session_id,
              ),
            ).toEqual(expected);
          }),
      );

      it.each(selectionCases)("preserves $name transcript identities", ({ values, expected }) =>
        withEngineStoreAdmission(() => {
          const current = database();
          expect(
            readTranscriptAppendIdentities(current, "alpha", values, [])
              .map((row) => row.event_id)
              .toSorted(),
          ).toEqual(expected);
        }),
      );

      it("round-trips array punctuation, whitespace, Unicode, and USV replacement", () =>
        withEngineStoreAdmission(() => {
          const { db } = database();
          const query = getNodeSqliteKysely<DB>(db);
          for (const [input, expected] of [
            ['quote"', 'quote"'],
            ["back\\slash", "back\\slash"],
            ["comma,value", "comma,value"],
            ["{braces}", "{braces}"],
            [" leading and trailing ", " leading and trailing "],
            ["", ""],
            ["NULL", "NULL"],
            ["λ日本語🦞", "λ日本語🦞"],
            ["\ud800lone\udfff", "�lone�"],
          ] as const) {
            const set = sqliteStringSet([input]);
            const result = executeSqliteQuerySync(
              db,
              query
                .selectNoFrom((eb) => eb.val<string>(expected).as("value"))
                .where((eb) => eb(eb.val<string>(expected), "in", set)),
            ).rows;
            expect(result).toEqual([{ value: expected }]);
          }
        }));

      it.skipIf(engine !== "postgres")(
        "uses indexed ANY conditions for sparse generation reads",
        () =>
          withEngineStoreAdmission(() => {
            const { db } = database();
            if (!isPostgresSqlConnection(db)) {
              throw new Error("PostgreSQL plan proof needs PostgreSQL");
            }
            runSqliteImmediateTransactionSync(db, () => {
              db.exec(
                "INSERT INTO session_windows (session_id, session_key, created_at, updated_at) SELECT 'noise-' || n, 'key-unrelated', 1, 1 FROM generate_series(1, 30000) AS n",
              );
            });
            db.exec("ANALYZE session_windows");
            const query = getNodeSqliteKysely<DB>(db)
              .selectFrom("session_windows")
              .selectAll()
              .where((eb) =>
                eb.or([
                  eb("session_key", "in", sqliteStringSet(["key-alpha"])),
                  eb("session_id", "in", sqliteStringSet(["beta"])),
                ]),
              )
              .orderBy("session_id");
            const compiled =
              /* kysely-allow-raw: EXPLAIN prefixes the real query under test. */ sql<{
                "QUERY PLAN": string;
              }>`EXPLAIN (ANALYZE, BUFFERS) ${query}`.compile(getNodeSqliteKysely<DB>(db));
            const plan = executeSqliteQuerySync(db, { compile: () => compiled });
            const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
            expect(text).not.toMatch(/Seq Scan|Hash Semi Join/);
            expect(text).toMatch(/(?:Index|Bitmap).*Scan/);
            expect(text).toMatch(/Index Cond:.*= ANY/);
            expect(executeSqliteQuerySync(db, query).rows.map((row) => row.session_id)).toEqual([
              "alpha",
              "beta",
            ]);
          }),
      );
    },
  );
}
