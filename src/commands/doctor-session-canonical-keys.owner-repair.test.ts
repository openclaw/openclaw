import { afterEach, describe, expect, it } from "vitest";
import { assignSessionOwner } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { createCanonicalRepairFixture } from "./doctor-session-repair-fixture.test-support.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("doctor transcript owner repair", () => {
  it.each([false, true])(
    "preserves required creation provenance during canonical repair: %o",
    async (requiredCanonical) => {
      await withStateDirEnv("openclaw-doctor-canonical-creation-stamp-", async ({ stateDir }) => {
        const { insert, load, expectRepair } = createCanonicalRepairFixture(stateDir, "work", [
          "main",
          "ops",
        ]);
        const canonicalKey = "agent:main:matrix:channel:!Creation:example.org";
        const canonicalStamp = {
          createdVia: "operator" as const,
          createdActor: {
            type: "human" as const,
            source: "profile" as const,
            id: "profile-canonical",
          },
          createdAt: 10,
          ...(requiredCanonical ? { sandbox: "required" as const } : {}),
        };
        const aliasStamp = {
          createdVia: "channel" as const,
          createdActor: { type: "human" as const, source: "channel" as const, id: "profile-alias" },
          createdAt: 20,
          sandbox: "required" as const,
        };
        insert(canonicalKey, {
          ...canonicalStamp,
          sessionId: "canonical-session",
          updatedAt: requiredCanonical ? 10 : 30,
        });
        insert(canonicalKey.toLowerCase(), {
          ...aliasStamp,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "matrix", to: "!Creation:example.org" },
          }),
          sessionId: "alias-session",
          updatedAt: 20,
        });

        await expectRepair({ foundGroups: 1, repairedGroups: 1 });
        const repaired = load(canonicalKey)?.entry;
        const expectedStamp = !requiredCanonical ? aliasStamp : canonicalStamp;
        expect(repaired).toMatchObject({
          ...expectedStamp,
          sessionId: requiredCanonical ? "alias-session" : "canonical-session",
          updatedAt: requiredCanonical ? 20 : 30,
        });
      });
    },
  );

  it("replaces a stale same-store owner from the selected canonical-repair winner", async () => {
    await withStateDirEnv("openclaw-doctor-assigned-owner-", async ({ stateDir }) => {
      const { insert, load, database, scope, expectRepair } = createCanonicalRepairFixture(
        stateDir,
        "work",
      );
      const canonicalKey = "agent:main:matrix:channel:!Owner:example.org";
      const winnerKey = canonicalKey.toLowerCase();
      insert(canonicalKey, { sessionId: "stale-destination", updatedAt: 10 });
      assignSessionOwner(
        { ...scope(), sessionKey: canonicalKey },
        {
          owner: { type: "human", id: "profile-stale" },
          assignedBy: { type: "human", id: "profile-stale-assigner" },
          assignedAt: 10,
        },
      );
      insert(winnerKey, { sessionId: "selected-winner", updatedAt: 20 });
      const owner = assignSessionOwner(
        { ...scope(), sessionKey: winnerKey },
        {
          owner: { type: "human", id: "profile-winner" },
          assignedBy: { type: "agent", id: "research" },
          assignedAt: 1234,
        },
      );
      database()
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
      await expectRepair({ foundGroups: 1, repairedGroups: 1 });
      expect(load(canonicalKey)?.entry.owner).toEqual(owner);
    });
  });

  it("restores a valid node after an empty alias steals its transcript window", async () => {
    await withStateDirEnv("openclaw-doctor-transcript-owner-", async ({ stateDir }) => {
      const { insert, load, database, transcript, expectRepair } =
        createCanonicalRepairFixture(stateDir);
      const canonicalKey = "agent:main:main";
      const staleKey = "agent:main:telegram:default:direct:fixture-peer";
      const sessionId = "stolen-owner-session";
      insert(
        canonicalKey,
        { label: "canonical metadata", sessionId, updatedAt: 20 },
        "preserved history",
      );
      const db = database();
      db.db
        .prepare(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, '{}', ?)",
        )
        .run(staleKey, sessionId, 30);
      db.db
        .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
        .run(canonicalKey);
      db.db
        .prepare("UPDATE session_windows SET session_key = ? WHERE session_id = ?")
        .run(staleKey, sessionId);

      await expectRepair({ foundGroups: 1, repairedGroups: 0 }, false);
      await expectRepair({ foundGroups: 1, removedRows: 1, repairedGroups: 1 });
      expect(load(staleKey)).toBeUndefined();
      expect(load(canonicalKey)?.entry).toMatchObject({ label: "canonical metadata", sessionId });
      expect(
        db.db
          .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
          .get(sessionId),
      ).toEqual({ session_key: canonicalKey });
      await transcript(canonicalKey, sessionId, "preserved history");
      await expectRepair({ foundGroups: 0, repairedGroups: 0 });
    });
  });
});
