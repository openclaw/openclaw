import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionArchiveContentSync } from "../config/sessions/archive-compression.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  loadTranscriptEvents,
  loadExactSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { repairCanonicalSessionKeys } from "./doctor-session-canonical-keys.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

function insertLegacySession(params: {
  agentId: string;
  entry: SessionEntry;
  env: NodeJS.ProcessEnv;
  eventText?: string;
  sessionKey: string;
  storePath: string;
}): void {
  const database = openOpenClawAgentDatabase({
    agentId: params.agentId,
    env: params.env,
    path: resolveSqliteTargetFromSessionStorePath(params.storePath, {
      agentId: params.agentId,
      env: params.env,
    }).path,
  });
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(
      params.sessionKey,
      params.entry.sessionId,
      JSON.stringify(params.entry),
      params.entry.updatedAt,
    );
  database.db
    .prepare(
      "INSERT INTO session_windows (session_id, session_key, reason, session_scope, created_at, updated_at) VALUES (?, ?, 'initial', 'conversation', ?, ?)",
    )
    .run(params.entry.sessionId, params.sessionKey, params.entry.updatedAt, params.entry.updatedAt);
  if (params.eventText) {
    database.db
      .prepare(
        "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 0, ?, ?)",
      )
      .run(
        params.entry.sessionId,
        JSON.stringify({
          id: `${params.entry.sessionId}-message`,
          message: { content: params.eventText, role: "user" },
          parentId: null,
          type: "message",
        }),
        params.entry.updatedAt,
      );
  }
}

describe("doctor canonical session-key retention repair", () => {
  it("archives cross-store loser history before removing the duplicate", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-cross-store-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const mainStore = resolveStorePath(storeTemplate, { agentId: "main", env });
      const opsStore = resolveStorePath(storeTemplate, { agentId: "ops", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
        session: { mainKey: "shared", store: storeTemplate },
      } as OpenClawConfig;
      const sourceAlias = "agent:main:main ";
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "agent:main:shared", storePath: mainStore },
        { archivedAt: 10, sessionId: "destination-only", updatedAt: 10 },
      );
      const staleDestinationDatabase = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(mainStore, { agentId: "main", env }).path,
      });
      staleDestinationDatabase.db
        .prepare(
          "INSERT INTO board_tabs (session_key, tab_id, title, position, created_by, revision) VALUES ('agent:main:shared', 'destination-tab', 'Destination', 0, 'user', 2)",
        )
        .run();
      staleDestinationDatabase.db
        .prepare(
          "INSERT INTO board_widgets (session_key, name, tab_id, content_kind, html, sha256, view_generation, revision, size_w, size_h, position, created_by, created_at, updated_at) VALUES ('agent:main:shared', 'destination-widget', 'destination-tab', 'html', X'00', 'destination-sha', 'destination-view', 2, 1, 1, 0, 'user', 1, 25)",
        )
        .run();
      staleDestinationDatabase.db
        .prepare(
          "INSERT INTO session_suggestions (id, session_key, author_id, text, created_at, state) VALUES ('destination-suggestion', 'agent:main:shared', 'user-1', 'Keep me', 25, 'pending')",
        )
        .run();
      staleDestinationDatabase.db
        .prepare(
          "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES ('agent:main:shared', 'destination-member', 'owner-0', 10)",
        )
        .run();
      staleDestinationDatabase.db
        .prepare(
          "INSERT INTO heartbeat_outcomes (session_key, run_session_key, outcome, summary, occurred_at, updated_at) VALUES ('agent:main:shared', 'agent:main:shared', 'done', 'destination heartbeat', 25, 25)",
        )
        .run();
      staleDestinationDatabase.db
        .prepare(
          "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES ('destination-only', 0, ?, 10)",
        )
        .run(
          JSON.stringify({
            id: "destination-only-message",
            message: { content: "destination-only history", role: "user" },
            parentId: null,
            type: "message",
          }),
        );
      staleDestinationDatabase.db
        .prepare(
          "INSERT INTO session_windows (session_id, session_key, reason, session_scope, created_at, updated_at) VALUES ('winner', 'agent:main:shared', 'recovery', 'conversation', 10, 10)",
        )
        .run();
      staleDestinationDatabase.db
        .prepare(
          "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES ('winner', 0, ?, 10)",
        )
        .run(
          JSON.stringify({
            id: "stale-winner-message",
            message: { content: "stale destination history", role: "user" },
            parentId: null,
            type: "message",
          }),
        );
      staleDestinationDatabase.db
        .prepare(
          "INSERT INTO trajectory_runtime_events (session_id, seq, run_id, event_json, created_at) VALUES ('winner', 0, 'run-1', ?, 10)",
        )
        .run(JSON.stringify({ source: "destination" }));
      staleDestinationDatabase.db
        .prepare(
          "INSERT INTO trajectory_runtime_events (session_id, seq, run_id, event_json, created_at) VALUES ('winner', 2, 'run-1', ?, 11)",
        )
        .run(JSON.stringify({ source: "destination-later" }));
      staleDestinationDatabase.db
        .prepare(
          "INSERT INTO acp_parent_stream_events (session_id, run_id, seq, event_json, created_at) VALUES ('winner', 'run-1', 0, ?, 10)",
        )
        .run(JSON.stringify({ source: "destination" }));
      staleDestinationDatabase.db
        .prepare(
          "INSERT INTO acp_parent_stream_events (session_id, run_id, seq, event_json, created_at) VALUES ('winner', 'run-1', 2, ?, 11)",
        )
        .run(JSON.stringify({ source: "destination-later" }));
      staleDestinationDatabase.db
        .prepare(
          "INSERT INTO session_windows (session_id, session_key, reason, session_scope, created_at, updated_at) VALUES ('winner-previous', 'agent:main:shared', 'reset', 'conversation', 9, 9)",
        )
        .run();
      staleDestinationDatabase.db
        .prepare(
          "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES ('winner-previous', 0, ?, 9)",
        )
        .run(
          JSON.stringify({
            id: "stale-winner-previous-message",
            message: { content: "stale previous destination history", role: "user" },
            parentId: null,
            type: "message",
          }),
        );
      staleDestinationDatabase.db
        .prepare(
          "INSERT INTO trajectory_runtime_events (session_id, seq, run_id, event_json, created_at) VALUES ('winner-previous', 0, 'run-overlap', ?, 15), ('winner-previous', 2, 'run-overlap', ?, 15)",
        )
        .run(JSON.stringify({ source: "different" }), JSON.stringify({ source: "overlap" }));
      staleDestinationDatabase.db
        .prepare(
          "INSERT INTO acp_parent_stream_events (session_id, run_id, seq, event_json, created_at) VALUES ('winner-previous', 'run-overlap', 0, ?, 15), ('winner-previous', 'run-overlap', 2, ?, 15)",
        )
        .run(JSON.stringify({ source: "different" }), JSON.stringify({ source: "overlap" }));
      insertLegacySession({
        agentId: "ops",
        entry: {
          previousSessionId: "destination-only",
          sessionId: "winner",
          subject: "merged subject",
          updatedAt: 20,
        },
        env,
        eventText: "cross-store history",
        sessionKey: sourceAlias,
        storePath: opsStore,
      });
      const opsDatabase = openOpenClawAgentDatabase({
        agentId: "ops",
        env,
        path: resolveSqliteTargetFromSessionStorePath(opsStore, { agentId: "ops", env }).path,
      });
      opsDatabase.db
        .prepare(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES ('agent:main:shared', 'extra-alias', ?, 5)",
        )
        .run(JSON.stringify({ sessionId: "extra-alias", updatedAt: 5 }));
      opsDatabase.db
        .prepare(
          "INSERT INTO board_tabs (session_key, tab_id, title, position, created_by, revision) VALUES ('agent:main:shared', 'extra-tab', 'Extra', 1, 'agent', 1)",
        )
        .run();
      opsDatabase.db
        .prepare(
          "INSERT INTO session_suggestions (id, session_key, author_id, text, created_at, state) VALUES ('extra-suggestion', 'agent:main:shared', 'agent-1', 'Extra idea', 5, 'pending')",
        )
        .run();
      opsDatabase.db
        .prepare(
          "INSERT INTO session_windows (session_id, session_key, previous_session_id, reason, session_scope, created_at, updated_at) VALUES ('winner-previous', ?, NULL, 'reset', 'conversation', 15, 15)",
        )
        .run(sourceAlias);
      opsDatabase.db
        .prepare(
          "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES ('winner-previous', 0, ?, 15)",
        )
        .run(
          JSON.stringify({
            id: "winner-previous-message",
            message: { content: "previous generation history", role: "user" },
            parentId: null,
            type: "message",
          }),
        );
      for (const seq of [0, 1]) {
        opsDatabase.db
          .prepare(
            "INSERT INTO trajectory_runtime_events (session_id, seq, run_id, event_json, created_at) VALUES ('winner-previous', ?, 'run-overlap', ?, 15)",
          )
          .run(seq, JSON.stringify({ source: "overlap" }));
        opsDatabase.db
          .prepare(
            "INSERT INTO acp_parent_stream_events (session_id, run_id, seq, event_json, created_at) VALUES ('winner-previous', 'run-overlap', ?, ?, 15)",
          )
          .run(seq, JSON.stringify({ source: "overlap" }));
      }
      opsDatabase.db
        .prepare(
          "INSERT INTO trajectory_runtime_events (session_id, seq, run_id, event_json, created_at) VALUES ('winner', 0, 'run-1', ?, 20)",
        )
        .run(JSON.stringify({ source: "winner" }));
      opsDatabase.db
        .prepare(
          "INSERT INTO trajectory_runtime_events (session_id, seq, run_id, event_json, created_at) VALUES ('winner', 1, 'run-1', ?, 20)",
        )
        .run(JSON.stringify({ source: "winner" }));
      opsDatabase.db
        .prepare(
          "INSERT INTO acp_parent_stream_events (session_id, run_id, seq, event_json, created_at) VALUES ('winner', 'run-1', 0, ?, 20)",
        )
        .run(JSON.stringify({ source: "winner" }));
      opsDatabase.db
        .prepare(
          "INSERT INTO acp_parent_stream_events (session_id, run_id, seq, event_json, created_at) VALUES ('winner', 'run-1', 1, ?, 20)",
        )
        .run(JSON.stringify({ source: "winner" }));
      opsDatabase.db
        .prepare(
          "INSERT INTO board_tabs (session_key, tab_id, title, position, created_by, revision) VALUES (?, 'tab-1', 'Board', 0, 'user', 1)",
        )
        .run(sourceAlias);
      opsDatabase.db
        .prepare(
          "INSERT INTO board_widgets (session_key, name, tab_id, content_kind, html, sha256, view_generation, revision, size_w, size_h, position, created_by, created_at, updated_at) VALUES (?, 'widget-1', 'tab-1', 'html', X'00', 'sha', 'view-1', 1, 1, 1, 0, 'user', 1, 20)",
        )
        .run(sourceAlias);
      opsDatabase.db
        .prepare(
          "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES (?, 'member-1', 'owner-1', 20)",
        )
        .run(sourceAlias);
      opsDatabase.db
        .prepare(
          "INSERT INTO conversations (conversation_id, channel, account_id, kind, peer_id, delivery_target, metadata_json, created_at, updated_at) VALUES ('conversation-1', 'webchat', 'default', 'direct', 'peer', 'peer', '{}', 20, 20)",
        )
        .run();
      opsDatabase.db
        .prepare(
          "INSERT INTO session_conversations (session_id, conversation_id, role, first_seen_at, last_seen_at) VALUES ('winner', 'conversation-1', 'primary', 20, 20)",
        )
        .run();
      opsDatabase.db
        .prepare(
          "INSERT INTO conversation_deliveries (operation_id, operation_kind, conversation_id, source_session_key, message_hash, status, created_at, updated_at) VALUES ('operation-1', 'turn', 'conversation-1', ?, 'hash', 'sent', 20, 20)",
        )
        .run(sourceAlias);
      opsDatabase.db
        .prepare(
          "INSERT INTO conversations (conversation_id, channel, account_id, kind, peer_id, delivery_target, metadata_json, created_at, updated_at) VALUES ('conversation-2', 'webchat', 'default', 'direct', 'other-peer', 'other-peer', '{}', 20, 20)",
        )
        .run();
      opsDatabase.db
        .prepare(
          "INSERT INTO conversation_deliveries (operation_id, operation_kind, conversation_id, source_session_key, message_hash, status, created_at, updated_at) VALUES ('operation-2', 'turn', 'conversation-2', ?, 'other-hash', 'sent', 20, 20)",
        )
        .run(sourceAlias);
      opsDatabase.db
        .prepare(
          "INSERT INTO heartbeat_outcomes (session_key, run_session_key, outcome, summary, occurred_at, updated_at) VALUES (?, ?, 'done', 'complete', 20, 20)",
        )
        .run(sourceAlias, sourceAlias);
      opsDatabase.db.exec("PRAGMA foreign_keys = OFF;");
      opsDatabase.db.prepare("DELETE FROM session_windows WHERE session_id = 'winner'").run();
      opsDatabase.db.exec("PRAGMA foreign_keys = ON;");

      const report = await repairCanonicalSessionKeys({ apply: true, cfg, env });
      expect(report).toMatchObject({ foundGroups: 1, removedRows: 3, repairedGroups: 1 });
      expect(report.archivedTranscriptDirectories).toHaveLength(2);
      const repairedEntry = loadExactSessionEntryReadOnly({
        agentId: "main",
        env,
        sessionKey: "agent:main:shared",
        storePath: mainStore,
      })?.entry;
      expect(repairedEntry).toMatchObject({ sessionId: "winner", subject: "merged subject" });
      expect(repairedEntry?.archivedAt).toBeUndefined();
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "winner",
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "cross-store history" }),
        }),
      ]);
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "winner-previous",
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "previous generation history" }),
        }),
      ]);
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "destination-only",
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "destination-only history" }),
        }),
      ]);
      const mainDatabase = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(mainStore, { agentId: "main", env }).path,
      });
      expect(
        mainDatabase.db
          .prepare("SELECT session_key FROM session_windows ORDER BY session_id")
          .all(),
      ).toEqual([
        { session_key: "agent:main:shared" },
        { session_key: "agent:main:shared" },
        { session_key: "agent:main:shared" },
        { session_key: "agent:main:shared" },
      ]);
      expect(
        mainDatabase.db
          .prepare(
            "SELECT seq FROM trajectory_runtime_events WHERE session_id = 'winner-previous' AND event_json = ? ORDER BY seq",
          )
          .all(JSON.stringify({ source: "overlap" })),
      ).toEqual([{ seq: 0 }, { seq: 1 }]);
      expect(
        mainDatabase.db
          .prepare(
            "SELECT seq FROM acp_parent_stream_events WHERE session_id = 'winner-previous' AND event_json = ? ORDER BY seq",
          )
          .all(JSON.stringify({ source: "overlap" })),
      ).toEqual([{ seq: 0 }, { seq: 1 }]);
      expect(
        mainDatabase.db
          .prepare(
            "SELECT previous_session_id, updated_at FROM session_windows WHERE session_id = 'winner'",
          )
          .get(),
      ).toEqual({ previous_session_id: "destination-only", updated_at: 20 });
      expect(
        mainDatabase.db
          .prepare(
            "SELECT seq, event_json FROM trajectory_runtime_events WHERE session_id = 'winner' ORDER BY seq",
          )
          .all(),
      ).toEqual([
        { seq: 0, event_json: JSON.stringify({ source: "winner" }) },
        { seq: 1, event_json: JSON.stringify({ source: "winner" }) },
        { seq: 2, event_json: JSON.stringify({ source: "destination" }) },
        { seq: 3, event_json: JSON.stringify({ source: "destination-later" }) },
      ]);
      expect(
        mainDatabase.db
          .prepare(
            "SELECT seq, event_json FROM acp_parent_stream_events WHERE session_id = 'winner' AND run_id = 'run-1' ORDER BY seq",
          )
          .all(),
      ).toEqual([
        { seq: 0, event_json: JSON.stringify({ source: "winner" }) },
        { seq: 1, event_json: JSON.stringify({ source: "winner" }) },
        { seq: 2, event_json: JSON.stringify({ source: "destination" }) },
        { seq: 3, event_json: JSON.stringify({ source: "destination-later" }) },
      ]);
      expect(
        mainDatabase.db
          .prepare("SELECT display_name FROM session_nodes WHERE session_key = 'agent:main:shared'")
          .get(),
      ).toEqual({ display_name: "merged subject" });
      expect(mainDatabase.db.prepare("SELECT session_key FROM board_tabs").get()).toEqual({
        session_key: "agent:main:shared",
      });
      expect(
        mainDatabase.db.prepare("SELECT tab_id FROM board_tabs ORDER BY tab_id").all(),
      ).toEqual([{ tab_id: "destination-tab" }, { tab_id: "extra-tab" }, { tab_id: "tab-1" }]);
      expect(mainDatabase.db.prepare("SELECT name FROM board_widgets ORDER BY name").all()).toEqual(
        [{ name: "destination-widget" }, { name: "widget-1" }],
      );
      expect(
        mainDatabase.db.prepare("SELECT id FROM session_suggestions ORDER BY id").all(),
      ).toEqual([{ id: "destination-suggestion" }, { id: "extra-suggestion" }]);
      expect(mainDatabase.db.prepare("SELECT identity_id FROM session_members").all()).toEqual([
        { identity_id: "member-1" },
      ]);
      expect(
        mainDatabase.db
          .prepare(
            "SELECT conversation_id, source_session_key FROM conversation_deliveries WHERE operation_id = 'operation-1'",
          )
          .get(),
      ).toEqual({
        conversation_id: "conversation-1",
        source_session_key: "agent:main:shared",
      });
      expect(
        mainDatabase.db
          .prepare(
            "SELECT conversation_id, source_session_key FROM conversation_deliveries WHERE operation_id = 'operation-2'",
          )
          .get(),
      ).toEqual({
        conversation_id: "conversation-2",
        source_session_key: "agent:main:shared",
      });
      expect(
        mainDatabase.db
          .prepare("SELECT session_key, run_session_key FROM heartbeat_outcomes")
          .get(),
      ).toEqual({
        session_key: "agent:main:shared",
        run_session_key: "agent:main:shared",
      });
      expect(mainDatabase.db.prepare("SELECT summary FROM heartbeat_outcomes").get()).toEqual({
        summary: "destination heartbeat",
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "ops",
          env,
          sessionKey: sourceAlias,
          storePath: opsStore,
        }),
      ).toBeUndefined();
      const archiveContents = report.archivedTranscriptDirectories.flatMap((archiveDirectory) =>
        fs
          .readdirSync(archiveDirectory)
          .filter((name) => name.startsWith("winner"))
          .map((name) => readSessionArchiveContentSync(path.join(archiveDirectory, name))),
      );
      expect(archiveContents).toEqual(
        expect.arrayContaining([
          expect.stringContaining("cross-store history"),
          expect.stringContaining("stale destination history"),
          expect.stringContaining("stale previous destination history"),
        ]),
      );

      insertLegacySession({
        agentId: "ops",
        entry: { sessionId: "destination-only", updatedAt: 5 },
        env,
        eventText: "late stale history",
        sessionKey: "agent:main:main\t",
        storePath: opsStore,
      });
      opsDatabase.db
        .prepare(
          "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES ('agent:main:main' || char(9), 'stale-member', 'owner-2', 5)",
        )
        .run();
      opsDatabase.db
        .prepare(
          "INSERT INTO trajectory_runtime_events (session_id, seq, run_id, event_json, created_at) VALUES ('destination-only', 0, 'late-run', ?, 5)",
        )
        .run(JSON.stringify({ source: "late-stale" }));
      opsDatabase.db
        .prepare(
          "INSERT INTO acp_parent_stream_events (session_id, run_id, seq, event_json, created_at) VALUES ('destination-only', 'late-run', 0, ?, 5)",
        )
        .run(JSON.stringify({ source: "late-stale" }));
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 1,
        repairedGroups: 1,
      });
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "destination-only",
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "destination-only history" }),
        }),
      ]);
      expect(
        mainDatabase.db
          .prepare("SELECT identity_id FROM session_members ORDER BY identity_id")
          .all(),
      ).toEqual([{ identity_id: "member-1" }]);
      expect(
        mainDatabase.db
          .prepare(
            "SELECT event_json FROM trajectory_runtime_events WHERE session_id = 'destination-only'",
          )
          .get(),
      ).toEqual({ event_json: JSON.stringify({ source: "late-stale" }) });
      expect(
        mainDatabase.db
          .prepare(
            "SELECT event_json FROM acp_parent_stream_events WHERE session_id = 'destination-only'",
          )
          .get(),
      ).toEqual({ event_json: JSON.stringify({ source: "late-stale" }) });
    });
  });
});
