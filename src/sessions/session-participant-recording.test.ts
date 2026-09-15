import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import {
  listSessionEntriesCore,
  listSessionParticipantsReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawAgentDatabaseWrite } from "../state/openclaw-agent-db-write.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { onSessionLifecycleEvent } from "./session-lifecycle-events.js";
import { recordSessionParticipantBestEffort } from "./session-participant-recording.js";

it("defers inherited participant bookkeeping until the native writer reservation settles", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:participant" };
    await upsertSessionEntryCore(scope, { sessionId: "participant", updatedAt: 1 });
    const database = openOpenClawAgentDatabase(scope);
    const options = { ...scope, path: database.path };
    const read = () => listSessionEntriesCore({ ...scope, projection: "list" })[0]?.entry;
    read();
    const publications: Array<{ entry: ReturnType<typeof read>; inTransaction: boolean }> = [];
    const unsubscribe = onSessionLifecycleEvent((event) => {
      if (event.reason === "participants" && event.sessionKey === scope.sessionKey) {
        publications.push({ entry: read(), inTransaction: database.db.isTransaction });
      }
    });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const errors: unknown[] = [];
    const reservation = runOpenClawAgentWorkerWrite(options, async () => {
      expect(
        recordSessionParticipantBestEffort({
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          storePath: database.path,
          identity: { type: "agent", id: "helper" },
          promptedAt: 123,
          onError: (error) => errors.push(error),
        }),
      ).toBeUndefined();
      entered.resolve();
      await release.promise;
    });
    try {
      await Promise.race([entered.promise, reservation]);
      await setImmediate();
      expect(publications).toEqual([]);
      expect(read()?.participants ?? []).toEqual([]);
      release.resolve();
      await reservation;
      await withOpenClawAgentDatabaseWrite(options, () => undefined);
      const expected = {
        participantCount: 1,
        participants: [{ identity: { type: "agent", id: "helper" } }],
      };
      expect(publications).toEqual([
        { entry: expect.objectContaining(expected), inTransaction: false },
      ]);
      expect(read()).toMatchObject(expected);
      expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toEqual([
        {
          identity: { type: "agent", id: "helper" },
          contributionCount: 1,
          firstPromptedAt: 123,
          lastPromptedAt: 123,
        },
      ]);
      expect(errors).toEqual([]);
    } finally {
      release.resolve();
      await reservation;
      await withOpenClawAgentDatabaseWrite(options, () => undefined);
      unsubscribe();
    }
  });
});

it("reports a failed deferred write once and still commits following participant history", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:participant-error" };
    await upsertSessionEntryCore(scope, { sessionId: "participant-error", updatedAt: 1 });
    const database = openOpenClawAgentDatabase(scope);
    const options = { ...scope, path: database.path };
    database.db.exec(`CREATE TRIGGER reject_participant BEFORE INSERT ON session_participants
      WHEN NEW.actor_id = 'rejected'
      BEGIN SELECT RAISE(ABORT, 'synthetic participant failure'); END`);
    const errors: unknown[] = [];
    const publications: string[] = [];
    const unsubscribe = onSessionLifecycleEvent((event) => {
      if (event.reason === "participants" && event.sessionKey === scope.sessionKey) {
        publications.push(event.sessionKey);
      }
    });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const reservation = runOpenClawAgentWorkerWrite(options, async () => {
      for (const id of ["rejected", "following"]) {
        recordSessionParticipantBestEffort({
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          storePath: database.path,
          identity: { type: "agent", id },
          promptedAt: 456,
          onError: (error) => errors.push(error),
        });
      }
      entered.resolve();
      await release.promise;
    });
    try {
      await Promise.race([entered.promise, reservation]);
      await setImmediate();
      expect(errors).toEqual([]);
      expect(publications).toEqual([]);
      release.resolve();
      await reservation;
      await withOpenClawAgentDatabaseWrite(options, () => undefined);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ message: "synthetic participant failure" });
      expect(publications).toEqual([scope.sessionKey]);
      expect(listSessionEntriesCore({ ...scope, projection: "list" })[0]?.entry).toMatchObject({
        participantCount: 1,
        participants: [{ identity: { type: "agent", id: "following" } }],
      });
      expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toEqual([
        {
          identity: { type: "agent", id: "following" },
          contributionCount: 1,
          firstPromptedAt: 456,
          lastPromptedAt: 456,
        },
      ]);
    } finally {
      release.resolve();
      await reservation;
      await withOpenClawAgentDatabaseWrite(options, () => undefined);
      unsubscribe();
    }
  });
});
