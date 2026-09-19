import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import * as configEnv from "../config/config-env-vars.js";
import {
  listSessionEntriesCore,
  listSessionParticipantsReadOnly,
  recordSessionParticipant,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawAgentDatabaseWrite } from "../state/openclaw-agent-db-write.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import {
  ensureProfileForEmail,
  linkEmail,
  readUserProfileAliases,
} from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
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

it("keeps merged-profile participant history in a mixed-case Windows state root", async () => {
  await withOpenClawTestState({ scenario: "minimal", layout: "split" }, async (state) => {
    const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:participant-alias" };
    const previous = ensureProfileForEmail("previous@example.test", { env: state.env });
    const current = ensureProfileForEmail("current@example.test", { env: state.env });
    await upsertSessionEntryCore(scope, { sessionId: "participant-alias", updatedAt: 1 });
    recordSessionParticipant(scope, {
      identity: { type: "profile", id: previous.id },
      promptedAt: 10,
    });
    linkEmail("previous@example.test", current.id, { env: state.env });
    expect(readUserProfileAliases(current.id, { env: state.env })).toEqual(
      new Set([current.id, previous.id]),
    );
    const database = openOpenClawAgentDatabase(scope);
    const options = { ...scope, path: database.path };
    const originalEnv = process.env;
    const hostPlatform = process.platform;
    const mixedCaseEnv = { ...originalEnv };
    for (const key of Object.keys(mixedCaseEnv)) {
      if (key.toUpperCase() === "OPENCLAW_STATE_DIR") {
        delete mixedCaseEnv[key];
      }
    }
    mixedCaseEnv.OpenClaw_State_Dir = state.stateDir;
    const cloneEnv = configEnv.cloneEnvWithPlatformSemantics;
    const clone = vi.spyOn(configEnv, "cloneEnvWithPlatformSemantics").mockImplementation((input) =>
      // Only the pure clone sees Windows; target resolution and SQLite use the real host.
      withMockedPlatform("win32", () => cloneEnv(input)),
    );
    const errors: unknown[] = [];
    try {
      process.env = mixedCaseEnv;
      expect(
        recordSessionParticipantBestEffort({
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          storePath: database.path,
          identity: { type: "profile", id: current.id },
          promptedAt: 20,
          onError: (error) => errors.push(error),
        }),
      ).toBeUndefined();
      // Preserve the producer's deferred capture, then retire the ambient fixture input.
      await Promise.resolve();
      process.env = originalEnv;
      expect(process.platform).toBe(hostPlatform);
      await withOpenClawAgentDatabaseWrite(options, () => undefined);
      expect(errors).toEqual([]);
      expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toEqual([
        {
          identity: { type: "profile", id: previous.id },
          contributionCount: 2,
          firstPromptedAt: 10,
          lastPromptedAt: 20,
        },
      ]);
    } finally {
      process.env = originalEnv;
      try {
        await withOpenClawAgentDatabaseWrite(options, () => undefined);
      } finally {
        clone.mockRestore();
      }
    }
  });
});
