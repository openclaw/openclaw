import { afterEach, describe, expect, it, vi } from "vitest";
import {
  replaceSessionEntrySync,
  listCanonicalSessionRepairFacts,
  loadCanonicalSessionRepairEntries,
} from "../config/sessions/session-accessor.js";
import { readStoredCanonicalSessionMainKey } from "../config/sessions/session-canonical-key.js";
import { readSqliteDatabaseCleanClose } from "../infra/sqlite-database-admission.js";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
} from "../session-cards/progress-card-store.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { repairCanonicalSessionKeys } from "./doctor-session-canonical-keys.test-support.js";
import { createCanonicalRepairFixture } from "./doctor-session-repair-fixture.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
});

function withFixture(
  run: (fixture: ReturnType<typeof createCanonicalRepairFixture>) => Promise<void>,
  mainKey?: string,
  agentIds?: string[],
) {
  return withStateDirEnv("openclaw-doctor-canonical-", ({ stateDir }) =>
    run(createCanonicalRepairFixture(stateDir, mainKey, agentIds)),
  );
}

describe("doctor canonical session-key repair", () => {
  it("keeps an unchanged main-key contract read-only and persists a changed key", async () => {
    await withFixture(async ({ cfg, env, scope, database, expectRepair }) => {
      const { storePath } = scope();
      replaceSessionEntrySync(
        { agentId: "main", env, storePath, sessionKey: "agent:main:conversation" },
        { sessionId: "conversation", updatedAt: 1 },
      );
      const db = database();
      const options = { agentId: "main", env, path: db.path };
      closeOpenClawAgentDatabasesForTest();
      expect(readSqliteDatabaseCleanClose(options.path)).toBe(true);

      await expectRepair({ foundGroups: 0, repairedGroups: 0 });
      expect(readSqliteDatabaseCleanClose(options.path)).toBe(true);

      await repairCanonicalSessionKeys({
        apply: true,
        cfg: { ...cfg, session: { ...cfg.session, mainKey: "work" } },
        env,
      });
      expect(withOpenClawAgentDatabaseReadOnly(readStoredCanonicalSessionMainKey, options)).toEqual(
        { found: true, value: "work" },
      );
    });
  });

  it("restores a delivery-proven lowercased Matrix room alias", async () => {
    await withFixture(async ({ insert, load, transcript, expectRepair }) => {
      const canonicalKey = "agent:main:matrix:channel:!MixedCase:example.org";
      const legacyKey = canonicalKey.toLowerCase();
      insert(
        legacyKey,
        {
          chatType: "channel",
          delivery: normalizeSessionDeliveryState({
            context: { channel: "matrix", to: "!MixedCase:example.org" },
          }),
          sessionId: "matrix-legacy-session",
          updatedAt: 10,
        },
        "Matrix room history",
      );
      const childKey = "agent:main:matrix-child";
      insert(childKey, {
        parentSessionKey: legacyKey,
        sessionId: "matrix-child-session",
        updatedAt: 5,
      });

      await expectRepair({ foundGroups: 2, repairBatches: 1, removedRows: 1, repairedGroups: 2 });
      expect(load(canonicalKey)?.entry.sessionId).toBe("matrix-legacy-session");
      expect(load(legacyKey)).toBeUndefined();
      expect(load(childKey)?.entry.parentSessionKey).toBe(canonicalKey);
      await transcript(canonicalKey, "matrix-legacy-session", "Matrix room history");
      await expectRepair({ foundGroups: 0, repairedGroups: 0 });
    });
  });

  it("bounds same-database repair batches while collapsing whole-store projections", async () => {
    await withFixture(async ({ insert, expectRepair }) => {
      for (let index = 0; index < 65; index += 1) {
        const target = `!BatchRoom${index}:example.org`;
        const canonicalKey = `agent:main:matrix:channel:${target}`;
        insert(canonicalKey.toLowerCase(), {
          chatType: "channel",
          delivery: normalizeSessionDeliveryState({
            context: { channel: "matrix", to: target },
          }),
          sessionId: `batch-session-${index}`,
          updatedAt: index,
        });
      }

      await expectRepair({
        foundGroups: 65,
        repairBatches: 2,
        removedRows: 65,
        repairedGroups: 65,
      });
      await expectRepair({ foundGroups: 0, repairBatches: 0, repairedGroups: 0 });
    });
  });

  it("moves an empty stored key to the owning agent main key", async () => {
    await withFixture(async ({ database, insert, load, transcript, expectRepair }) => {
      insert("", { sessionId: "empty-key-session", updatedAt: 10 }, "empty key history");
      const db = database().db;
      db.prepare(
        "INSERT INTO conversations (conversation_id, channel, account_id, kind, peer_id, delivery_target, metadata_json, created_at, updated_at) VALUES ('empty-key-conversation', 'webchat', 'default', 'direct', 'empty', 'empty', '{}', 10, 10)",
      ).run();
      db.prepare(
        "INSERT INTO conversation_deliveries (operation_id, operation_kind, conversation_id, source_session_key, message_hash, status, created_at, updated_at) VALUES ('empty-key-operation', 'turn', 'empty-key-conversation', '', 'hash', 'sent', 10, 10)",
      ).run();

      await expectRepair({ foundGroups: 1, removedRows: 1, repairedGroups: 1 });
      expect(load("agent:main:main")?.entry.sessionId).toBe("empty-key-session");
      expect(load("")).toBeUndefined();
      await transcript("agent:main:main", "empty-key-session", "empty key history");
      expect(
        db
          .prepare(
            "SELECT source_session_key FROM conversation_deliveries WHERE operation_id = 'empty-key-operation'",
          )
          .get(),
      ).toEqual({ source_session_key: "agent:main:main" });
    });
  });

  it("keeps sentinel rows scoped to their owning agent stores", async () => {
    await withFixture(
      async ({ scope, insert, load, expectRepair }) => {
        const { env, storePath: mainStore } = scope();

        replaceSessionEntrySync(
          { agentId: "main", env, sessionKey: "global", storePath: mainStore },
          { sessionId: "main-global", updatedAt: 10 },
        );
        insert(
          "global",
          {
            parentSessionKey: "parent",
            sessionId: "ops-global",
            spawnedBy: "controller",
            updatedAt: 20,
          },
          undefined,
          "ops",
        );

        await expectRepair({ foundGroups: 1, repairedGroups: 1 });
        expect(load("global")?.entry.sessionId).toBe("main-global");
        const opsGlobal = load("global", "ops")?.entry;
        expect(opsGlobal).toMatchObject({
          parentSessionKey: "agent:ops:parent",
          sessionId: "ops-global",
          spawnedBy: "agent:ops:controller",
        });
      },
      undefined,
      ["main", "ops"],
    );
  });

  it("normalizes persisted lineage keys before runtime SQL filtering", async () => {
    await withFixture(async ({ database, insert, load, expectRepair }) => {
      insert("agent:main:child", {
        forkSource: {
          entryId: "fork-entry",
          sessionId: "fork-session",
          sessionKey: "Agent:Main:Fork ",
        },
        parentSessionKey: "Agent:Main:Parent ",
        sessionId: "child",
        spawnedBy: " ",
        updatedAt: 10,
      });

      await expectRepair({ foundGroups: 1, repairedGroups: 1 });
      expect(load("agent:main:child")?.entry).toMatchObject({
        forkSource: {
          entryId: "fork-entry",
          sessionId: "fork-session",
          sessionKey: "agent:main:fork",
        },
        parentSessionKey: "agent:main:parent",
      });
      expect(load("agent:main:child")?.entry.spawnedBy).toBeUndefined();
      await expectRepair({ foundGroups: 0, repairedGroups: 0 });
      const db = database().db;
      db.prepare("UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?").run(
        "Agent:Main:Parent ",
        "agent:main:child",
      );
      await expectRepair({ foundGroups: 1, repairedGroups: 1 });
      expect(
        db
          .prepare("SELECT parent_session_key FROM session_nodes WHERE session_key = ?")
          .get("agent:main:child"),
      ).toEqual({ parent_session_key: "agent:main:parent" });
      const canonicalJson = (
        db
          .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
          .get("agent:main:child") as { entry_json: string }
      ).entry_json;
      db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
        JSON.stringify({
          ...(JSON.parse(canonicalJson) as object),
          icon: "archive",
          spawnedBy: null,
        }),
        "agent:main:child",
      );
      await expectRepair({ foundGroups: 1, repairedGroups: 1 });
      expect(load("agent:main:child")?.entry).not.toHaveProperty("icon");
    });
  });

  it("moves a lone canonical row out of the wrong agent database", async () => {
    await withFixture(
      async ({ insert, load, transcript, database, expectRepair }) => {
        insert(
          "agent:main:misplaced",
          {
            parentSessionKey: "main",
            sessionId: "misplaced",
            spawnedBy: "controller",
            updatedAt: 10,
          },
          "misplaced history",
          "ops",
        );
        const sourceDatabase = database("ops");
        const destinationDatabase = database();
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

        await expectRepair({ foundGroups: 1, removedRows: 1, repairedGroups: 1 });
        expect(load("agent:main:misplaced")?.entry).toMatchObject({
          parentSessionKey: "agent:main:work",
          sessionId: "misplaced",
          spawnedBy: "agent:main:controller",
        });
        expect(
          readSessionProgressCard(destinationDatabase.db, "agent:main:misplaced"),
        ).toMatchObject({
          markdown: "Preserve this cross-store task",
          revision: 1,
          sessionKey: "agent:main:misplaced",
          steps: [{ step: "Finish the migration", status: "in_progress" }],
        });
        expect(load("agent:main:misplaced", "ops")).toBeUndefined();
        await transcript("agent:main:misplaced", "misplaced", "misplaced history");
      },
      "work",
      ["main", "ops"],
    );
  });

  it("keeps canonical destination history when cross-store timestamps tie", async () => {
    await withFixture(
      async ({ insert, load, transcript, database, expectRepair }) => {
        insert("agent:main:shared", { sessionId: "canonical", updatedAt: 10 }, "canonical history");
        insert(
          "agent:main:shared ",
          { sessionId: "wrong-store", updatedAt: 10 },
          "wrong-store history",
          "ops",
        );
        const destinationDatabase = database();
        const progressCardTable = () =>
          destinationDatabase.db
            .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_progress_cards'")
            .get();
        destinationDatabase.db.exec("DROP TABLE session_progress_cards");
        expect(progressCardTable()).toBeUndefined();

        await expectRepair({ foundGroups: 1, removedRows: 1, repairedGroups: 1 });
        expect(progressCardTable()).toBeUndefined();
        expect(load("agent:main:shared")?.entry).toMatchObject({
          sessionId: "canonical",
          updatedAt: 10,
        });
        await transcript("agent:main:shared", "canonical", "canonical history");
      },
      "shared",
      ["main", "ops"],
    );
  });
});

it.each([false, true])(
  "hydrates only selected repair rows, preserving raw guards for malformed=%s",
  async (malformed) => {
    await withFixture(async ({ scope, insert, database }) => {
      const sessionKey = "agent:main:selected";
      replaceSessionEntrySync(
        { ...scope(), sessionKey },
        {
          sessionId: "selected-session",
          updatedAt: 10,
          skillsSnapshot: { prompt: "selected cold payload", skills: [] },
        },
      );
      insert("agent:main:healthy", {
        sessionId: "healthy-session",
        updatedAt: 10,
        skillsSnapshot: { prompt: "unrelated cold payload", skills: [] },
      });
      if (malformed) {
        database()
          .db.prepare(
            "UPDATE session_nodes SET entry_json = ?, entry_valid = 0 WHERE session_key = ?",
          )
          .run("malformed legacy entry", sessionKey);
      }
      const facts = listCanonicalSessionRepairFacts(scope()).filter(
        (fact) => fact.sessionKey === sessionKey,
      );
      expect(facts).toHaveLength(1);
      const parse = JSON.parse;
      let unrelatedPayloadReads = 0;
      vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        if (text.includes("unrelated cold payload")) {
          unrelatedPayloadReads++;
        }
        return parse(text, reviver);
      });
      const [loaded] = loadCanonicalSessionRepairEntries(scope(), facts);
      expect(loaded).toMatchObject({
        sessionKey,
        entry: {
          sessionId: "selected-session",
          skillsSnapshot: { prompt: "selected cold payload", skills: [] },
        },
      });
      expect(unrelatedPayloadReads).toBe(0);
      if (malformed) {
        expect(loaded).toMatchObject({
          rawEntryJson: "malformed legacy entry",
          rawSnapshotRevision: expect.any(Number),
        });
      } else {
        expect(loaded).not.toHaveProperty("rawEntryJson");
      }
    });
  },
);
