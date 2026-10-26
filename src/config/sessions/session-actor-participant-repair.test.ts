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

const participant = (id: string, promptedAt: number) => ({
  identity: { type: "agent" as const, id },
  promptedAt,
});

it.each(["same-store", "cross-store"])(
  "publishes merged participants to a warm actor after %s canonical repair",
  async (kind) => {
    await withActor((f) => {
      const key = f.target.sessionKey;
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
          recordSessionParticipantFromWorker(source, sourceScope, participant(id, promptedAt));
        }
      });
      f.read();
      f.participant(participant("shared", 20));
      f.participant(participant("destination-only", 15));
      f.writeEntry({
        ...f.read().entry!,
        category: "work",
        owner: { actor: { type: "human", id: "alice" } },
      });
      const before = f.read();
      const postimages: SessionEntryWritePostimages = new Map();
      const repair = () => {
        // A previous write in this transaction has already staged the resident actor's facts.
        recordSessionParticipantFromWorker(f.database, f.scope, participant("shared", 25));
        writeSessionEntry(f.database, key, before.entry!, { postimages });
        copySessionNodeArtifactsForRepair(source, f.database, [sourceScope.sessionKey], key, {
          postimages,
        });
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
      const projected = {
        participants: expected.map(({ identity }) => ({ identity })),
        participantCount: 3,
      };
      expect(postimages.get(key)?.entry).toMatchObject(projected);
      expect(participantRecordsBySessionKey(f.database.db, [key]).get(key)).toEqual(expected);
      const membership = readSessionMembershipFactsInDatabase(f.database, [key]).facts[0];
      expect(membership).toEqual([key, "work", [], projected, before.entry!.sessionId]);
      f.participant(participant("shared", 40));
      const afterPrompt = {
        contributionCount: kind === "same-store" ? 5 : 3,
        lastPromptedAt: 40,
      };
      expect(f.read().participants[1]).toMatchObject(afterPrompt);
      f.writeEntry({
        ...f.read().entry!,
        category: "personal",
        owner: { actor: { type: "human", id: "bob" } },
      });
      expect(readSessionMembershipFactsInDatabase(f.database).facts).toContainEqual([
        key,
        "personal",
        [],
        expect.objectContaining({ participantCount: 3 }),
        before.entry!.sessionId,
      ]);
      f.restartActor();
      expect(f.read().participants[1]).toMatchObject(afterPrompt);
    });
  },
);
