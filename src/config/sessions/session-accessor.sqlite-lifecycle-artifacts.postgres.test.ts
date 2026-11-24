import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createCanonicalRepairFixture } from "../../commands/doctor-session-repair-fixture.test-support.js";
import {
  installDatabaseProcessRole,
  withEngineStoreAdmission as admit,
} from "../../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "../../infra/database-engine/mixed-agent.conformance.test-support.js";
import * as queries from "../../infra/kysely-sync.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { applySessionPatchProjection } from "./session-accessor.lifecycle.js";
import { cleanupSessionLifecycleArtifactsCore } from "./session-accessor.sqlite-artifact-cleanup.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry-replace.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { planSessionLifecycleArtifactCleanup } from "./session-accessor.sqlite-lifecycle-artifacts.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL lifecycle artifact cleanup", () => {
  useMixedAgentPair("postgres", "postgres");

  it("cleans old marked historical windows while retaining fresh and unrelated history", async () => {
    const agentId = "main";
    const now = Date.now();
    const old = now - 600_000;
    const marker = "lifecycle%_pg-marker";
    const options = { agentId, env: process.env };
    const database = admit(() => openOpenClawAgentDatabase(options));
    admit(() =>
      runOpenClawAgentWriteTransaction((writer) => {
        for (const id of ["marked", "fresh", "unrelated"]) {
          const sessionKey = `agent:main:${id}`;
          // Public rollover retains lineage; seed genuinely unreferenced history.
          writeSessionEntry(writer, sessionKey, { sessionId: id, updatedAt: old });
          appendTranscriptEventsInTransaction(writer, { ...options, sessionKey, sessionId: id }, [
            {
              type: "metadata",
              timestamp: new Date(old).toISOString(),
              marker: id === "unrelated" ? "lifecycleXXpg-marker" : marker,
            },
            ...(id === "fresh"
              ? [{ type: "metadata", timestamp: new Date(now).toISOString() }]
              : []),
          ]);
          writeSessionEntry(writer, sessionKey, { sessionId: `${id}-current`, updatedAt: now });
        }
      }, options),
    );

    const markerReads = vi.spyOn(queries, "iterateSqliteQuerySync");
    try {
      const plan = admit(() =>
        planSessionLifecycleArtifactCleanup(database, {
          agentId,
          sessionKeySegmentPrefix: "unused-",
          transcriptContentMarker: marker,
          orphanTranscriptMinAgeMs: 300_000,
          archiveRemovedEntryTranscripts: false,
          archiveDirectory: path.dirname(database.path),
          nowMs: now,
        }),
      );
      expect(plan.deletePlans.map((item) => item.sessionId)).toEqual(["marked"]);
      const markerSql = markerReads.mock.calls
        .map(([, query]) => query.compile().sql)
        .find((sql) => sql.includes('group by "session_id"'));
      // The PostgreSQL bridge buffers a statement's rows; payloads must stay in SQL.
      expect(markerSql).toMatch(/^select distinct "session_id" from "transcript_events"/);
      expect(markerSql).toContain("and strpos(");
    } finally {
      markerReads.mockRestore();
    }

    await expect(
      cleanupSessionLifecycleArtifactsCore({
        ...options,
        storePath: database.path,
        sessionKeySegmentPrefix: "unused-",
        transcriptContentMarker: marker,
        orphanTranscriptMinAgeMs: 300_000,
        archiveRemovedEntryTranscripts: false,
        nowMs: now,
      }),
    ).resolves.toEqual({ removedEntries: 0, archivedTranscriptArtifacts: 0 });
    expect(
      admit(() =>
        database.db
          .prepare("SELECT DISTINCT session_id FROM transcript_events ORDER BY session_id")
          .all(),
      ),
    ).toEqual([{ session_id: "fresh" }, { session_id: "unrelated" }]);
  });
});

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(
    `${engine} canonical session-key artifact repair`,
    () => {
      // Doctor owns offline, one-shot SQL admission. Runtime replacements still use their worker.
      beforeAll(() => installDatabaseProcessRole("cli-oneshot"));
      const pair = useMixedAgentPair("sqlite", engine);

      it("moves a board during runtime session-key replacement", async () => {
        const fixture = createCanonicalRepairFixture(pair.root);
        const canonicalKey = "agent:main:board-canonical";
        const legacyKey = "agent:main:board-alias";
        admit(() => {
          replaceSessionEntrySync(
            { ...fixture.scope(), sessionKey: legacyKey },
            {
              sessionId: "board-history",
              updatedAt: 10,
            },
          );
          runOpenClawAgentWriteTransaction(
            ({ db }) => {
              db.prepare(
                "INSERT INTO board_tabs (session_key, tab_id, title, position, created_by, revision) VALUES (?, 'tab', 'Agenda', 0, 'user', 1)",
              ).run(legacyKey);
            },
            { ...fixture.scope(), path: fixture.database().path },
          );
        });

        await expect(
          applySessionPatchProjection({
            agentId: "main",
            storePath: fixture.scope().storePath,
            sessionKeys: [legacyKey, canonicalKey],
            resolveTarget: () => ({
              primaryKey: canonicalKey,
              candidateKeys: [legacyKey, canonicalKey],
            }),
            project: ({ existingEntry }) => ({ ok: true, entry: existingEntry! }),
          }),
        ).resolves.toMatchObject({ ok: true });
        admit(() => {
          expect(fixture.load(legacyKey)).toBeUndefined();
          expect(fixture.load(canonicalKey)?.entry.sessionId).toBe("board-history");
          expect(
            fixture
              .database()
              .db.prepare("SELECT session_key, title FROM board_tabs WHERE session_key IN (?, ?)")
              .all(legacyKey, canonicalKey),
          ).toEqual([{ session_key: canonicalKey, title: "Agenda" }]);
        });
      });

      it("merges artifacts by revision and timestamp without replacing newer destinations", async () => {
        const fixture = createCanonicalRepairFixture(pair.root);
        const cases = [
          {
            name: "Absent",
            revision: null,
            updatedAt: 0,
            occurredAt: 0,
            tab: "source",
            rest: "source",
          },
          {
            name: "Older",
            revision: 1,
            updatedAt: 10,
            occurredAt: 10,
            tab: "source",
            rest: "source",
          },
          {
            name: "TieOlder",
            revision: 2,
            updatedAt: 10,
            occurredAt: 10,
            tab: "destination",
            rest: "source",
          },
          {
            name: "Newer",
            revision: 3,
            updatedAt: 30,
            occurredAt: 30,
            tab: "destination",
            rest: "destination",
          },
          {
            name: "TieNewer",
            revision: 2,
            updatedAt: 30,
            occurredAt: 30,
            tab: "destination",
            rest: "destination",
          },
          {
            name: "TimeTie",
            revision: 2,
            updatedAt: 20,
            occurredAt: 10,
            tab: "destination",
            rest: "destination",
          },
        ];
        admit(() => {
          for (const row of cases) {
            const target = `!${row.name}:example.org`;
            const canonicalKey = `agent:main:matrix:channel:${target}`;
            const legacyKey = canonicalKey.toLowerCase();
            for (const key of [legacyKey, ...(row.revision === null ? [] : [canonicalKey])]) {
              fixture.insert(key, {
                sessionId: `${row.name}-${key === legacyKey ? "source" : "destination"}`,
                updatedAt: 10,
                chatType: "channel",
                delivery: normalizeSessionDeliveryState({
                  context: { channel: "matrix", to: target },
                }),
              });
            }
            runOpenClawAgentWriteTransaction(
              ({ db }) => {
                for (const [key, label, revision, updatedAt, occurredAt] of [
                  [legacyKey, "source", 2, 20, 20],
                  ...(row.revision === null
                    ? []
                    : [[canonicalKey, "destination", row.revision, row.updatedAt, row.occurredAt]]),
                ] as const) {
                  db.prepare(
                    "INSERT INTO board_tabs (session_key, tab_id, title, position, created_by, revision) VALUES (?, 'tab', ?, 0, 'user', ?)",
                  ).run(key, label, revision);
                  db.prepare(
                    "INSERT INTO board_widgets (session_key, name, tab_id, title, content_kind, descriptor_json, sha256, revision, size_w, size_h, position, created_by, created_at, updated_at) VALUES (?, 'widget', 'tab', ?, 'mcp-app', '{}', 'hash', ?, 1, 1, 0, 'user', 1, ?)",
                  ).run(key, label, revision, updatedAt);
                  db.prepare(
                    "INSERT INTO session_progress_cards (session_key, markdown, revision, created_at, updated_at) VALUES (?, ?, ?, 1, ?)",
                  ).run(key, label, revision, updatedAt);
                  db.prepare(
                    "INSERT INTO heartbeat_outcomes (session_key, run_session_key, outcome, summary, occurred_at, updated_at) VALUES (?, ?, 'progress', ?, ?, ?)",
                  ).run(key, key, label, occurredAt, updatedAt);
                }
              },
              { ...fixture.scope(), path: fixture.database().path },
            );
          }
        });

        await fixture.expectRepair({
          foundGroups: cases.length,
          repairedGroups: cases.length,
          removedRows: cases.length,
        });
        admit(() => {
          const db = fixture.database().db;
          for (const row of cases) {
            const canonicalKey = `agent:main:matrix:channel:!${row.name}:example.org`;
            expect(fixture.load(canonicalKey.toLowerCase())).toBeUndefined();
            expect(
              db.prepare("SELECT title FROM board_tabs WHERE session_key = ?").get(canonicalKey),
            ).toEqual({ title: row.tab });
            expect(
              db.prepare("SELECT title FROM board_widgets WHERE session_key = ?").get(canonicalKey),
            ).toEqual({ title: row.rest });
            expect(
              db
                .prepare("SELECT markdown FROM session_progress_cards WHERE session_key = ?")
                .get(canonicalKey),
            ).toEqual({ markdown: row.rest });
            expect(
              db
                .prepare(
                  "SELECT summary, run_session_key FROM heartbeat_outcomes WHERE session_key = ?",
                )
                .get(canonicalKey),
            ).toEqual({
              summary: row.name === "TimeTie" ? "source" : row.rest,
              run_session_key: canonicalKey,
            });
          }
        });
        await fixture.expectRepair({ foundGroups: 0, repairedGroups: 0 });
      });
    },
  );
}
