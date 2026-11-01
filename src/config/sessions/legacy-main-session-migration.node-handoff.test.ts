import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import type { SQLOutputValue } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
} from "../../session-cards/progress-card-store.js";
import { ensureOpenClawAgentBoardSchemaInTransaction } from "../../state/openclaw-agent-board-schema.js";
import { ensureSessionParticipantsSchema } from "../../state/openclaw-agent-session-participants-schema.js";
import { createLegacyMainSessionHandoff } from "./legacy-main-session-migration.handoff-fixture.test-support.js";
import {
  readClaim,
  setupLegacyMainSessionMigrationTests,
  type ClaimTarget,
} from "./legacy-main-session-migration.test-support.js";
import { recordLegacyAcpMigrationSources } from "./session-accessor.sqlite-acp-provenance.js";

const { createFixture } = setupLegacyMainSessionMigrationTests();
const rekey = (rows: Record<string, SQLOutputValue>[], sessionKey: string) =>
  rows.map((row) => ({ ...row, session_key: sessionKey }));

function createNodeHandoff(existingCanonical = false) {
  const handoff = createLegacyMainSessionHandoff(createFixture(), "node-artifact-handoff");
  const { destination, withDatabase } = handoff;
  if (existingCanonical) {
    handoff.seed(destination);
  }
  const artifacts = (target: ClaimTarget) =>
    withDatabase(target, ({ db }) => {
      const tables = new Set(
        db
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
          .all()
          .map((row) => row.name),
      );
      const rows = (table: string, order: string) =>
        tables.has(table)
          ? db
              .prepare(`SELECT * FROM ${table} WHERE session_key = ? ORDER BY ${order}`)
              .all(target.key)
          : [];
      return {
        tabs: rows("board_tabs", "tab_id"),
        widgets: rows("board_widgets", "name"),
        progress: rows("session_progress_cards", "session_key"),
        heartbeat: rows("heartbeat_outcomes", "session_key"),
        suggestions: rows("session_suggestions", "id"),
        participants: rows("session_participants", "identity_namespace, actor_id"),
        members: rows("session_members", "identity_id"),
      };
    });
  const seedArtifacts = (target: ClaimTarget, label: "source" | "destination") =>
    withDatabase(target, ({ db }) => {
      ensureOpenClawAgentBoardSchemaInTransaction(db);
      ensureSessionParticipantsSchema(db);
      const fromSource = label === "source";
      const html = Buffer.from(`<p>${label} board: café 🦞</p>`);
      const sha256 = createHash("sha256").update(html).digest("hex");
      // Interpolated values are fixed synthetic fixture data, never external input.
      db.exec(`INSERT INTO board_tabs
        (session_key, tab_id, title, position, chat_dock, created_by, revision)
        VALUES ('${target.key}', 'main', '${label} tab', 0, 'right', 'user', ${fromSource ? 2 : 3});
        INSERT INTO board_widgets
        (session_key, name, tab_id, title, content_kind, html, sha256, view_generation,
          revision, size_w, size_h, position, created_by, created_at, updated_at)
        VALUES ('${target.key}', 'status', 'main', '${label} widget', 'html',
          X'${html.toString("hex")}', '${sha256}', '${(fromSource ? "a" : "b").repeat(32)}',
          ${fromSource ? 4 : 3}, 6, 4, 0, 'user', 1, ${fromSource ? 10 : 20});`);
      writeSessionProgressCard(db, target.key, {
        markdown: `${label} progress`,
        steps: [{ step: "Finish the retained task", status: "in_progress" }],
      });
      db.exec(`INSERT INTO heartbeat_outcomes
        (session_key, run_session_key, outcome, summary, occurred_at, updated_at)
        VALUES ('${target.key}', '${target.key}', 'progress', '${label} heartbeat',
          ${fromSource ? 10 : 20}, ${fromSource ? 10 : 20});
        INSERT INTO session_suggestions
        (id, session_key, author_id, text, created_at, state)
        VALUES ('${label}-suggestion', '${target.key}', 'author', '${label} suggestion', 1, 'pending');
        INSERT INTO session_participants
        (session_key, identity_namespace, actor_id, contribution_count, first_prompted_at, last_prompted_at)
        VALUES ('${target.key}', '{"type":"profile"}', 'participant',
          ${fromSource ? 3 : 5}, ${fromSource ? 10 : 5}, ${fromSource ? 30 : 20});`);
    });
  return { ...handoff, artifacts, seedArtifacts };
}

describe("legacy main session node artifact handoff", () => {
  it("preserves boards and logical-session artifacts before retiring a cross-store source", async () => {
    const f = createNodeHandoff();
    f.seedArtifacts(f.source, "source");
    const provenance = {
      sourcePath: `${f.source.databasePath}.legacy-acp.json`,
      sourceSessionKey: f.source.key,
      sessionId: f.entry.sessionId,
      sourceSha256: "c".repeat(64),
      sourceSizeBytes: 47,
    };
    f.withDatabase(f.source, ({ db }) => {
      recordLegacyAcpMigrationSources(db, f.source.key, [provenance]);
    });
    const readProvenance = (target: ClaimTarget): unknown =>
      f.withDatabase(target, ({ db }) => {
        const row = db
          .prepare("SELECT legacy_acp_migration_json FROM session_nodes WHERE session_key = ?")
          .get(target.key);
        const value = row?.legacy_acp_migration_json;
        return typeof value === "string" ? JSON.parse(value) : undefined;
      });
    const before = f.artifacts(f.source);
    expect(before.tabs).toHaveLength(1);
    expect(before.widgets).toHaveLength(1);
    expect(await f.migrate()).toMatchObject({ complete: true });

    expect(f.artifacts(f.destination)).toEqual({
      ...Object.fromEntries(
        Object.entries(before).map(([key, rows]) => [key, rekey(rows, f.destination.key)]),
      ),
      heartbeat: rekey(before.heartbeat, f.destination.key).map((row) =>
        Object.assign({}, row, { run_session_key: f.destination.key }),
      ),
      members: [],
    });
    expect(readClaim(f.source)).toBeUndefined();
    expect(readProvenance(f.source)).toBeUndefined();
    expect(readProvenance(f.destination)).toEqual([provenance]);
    expect(f.artifacts(f.source)).toEqual(
      Object.fromEntries(Object.keys(before).map((key) => [key, []])),
    );
    const retained = f.artifacts(f.destination);
    expect(await f.migrate()).toMatchObject({ complete: true, ledgerComplete: true });
    expect(f.artifacts(f.destination)).toEqual(retained);
    expect(readProvenance(f.destination)).toEqual([provenance]);
  });

  it("merges artifact revisions while preserving canonical membership and completed state", async () => {
    const f = createNodeHandoff(true);
    f.seedArtifacts(f.source, "source");
    f.seedArtifacts(f.destination, "destination");
    for (const [target, member] of [
      [f.source, "source-only-member"],
      [f.destination, "canonical-member"],
    ] as const) {
      f.withDatabase(target, ({ db }) => {
        db.prepare(`INSERT INTO session_members (session_key, identity_id, added_by, added_at)
          VALUES (?, ?, 'owner', 1)`).run(target.key, member);
      });
    }
    f.withDatabase(f.destination, ({ db }) => {
      writeSessionProgressCard(db, f.destination.key, {});
      db.prepare(`INSERT INTO session_suggestions
        (id, session_key, author_id, text, created_at, state)
        VALUES ('source-suggestion', ?, 'author', 'Already resolved here', 2, 'accepted')`).run(
        f.destination.key,
      );
    });
    const source = f.artifacts(f.source);
    const canonical = f.artifacts(f.destination);

    expect(await f.migrate()).toMatchObject({ complete: true });

    const after = f.artifacts(f.destination);
    expect(after).toEqual({
      ...canonical,
      widgets: rekey(source.widgets, f.destination.key),
      participants: canonical.participants.map((row) =>
        Object.assign({}, row, { last_prompted_at: 30 }),
      ),
    });
    expect(
      f.withDatabase(f.destination, ({ db }) => readSessionProgressCard(db, f.destination.key)),
    ).toBeNull();
    expect(readClaim(f.source)).toBeUndefined();
    expect(await f.migrate()).toMatchObject({ complete: true, ledgerComplete: true });
    expect(f.artifacts(f.destination)).toEqual(after);
  });

  it.each([
    { side: "source", artifact: "widget" },
    { side: "destination", artifact: "membership" },
  ] as const)(
    "retains both nodes when $side $artifact changes after cleanup planning",
    async ({ side, artifact }) => {
      const f = createNodeHandoff(true);
      f.seedArtifacts(f.source, "source");
      f.seedArtifacts(f.destination, "source");
      const sourceBefore = readClaim(f.source);
      const artifactsBefore = f.artifacts(f.source);
      const target = side === "source" ? f.source : f.destination;
      const changedHtml = Buffer.from("<p>edited board: café 🦞</p>");
      let injected = false;
      let changedRows = 0;
      let mutationError: unknown;
      let copiedArtifacts: ReturnType<typeof f.artifacts> | undefined;
      let changedArtifacts: ReturnType<typeof f.artifacts> | undefined;
      const diagnostics = channel("openclaw.session.write");
      const onPlanningComplete = (message: unknown) => {
        if (
          injected ||
          !isRecord(message) ||
          message.operation !== "session.lifecycle.delete-prepare" ||
          message.writer !== "foreground" ||
          message.outcome !== "ok"
        ) {
          return;
        }
        injected = true;
        // The copy is committed and planning has released its transaction; the worker has not started.
        try {
          copiedArtifacts = f.artifacts(f.destination);
          expect(copiedArtifacts.widgets).toHaveLength(1);
          f.withDatabase(target, ({ db }) => {
            const get = (sql: string) => db.prepare(sql).get(target.key);
            const readNode = () => ({
              entry: get(`SELECT entry_json, current_session_id, updated_at
                FROM session_nodes WHERE session_key = ?`),
              windows: db
                .prepare("SELECT * FROM session_windows WHERE session_key = ? ORDER BY session_id")
                .all(target.key),
            });
            const nodeBefore = readNode();
            const readWidget = () =>
              get(`SELECT revision, sha256, updated_at, length(html) AS bytes
              FROM board_widgets WHERE session_key = ? AND name = 'status'`);
            const widgetBefore = readWidget();
            const mutation =
              artifact === "widget"
                ? "UPDATE board_widgets SET html = ? WHERE session_key = ? AND name = 'status'"
                : "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES (?, 'late-member', 'owner', 30)";
            changedRows = Number(
              db
                .prepare(mutation)
                .run(...(artifact === "widget" ? [changedHtml, target.key] : [target.key])).changes,
            );
            expect(readNode()).toEqual(nodeBefore);
            expect(readWidget()).toEqual(widgetBefore);
            if (artifact === "widget") {
              expect(
                get(
                  "SELECT hex(html) AS html FROM board_widgets WHERE session_key = ? AND name = 'status'",
                ),
              ).toEqual({ html: changedHtml.toString("hex").toUpperCase() });
            }
          });
          changedArtifacts = f.artifacts(target);
          if (artifact === "membership") {
            expect(changedArtifacts.members).toContainEqual({
              session_key: target.key,
              identity_id: "late-member",
              added_by: "owner",
              added_at: 30,
            });
          }
        } catch (error) {
          // Diagnostics subscribers report their errors here instead of throwing outside the awaited migration.
          mutationError = error;
        }
      };
      diagnostics.subscribe(onPlanningComplete);
      try {
        if (side === "destination") {
          await expect(f.migrate()).rejects.toThrow(
            "Canonical session changed before legacy cleanup: agent:ops:chat",
          );
        } else {
          expect((await f.migrate()).complete).toBe(false);
        }
        expect(mutationError).toBeUndefined();
        expect(changedRows).toBe(1);
        expect(readClaim(f.source)).toEqual(sourceBefore);
        expect(readClaim(f.destination)?.entry).toMatchObject(sourceBefore!.entry);
        expect(f.artifacts(target)).toEqual(changedArtifacts);
        expect(f.artifacts(side === "source" ? f.destination : f.source)).toEqual(
          side === "source" ? copiedArtifacts : artifactsBefore,
        );
      } finally {
        diagnostics.unsubscribe(onPlanningComplete);
      }
    },
  );
});
