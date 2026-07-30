import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  loadTranscriptEvents,
  loadExactSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { mergeCanonicalSessionEntryCandidates } from "../config/sessions/session-canonical-key.js";
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

describe("doctor canonical session-key repair", () => {
  it("selects a finite updatedAt over a legacy missing timestamp", () => {
    expect(
      mergeCanonicalSessionEntryCandidates([
        { entry: { sessionId: "legacy" } as SessionEntry, value: "legacy" },
        { entry: { sessionId: "newer", updatedAt: 10 }, value: "newer" },
      ])?.winner,
    ).toBe("newer");
  });

  it("prefers the canonical destination when repair timestamps tie", () => {
    expect(
      mergeCanonicalSessionEntryCandidates([
        { entry: { sessionId: "wrong-store", updatedAt: 10 }, value: "wrong-store" },
        {
          entry: { sessionId: "canonical", updatedAt: 10 },
          preferred: true,
          value: "canonical",
        },
      ])?.winner,
    ).toBe("canonical");
  });

  it("is a no-op for fresh stores and remains idempotent after repair", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-fresh-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveStorePath(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "agent:main:main", storePath },
        { sessionId: "fresh", updatedAt: 10 },
      );

      expect(await repairCanonicalSessionKeys({ apply: false, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main", env }).path,
      });
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(
          JSON.stringify({ sessionId: "\0invalid", subject: "legacy", updatedAt: 10 }),
          "agent:main:main",
        );
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 0,
        repairedGroups: 1,
      });
      expect(
        JSON.parse(
          (
            database.db
              .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
              .get("agent:main:main") as { entry_json: string }
          ).entry_json,
        ),
      ).toMatchObject({ sessionId: "fresh", subject: "legacy", updatedAt: 10 });
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
    });
  });

  it("rehomes matching in-store transcript generations under the canonical key", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-rehome-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveStorePath(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { mainKey: "work", store: storeTemplate },
      } as OpenClawConfig;
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "agent:main:work", storePath },
        { previousSessionId: "older", sessionId: "newer", updatedAt: 20 },
      );
      insertLegacySession({
        agentId: "main",
        entry: { sessionId: "older", subject: "preserved", updatedAt: 10 },
        env,
        eventText: "older history",
        sessionKey: "agent:main:main",
        storePath,
      });
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main", env }).path,
      });
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(JSON.stringify({ sessionId: "older", subject: "preserved" }), "agent:main:main");

      const first = await repairCanonicalSessionKeys({ apply: true, cfg, env });
      expect(first).toMatchObject({ foundGroups: 1, removedRows: 1, repairedGroups: 1 });
      expect(first.archivedTranscriptDirectories).toEqual([]);
      expect(
        database.db
          .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
          .get("older"),
      ).toEqual({ session_key: "agent:main:work" });
      expect(
        database.db
          .prepare("SELECT count(*) AS count FROM transcript_events WHERE session_id = ?")
          .get("older"),
      ).toEqual({ count: 1 });
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
    });
  });

  it("replaces same-store membership from the selected alias winner", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-members-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveStorePath(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { mainKey: "work", store: storeTemplate },
      } as OpenClawConfig;
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "agent:main:work", storePath },
        { sessionId: "shared-session", updatedAt: 10 },
      );
      insertLegacySession({
        agentId: "main",
        entry: { sessionId: "alias-winner-session", updatedAt: 20 },
        env,
        sessionKey: "agent:main:main",
        storePath,
      });
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main", env }).path,
      });
      const insertMember = database.db.prepare(
        "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES (?, ?, 'owner', 10)",
      );
      insertMember.run("agent:main:work", "canonical-member");
      insertMember.run("agent:main:main", "winner-member");

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      expect(database.db.prepare("SELECT identity_id FROM session_members").all()).toEqual([
        { identity_id: "winner-member" },
      ]);
    });
  });

  it("keeps sentinel rows scoped to their owning agent stores", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-sentinels-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const mainStore = resolveStorePath(storeTemplate, { agentId: "main", env });
      const opsStore = resolveStorePath(storeTemplate, { agentId: "ops", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "global", storePath: mainStore },
        { sessionId: "main-global", updatedAt: 10 },
      );
      replaceSessionEntrySync(
        { agentId: "ops", env, sessionKey: "global", storePath: opsStore },
        { sessionId: "ops-global", updatedAt: 20 },
      );

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "global",
          storePath: mainStore,
        })?.entry.sessionId,
      ).toBe("main-global");
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "ops",
          env,
          sessionKey: "global",
          storePath: opsStore,
        })?.entry.sessionId,
      ).toBe("ops-global");
    });
  });

  it("normalizes persisted lineage keys before runtime SQL filtering", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-lineage-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveStorePath(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      insertLegacySession({
        agentId: "main",
        env,
        sessionKey: "agent:main:child",
        storePath,
        entry: {
          parentSessionKey: "Agent:Main:Parent ",
          sessionId: "child",
          spawnedBy: " ",
          updatedAt: 10,
        },
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:child",
          storePath,
        })?.entry,
      ).toMatchObject({
        parentSessionKey: "agent:main:parent",
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:child",
          storePath,
        })?.entry.spawnedBy,
      ).toBeUndefined();
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
    });
  });

  it("moves a lone alias row to its canonical key", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-single-alias-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveStorePath(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { mainKey: "work", store: storeTemplate },
      } as OpenClawConfig;
      insertLegacySession({
        agentId: "main",
        entry: { sessionId: "legacy", updatedAt: 10 },
        env,
        sessionKey: "agent:main:main",
        storePath,
      });
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main", env }).path,
      });
      database.db
        .prepare("UPDATE session_nodes SET entry_json = 'not-json' WHERE session_key = ?")
        .run("agent:main:main");

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:main",
          storePath,
        }),
      ).toBeUndefined();
      expect(
        database.db
          .prepare("SELECT count(*) AS count FROM session_nodes WHERE session_key = ?")
          .get("agent:main:main"),
      ).toEqual({ count: 0 });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:work",
          storePath,
        })?.entry.sessionId,
      ).toBe("legacy");
      expect(() =>
        replaceSessionEntrySync(
          { agentId: "main", env, sessionKey: "agent:main:main", storePath },
          { sessionId: "recreated-alias", updatedAt: 20 },
        ),
      ).toThrow("openclaw doctor --fix");
    });
  });

  it("moves a lone canonical row out of the wrong agent database", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-wrong-store-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const mainStore = resolveStorePath(storeTemplate, { agentId: "main", env });
      const opsStore = resolveStorePath(storeTemplate, { agentId: "ops", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
        session: { mainKey: "work", store: storeTemplate },
      } as OpenClawConfig;
      insertLegacySession({
        agentId: "ops",
        entry: {
          parentSessionKey: "main",
          sessionId: "misplaced",
          spawnedBy: "controller",
          updatedAt: 10,
        },
        env,
        eventText: "misplaced history",
        sessionKey: "agent:main:misplaced",
        storePath: opsStore,
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:misplaced",
          storePath: mainStore,
        })?.entry,
      ).toMatchObject({
        parentSessionKey: "agent:main:work",
        sessionId: "misplaced",
        spawnedBy: "agent:main:controller",
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "ops",
          env,
          sessionKey: "agent:main:misplaced",
          storePath: opsStore,
        }),
      ).toBeUndefined();
      expect(() =>
        replaceSessionEntrySync(
          { agentId: "main", env, sessionKey: "agent:main:main", storePath: mainStore },
          { sessionId: "new-destination-alias", updatedAt: 20 },
        ),
      ).toThrow("openclaw doctor --fix");
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "misplaced",
          sessionKey: "agent:main:misplaced",
          storePath: mainStore,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "misplaced history" }),
        }),
      ]);
    });
  });

  it("refreshes the title when a loser transcript fills an empty winner generation", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-title-refresh-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const mainStore = resolveStorePath(storeTemplate, { agentId: "main", env });
      const opsStore = resolveStorePath(storeTemplate, { agentId: "ops", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
        session: { mainKey: "shared", store: storeTemplate },
      } as OpenClawConfig;
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "agent:main:shared", storePath: mainStore },
        { sessionId: "shared-session", updatedAt: 20 },
      );
      const mainDatabase = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(mainStore, { agentId: "main", env }).path,
      });
      mainDatabase.db
        .prepare(
          "INSERT INTO trajectory_runtime_events (session_id, seq, run_id, event_json, created_at) VALUES ('shared-session', 0, 'run-1', '{}', 20)",
        )
        .run();
      insertLegacySession({
        agentId: "ops",
        entry: { sessionId: "shared-session", updatedAt: 10 },
        env,
        eventText: "loser transcript title",
        sessionKey: "agent:main:main ",
        storePath: opsStore,
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(mainStore, { agentId: "main", env }).path,
      });
      expect(
        database.db
          .prepare("SELECT display_name FROM session_nodes WHERE session_key = ?")
          .get("agent:main:shared"),
      ).toEqual({ display_name: "loser transcript title" });
    });
  });

  it("keeps canonical destination history when cross-store timestamps tie", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-tied-stores-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const mainStore = resolveStorePath(storeTemplate, { agentId: "main", env });
      const opsStore = resolveStorePath(storeTemplate, { agentId: "ops", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
        session: { mainKey: "shared", store: storeTemplate },
      } as OpenClawConfig;
      insertLegacySession({
        agentId: "main",
        entry: { sessionId: "canonical", updatedAt: 10 },
        env,
        eventText: "canonical history",
        sessionKey: "agent:main:shared",
        storePath: mainStore,
      });
      insertLegacySession({
        agentId: "ops",
        entry: { sessionId: "wrong-store", updatedAt: 10 },
        env,
        eventText: "wrong-store history",
        sessionKey: "agent:main:main ",
        storePath: opsStore,
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        })?.entry,
      ).toMatchObject({ sessionId: "canonical", updatedAt: 10 });
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "canonical",
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "canonical history" }),
        }),
      ]);
    });
  });
});
