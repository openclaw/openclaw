import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadTranscriptEvents,
  loadExactSessionEntryReadOnly,
  replaceSessionEntrySync,
  listCanonicalSessionRepairFacts,
  loadCanonicalSessionRepairEntries,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
} from "../session-cards/progress-card-store.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import {
  insertLegacySession,
  repairCanonicalSessionKeys,
} from "./doctor-session-canonical-keys.test-support.js";

function openSessionDatabase(agentId: string, env: NodeJS.ProcessEnv, storePath: string) {
  return openOpenClawAgentDatabase({
    agentId,
    env,
    path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId, env }).path,
  });
}

function createMainStoreFixture(stateDir: string, mainKey?: string) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
  const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {} } },
    session: { ...(mainKey ? { mainKey } : {}), store: storeTemplate },
  };
  return {
    cfg,
    env,
    storePath,
    loadEntry: (sessionKey: string) =>
      loadExactSessionEntryReadOnly({ agentId: "main", env, sessionKey, storePath }),
  };
}

afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("doctor canonical session-key repair", () => {
  it("restores a delivery-proven lowercased Matrix room alias", async () => {
    const fixture = {
      canonicalKey: "agent:main:matrix:channel:!MixedCase:example.org",
      channel: "matrix",
      chatType: "channel" as const,
      label: "Matrix room",
      to: "!MixedCase:example.org",
    };

    await withStateDirEnv("openclaw-doctor-canonical-delivery-alias-", async ({ stateDir }) => {
      const { cfg, env, storePath, loadEntry } = createMainStoreFixture(stateDir);
      const legacyKey = fixture.canonicalKey.toLowerCase();
      insertLegacySession({
        agentId: "main",
        entry: {
          chatType: fixture.chatType,
          delivery: normalizeSessionDeliveryState({
            context: { channel: fixture.channel, to: fixture.to },
          }),
          sessionId: `${fixture.channel}-legacy-session`,
          updatedAt: 10,
        },
        env,
        eventText: `${fixture.label} history`,
        sessionKey: legacyKey,
        storePath,
      });
      const childKey = `agent:main:${fixture.channel}-child`;
      insertLegacySession({
        agentId: "main",
        entry: {
          parentSessionKey: legacyKey,
          sessionId: `${fixture.channel}-child-session`,
          updatedAt: 5,
        },
        env,
        sessionKey: childKey,
        storePath,
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 2,
        repairBatches: 1,
        removedRows: 1,
        repairedGroups: 2,
      });
      expect(loadEntry(fixture.canonicalKey)?.entry.sessionId).toBe(
        `${fixture.channel}-legacy-session`,
      );
      expect(loadEntry(legacyKey)).toBeUndefined();
      expect(loadEntry(childKey)?.entry.parentSessionKey).toBe(fixture.canonicalKey);
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: `${fixture.channel}-legacy-session`,
          sessionKey: fixture.canonicalKey,
          storePath,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: `${fixture.label} history` }),
        }),
      ]);
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
    });
  });

  it("bounds same-database repair batches while collapsing whole-store projections", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-batches-", async ({ stateDir }) => {
      const { cfg, env, storePath } = createMainStoreFixture(stateDir);
      for (let index = 0; index < 65; index += 1) {
        const target = `!BatchRoom${index}:example.org`;
        const canonicalKey = `agent:main:matrix:channel:${target}`;
        insertLegacySession({
          agentId: "main",
          entry: {
            chatType: "channel",
            delivery: normalizeSessionDeliveryState({
              context: { channel: "matrix", to: target },
            }),
            sessionId: `batch-session-${index}`,
            updatedAt: index,
          },
          env,
          sessionKey: canonicalKey.toLowerCase(),
          storePath,
        });
      }

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 65,
        repairBatches: 2,
        removedRows: 65,
        repairedGroups: 65,
      });
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairBatches: 0,
        repairedGroups: 0,
      });
    });
  });

  it("moves an empty stored key to the owning agent main key", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-empty-key-", async ({ stateDir }) => {
      const { cfg, env, storePath, loadEntry } = createMainStoreFixture(stateDir);
      insertLegacySession({
        agentId: "main",
        entry: { sessionId: "empty-key-session", updatedAt: 10 },
        env,
        eventText: "empty key history",
        sessionKey: "",
        storePath,
      });
      const database = openSessionDatabase("main", env, storePath);
      database.db
        .prepare(
          "INSERT INTO conversations (conversation_id, channel, account_id, kind, peer_id, delivery_target, metadata_json, created_at, updated_at) VALUES ('empty-key-conversation', 'webchat', 'default', 'direct', 'empty', 'empty', '{}', 10, 10)",
        )
        .run();
      database.db
        .prepare(
          "INSERT INTO conversation_deliveries (operation_id, operation_kind, conversation_id, source_session_key, message_hash, status, created_at, updated_at) VALUES ('empty-key-operation', 'turn', 'empty-key-conversation', '', 'hash', 'sent', 10, 10)",
        )
        .run();

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 1,
        repairedGroups: 1,
      });
      expect(loadEntry("agent:main:main")?.entry.sessionId).toBe("empty-key-session");
      expect(loadEntry("")).toBeUndefined();
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "empty-key-session",
          sessionKey: "agent:main:main",
          storePath,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "empty key history" }),
        }),
      ]);
      expect(
        database.db
          .prepare(
            "SELECT source_session_key FROM conversation_deliveries WHERE operation_id = 'empty-key-operation'",
          )
          .get(),
      ).toEqual({ source_session_key: "agent:main:main" });
    });
  });

  it("keeps sentinel rows scoped to their owning agent stores", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-sentinels-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const mainStore = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const opsStore = resolveSessionStorePathCore(storeTemplate, { agentId: "ops", env });
      const cfg = {
        agents: { entries: { main: {}, ops: {} } },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: "global", storePath: mainStore },
        { sessionId: "main-global", updatedAt: 10 },
      );
      insertLegacySession({
        agentId: "ops",
        env,
        sessionKey: "global",
        storePath: opsStore,
        entry: {
          parentSessionKey: "parent",
          sessionId: "ops-global",
          spawnedBy: "controller",
          updatedAt: 20,
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
          sessionKey: "global",
          storePath: mainStore,
        })?.entry.sessionId,
      ).toBe("main-global");
      const opsGlobal = loadExactSessionEntryReadOnly({
        agentId: "ops",
        env,
        sessionKey: "global",
        storePath: opsStore,
      })?.entry;
      expect(opsGlobal).toMatchObject({
        parentSessionKey: "agent:ops:parent",
        sessionId: "ops-global",
        spawnedBy: "agent:ops:controller",
      });
    });
  });

  it("normalizes persisted lineage keys before runtime SQL filtering", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-lineage-", async ({ stateDir }) => {
      const { cfg, env, storePath, loadEntry } = createMainStoreFixture(stateDir);
      insertLegacySession({
        agentId: "main",
        env,
        sessionKey: "agent:main:child",
        storePath,
        entry: {
          forkSource: {
            entryId: "fork-entry",
            sessionId: "fork-session",
            sessionKey: "Agent:Main:Fork ",
          },
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
      expect(loadEntry("agent:main:child")?.entry).toMatchObject({
        forkSource: {
          entryId: "fork-entry",
          sessionId: "fork-session",
          sessionKey: "agent:main:fork",
        },
        parentSessionKey: "agent:main:parent",
      });
      expect(loadEntry("agent:main:child")?.entry.spawnedBy).toBeUndefined();
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
      const database = openSessionDatabase("main", env, storePath);
      database.db
        .prepare("UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?")
        .run("Agent:Main:Parent ", "agent:main:child");
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      expect(
        database.db
          .prepare("SELECT parent_session_key FROM session_nodes WHERE session_key = ?")
          .get("agent:main:child"),
      ).toEqual({ parent_session_key: "agent:main:parent" });
      const canonicalJson = (
        database.db
          .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
          .get("agent:main:child") as { entry_json: string }
      ).entry_json;
      database.db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
        JSON.stringify({
          ...(JSON.parse(canonicalJson) as object),
          icon: "archive",
          spawnedBy: null,
        }),
        "agent:main:child",
      );
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      expect(loadEntry("agent:main:child")?.entry).not.toHaveProperty("icon");
    });
  });

  it("moves a lone canonical row out of the wrong agent database", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-wrong-store-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const mainStore = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const opsStore = resolveSessionStorePathCore(storeTemplate, { agentId: "ops", env });
      const cfg = {
        agents: { entries: { main: {}, ops: {} } },
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
      const sourceDatabase = openSessionDatabase("ops", env, opsStore);
      const destinationDatabase = openSessionDatabase("main", env, mainStore);
      writeSessionProgressCard(sourceDatabase.db, "agent:main:misplaced", {
        markdown: "Preserve this cross-store task",
        steps: [{ step: "Finish the migration", status: "in_progress" }],
      });
      destinationDatabase.db.exec("DROP TABLE session_progress_cards");
      expect(
        destinationDatabase.db
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_progress_cards'")
          .get(),
      ).toBeUndefined();

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
      expect(readSessionProgressCard(destinationDatabase.db, "agent:main:misplaced")).toMatchObject(
        {
          markdown: "Preserve this cross-store task",
          revision: 1,
          sessionKey: "agent:main:misplaced",
          steps: [{ step: "Finish the migration", status: "in_progress" }],
        },
      );
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "ops",
          env,
          sessionKey: "agent:main:misplaced",
          storePath: opsStore,
        }),
      ).toBeUndefined();
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

  it("keeps canonical destination history when cross-store timestamps tie", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-tied-stores-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const mainStore = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const opsStore = resolveSessionStorePathCore(storeTemplate, { agentId: "ops", env });
      const cfg = {
        agents: { entries: { main: {}, ops: {} } },
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
        sessionKey: "agent:main:shared ",
        storePath: opsStore,
      });
      const destinationDatabase = openSessionDatabase("main", env, mainStore);
      const progressCardTable = () =>
        destinationDatabase.db
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_progress_cards'")
          .get();
      destinationDatabase.db.exec("DROP TABLE session_progress_cards");
      expect(progressCardTable()).toBeUndefined();

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 1,
        repairedGroups: 1,
      });
      expect(progressCardTable()).toBeUndefined();
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

describe("doctor canonical session decision races", () => {
  it("rejects stale canonical facts after delivery evidence changes", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-stale-fact-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const sessionKey = "agent:main:matrix:channel:!mixedcase:example.org";
      insertLegacySession({
        agentId: "main",
        entry: {
          delivery: normalizeSessionDeliveryState({
            context: { channel: "matrix", to: "!MixedCase:example.org" },
          }),
          sessionId: "stale-delivery-session",
          updatedAt: 10,
        },
        env,
        sessionKey,
        storePath,
      });
      const facts = listCanonicalSessionRepairFacts({ agentId: "main", env, storePath });
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main", env }).path,
      });
      const changedEntry = {
        delivery: normalizeSessionDeliveryState({
          context: { channel: "matrix", to: "!MIXEDCASE:example.org" },
        }),
        label: "concurrent unrelated metadata",
        sessionId: "stale-delivery-session",
        updatedAt: 10,
      };
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(JSON.stringify(changedEntry), sessionKey);
      database.db
        .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
        .run(sessionKey);

      expect(
        listCanonicalSessionRepairFacts({ agentId: "main", env, storePath })[0]?.decisionToken,
      ).not.toBe(facts[0]?.decisionToken);
      expect(() =>
        loadCanonicalSessionRepairEntries({ agentId: "main", env, storePath }, facts),
      ).toThrow("Canonical session repair inputs changed during scan");
      expect(
        database.db
          .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
          .get(sessionKey),
      ).toEqual({ entry_json: JSON.stringify(changedEntry) });

      const cfg = {
        agents: { entries: { main: {} } },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:matrix:channel:!MIXEDCASE:example.org",
          storePath,
        })?.entry,
      ).toMatchObject({ label: "concurrent unrelated metadata" });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:matrix:channel:!MixedCase:example.org",
          storePath,
        }),
      ).toBeUndefined();
    });
  });
});
