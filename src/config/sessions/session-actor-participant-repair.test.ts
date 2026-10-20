import { expect, it } from "vitest";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { copySessionNodeArtifactsForRepair } from "./session-accessor.sqlite-node-artifacts.js";
import { participantRecordsBySessionKey } from "./session-accessor.sqlite-participant-projection.js";
import { recordSessionParticipantFromWorker } from "./session-accessor.sqlite-participants.native.js";
import { participantRecord, withActor } from "./session-actor-worker.test-support.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
import { readSessionMembershipFactsInDatabase } from "./session-membership-facts.js";

it.each(["same-store", "cross-store"])(
  "publishes merged participants to a warm actor after %s canonical repair",
  async (kind) => {
    await withActor((f) => {
      const source =
        kind === "same-store" ? f.database : openOpenClawAgentDatabase({ agentId: "source" });
      const sourceScope = {
        agentId: source.agentId,
        path: source.path,
        sessionKey: `agent:${source.agentId}:repair-source`,
      };
      runSqliteImmediateTransactionSync(source.db, () => {
        writeSessionEntry(source, sourceScope.sessionKey, { sessionId: "source", updatedAt: 1 });
        for (const [id, promptedAt] of [
          ["shared", 10],
          ["shared", 30],
          ["new", 5],
        ] as const) {
          recordSessionParticipantFromWorker(source, sourceScope, {
            identity: { type: "agent", id },
            promptedAt,
          });
        }
      });
      f.read();
      f.participant({ identity: { type: "agent", id: "shared" }, promptedAt: 20 });
      f.participant({ identity: { type: "agent", id: "destination-only" }, promptedAt: 15 });
      const before = f.read();
      const postimages: SessionEntryWritePostimages = new Map();
      const repair = () => {
        // A previous write in this transaction has already staged the resident actor's facts.
        recordSessionParticipantFromWorker(f.database, f.scope, {
          identity: { type: "agent", id: "shared" },
          promptedAt: 25,
        });
        writeSessionEntry(f.database, f.target.sessionKey, before.entry!, { postimages });
        copySessionNodeArtifactsForRepair(
          source,
          f.database,
          [sourceScope.sessionKey],
          f.target.sessionKey,
          {
            postimages,
          },
        );
      };
      expect(() =>
        runSqliteImmediateTransactionSync(f.database.db, () => {
          repair();
          throw new Error("roll back repair");
        }),
      ).toThrow("roll back repair");
      expect(f.read().participants).toEqual(before.participants);
      runSqliteImmediateTransactionSync(f.database.db, repair);
      const expected = [
        participantRecord("new", 1, 5),
        participantRecord("shared", kind === "same-store" ? 4 : 2, 10, 30),
        participantRecord("destination-only", 1, 15),
      ];
      expect(f.read().participants).toEqual(expected);
      expect(postimages.get(f.target.sessionKey)?.entry).toMatchObject({
        participants: expected.map(({ identity }) => ({ identity })),
        participantCount: 3,
      });
      expect(
        participantRecordsBySessionKey(f.database.db, [f.target.sessionKey]).get(
          f.target.sessionKey,
        ),
      ).toEqual(expected);
      expect(
        readSessionMembershipFactsInDatabase(f.database, [f.target.sessionKey]).facts[0]?.[3],
      ).toEqual({
        participants: expected.map(({ identity }) => ({ identity })),
        participantCount: 3,
      });
      f.participant({ identity: { type: "agent", id: "shared" }, promptedAt: 40 });
      expect(f.read().participants[1]).toMatchObject({
        contributionCount: kind === "same-store" ? 5 : 3,
        lastPromptedAt: 40,
      });
      f.restartActor();
      expect(f.read().participants[1]).toMatchObject({
        contributionCount: kind === "same-store" ? 5 : 3,
        lastPromptedAt: 40,
      });
    });
  },
);
