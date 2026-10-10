import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  assignSessionOwner,
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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

afterEach(() => closeOpenClawAgentDatabasesForTest());

function insertEmptyAlias(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  updatedAt: number;
}) {
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
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, '{}', ?)",
    )
    .run(params.sessionKey, params.sessionId, params.updatedAt);
  return database;
}

describe("doctor transcript owner repair", () => {
  it.each([
    { sourceAgentId: "main", requiredAlias: true, requiredCanonical: false },
    { sourceAgentId: "main", requiredAlias: true, requiredCanonical: true },
  ])("preserves required creation provenance during canonical repair: %o", async (fixture) => {
    await withStateDirEnv("openclaw-doctor-canonical-creation-stamp-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const destinationStore = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const sourceStore = resolveSessionStorePathCore(storeTemplate, {
        agentId: fixture.sourceAgentId,
        env,
      });
      const canonicalKey = "agent:main:matrix:channel:!Creation:example.org";
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {}, ops: {} } },
        session: { mainKey: "work", store: storeTemplate },
      };
      const canonicalStamp = {
        createdVia: "operator" as const,
        createdActor: {
          type: "human" as const,
          source: "profile" as const,
          id: "profile-canonical",
        },
        createdAt: 10,
        ...(fixture.requiredCanonical ? { sandbox: "required" as const } : {}),
      };
      const aliasStamp = {
        createdVia: "channel" as const,
        createdActor: { type: "human" as const, source: "channel" as const, id: "profile-alias" },
        createdAt: 20,
        ...(fixture.requiredAlias ? { sandbox: "required" as const } : {}),
      };
      insertLegacySession({
        agentId: "main",
        entry: {
          ...canonicalStamp,
          sessionId: "canonical-session",
          updatedAt: fixture.requiredCanonical ? 10 : 30,
        },
        env,
        sessionKey: canonicalKey,
        storePath: destinationStore,
      });
      insertLegacySession({
        agentId: fixture.sourceAgentId,
        entry: {
          ...aliasStamp,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "matrix", to: "!Creation:example.org" },
          }),
          sessionId: "alias-session",
          updatedAt: 20,
        },
        env,
        sessionKey: canonicalKey.toLowerCase(),
        storePath: sourceStore,
      });

      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      const repaired = loadExactSessionEntryReadOnly({
        agentId: "main",
        env,
        sessionKey: canonicalKey,
        storePath: destinationStore,
      })?.entry;
      const expectedStamp =
        fixture.requiredAlias && !fixture.requiredCanonical ? aliasStamp : canonicalStamp;
      expect(repaired).toMatchObject({
        ...expectedStamp,
        sessionId: fixture.requiredCanonical ? "alias-session" : "canonical-session",
        updatedAt: fixture.requiredCanonical ? 20 : 30,
      });
      if (!fixture.requiredAlias && !fixture.requiredCanonical) {
        expect(repaired).not.toHaveProperty("sandbox");
      }
    });
  });

  it("replaces a stale same-store owner from the selected canonical-repair winner", async () => {
    await withStateDirEnv("openclaw-doctor-assigned-owner-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const canonicalKey = "agent:main:matrix:channel:!Owner:example.org";
      const winnerKey = canonicalKey.toLowerCase();
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} } },
        session: { mainKey: "work", store: storeTemplate },
      };
      const scope = { agentId: "main", env, storePath };
      insertLegacySession({
        ...scope,
        entry: { sessionId: "stale-destination", updatedAt: 10 },
        sessionKey: canonicalKey,
      });
      assignSessionOwner(
        { ...scope, sessionKey: canonicalKey },
        {
          owner: { type: "human", id: "profile-stale" },
          assignedBy: { type: "human", id: "profile-stale-assigner" },
          assignedAt: 10,
        },
      );
      insertLegacySession({
        ...scope,
        entry: { sessionId: "selected-winner", updatedAt: 20 },
        sessionKey: winnerKey,
      });
      const owner = assignSessionOwner(
        { ...scope, sessionKey: winnerKey },
        {
          owner: { type: "human", id: "profile-winner" },
          assignedBy: { type: "agent", id: "research" },
          assignedAt: 1234,
        },
      );
      openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(storePath, scope).path,
      })
        .db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(
          JSON.stringify({
            sessionId: "selected-winner",
            updatedAt: 20,
            delivery: normalizeSessionDeliveryState({
              context: { channel: "matrix", to: "!Owner:example.org" },
            }),
          }),
          winnerKey,
        );
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({ ...scope, sessionKey: canonicalKey })?.entry.owner,
      ).toEqual(owner);
    });
  });

  it("restores a valid node after an empty alias steals its transcript window", async () => {
    await withStateDirEnv("openclaw-doctor-transcript-owner-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const cfg = {
        agents: { entries: { main: {} } },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      const canonicalKey = "agent:main:main";
      const staleKey = "agent:main:telegram:default:direct:fixture-peer";
      const sessionId = "stolen-owner-session";
      insertLegacySession({
        agentId: "main",
        entry: { label: "canonical metadata", sessionId, updatedAt: 20 },
        env,
        eventText: "preserved history",
        sessionKey: canonicalKey,
        storePath,
      });
      const database = insertEmptyAlias({
        agentId: "main",
        env,
        sessionId,
        sessionKey: staleKey,
        storePath,
        updatedAt: 30,
      });
      database.db
        .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
        .run(canonicalKey);
      database.db
        .prepare("UPDATE session_windows SET session_key = ? WHERE session_id = ?")
        .run(staleKey, sessionId);

      expect(await repairCanonicalSessionKeys({ apply: false, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 0,
      });
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        removedRows: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({ agentId: "main", env, sessionKey: staleKey, storePath }),
      ).toBeUndefined();
      expect(
        loadExactSessionEntryReadOnly({ agentId: "main", env, sessionKey: canonicalKey, storePath })
          ?.entry,
      ).toMatchObject({ label: "canonical metadata", sessionId });
      expect(
        database.db
          .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
          .get(sessionId),
      ).toEqual({ session_key: canonicalKey });
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId,
          sessionKey: canonicalKey,
          storePath,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "preserved history" }),
        }),
      ]);
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 0,
        repairedGroups: 0,
      });
    });
  });
});
