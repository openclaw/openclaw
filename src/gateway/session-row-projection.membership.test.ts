import type { StatementSync } from "node:sqlite";
import { expect, it } from "vitest";
import * as sqlObserver from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as sessions from "../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { updateSessionGroupCategoriesInWorker } from "../config/sessions/session-group-categories.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import * as agentDb from "../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readSessionGroupMembership } from "./session-group-membership.read.js";
import { putSessionGroups } from "./session-groups.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";

function observeQueries(prototype: StatementSync) {
  const { queries, restore } = sqlObserver.observeSqliteReadSql(prototype);
  return {
    expectNoMembershipSql: () =>
      expect(queries.filter((sql) => /\bsession_(members|participants)\b/i.test(sql))).toEqual([]),
    [Symbol.dispose]: restore,
  };
}

const participant = (id: string) => ({ identity: { type: "agent" as const, id } });
const participantBytes = (entry: ReturnType<typeof sessions.loadSessionEntry>) =>
  JSON.stringify({ participants: entry?.participants, participantCount: entry?.participantCount });

it("publishes byte-identical group and participant facts without host membership SQL during cold admission, row refresh or 50 viewer reads", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const scope = { agentId: "main", sessionKey: "agent:main:projected-members" };
    await sessions.upsertSessionEntryCore(scope, {
      sessionId: "projected-members",
      updatedAt: Date.now(),
      category: " Work ",
    });
    addSessionMember(scope, { identityId: "viewer", addedBy: "owner", addedAt: 1 });
    recordSessionParticipant(scope, { identity: { type: "agent", id: "research" }, promptedAt: 2 });
    recordSessionParticipant(scope, { identity: { type: "agent", id: "main" }, promptedAt: 1 });
    const database = agentDb.openOpenClawAgentDatabase(scope);
    const prototype: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
    // Profile display admission has its own owner; keep this boundary on the cold session store.
    const profiles = await prepareUserProfileCatalog();
    const admissionReads = sqlObserver.observeHostDataSql();
    let projection: SessionRowProjection | undefined;
    const query = { agentId: scope.agentId, key: scope.sessionKey };
    try {
      projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
      await projection.ensureMaterialized();
      admissionReads.restore();
      expect(admissionReads.queries).toEqual([]);
      const listed = sessions
        .listSessionEntriesReadOnly({
          agentId: scope.agentId,
          projection: "list",
        })
        .find(({ sessionKey }) => sessionKey === scope.sessionKey)?.entry;
      expect(listed).toMatchObject({
        participants: [participant("main"), participant("research")],
        participantCount: 2,
      });
      const nativeEntry = sessions.loadSessionEntry(scope);
      expect(nativeEntry).toMatchObject({
        participants: listed?.participants,
        participantCount: 2,
      });
      const described = projection.describe(query);
      expect(participantBytes(described?.entry)).toBe(participantBytes(nativeEntry));
      const goldenGroups = JSON.stringify([...readSessionGroupMembership({}, process.env).groups]);
      const participantsJson = () => JSON.stringify(projection!.snapshot(query).row?.participants);
      const goldenParticipants = participantsJson();
      expect(described?.membership.has("viewer")).toBe(true);
      {
        using reads = observeQueries(prototype);
        for (let viewer = 0; viewer < 50; viewer++) {
          expect(JSON.stringify([...projection.sessionGroupTargets()])).toBe(goldenGroups);
          expect(participantsJson()).toBe(goldenParticipants);
          expect(projection.hasMembership(database.path, scope.sessionKey, "viewer")).toBe(true);
        }
        reads.expectNoMembershipSql();
      }
      // Revocation is visible before full-row materialization or another awaited worker read.
      removeSessionMember(scope, "viewer");
      expect(projection.hasMembership(database.path, scope.sessionKey, "viewer")).toBe(false);
      {
        using refreshReads = observeQueries(prototype);
        await projection.ensureMaterialized();
        await projection.prepareMembership();
        expect(projection.describe(query)?.membership.has("viewer")).toBe(false);
        expect(participantsJson()).toBe(goldenParticipants);
        refreshReads.expectNoMembershipSql();
      }
    } finally {
      admissionReads.restore();
      projection?.dispose();
      profiles.release();
    }
  });
});

it.each(["transaction", "worker"] as const)(
  "installs complete %s facts before pre-registered observers",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = {};
      setRuntimeConfigSnapshot(cfg);
      const transaction = mode === "transaction";
      const keys = transaction
        ? ["agent:main:transaction-members"]
        : ["agent:main:category-a", "agent:main:category-b"];
      const scope = { agentId: "main", sessionKey: keys[0]! };
      if (!transaction) {
        await putSessionGroups({ cfg, names: ["work", "done"] });
      }
      for (const sessionKey of keys) {
        await sessions.upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: transaction ? "old" : sessionKey,
            updatedAt: 1,
            category: transaction ? "old" : "work",
          },
        );
      }
      if (transaction) {
        addSessionMember(scope, { identityId: "old-viewer", addedBy: "owner" });
        recordSessionParticipant(scope, { ...participant("research"), promptedAt: 1 });
      }
      const { path } = agentDb.openOpenClawAgentDatabase(scope);
      const replace = (sessionId: string, updatedAt: number) =>
        sessions.replaceSessionEntrySync(scope, { sessionId, updatedAt, category: sessionId });
      let projection: SessionRowProjection | undefined;
      let observing = false;
      const observed: unknown[] = [];
      const stop = sessionChanges.subscribe(() => {
        if (observing && projection) {
          observed.push(
            transaction
              ? {
                  old: projection.hasMembership(path, scope.sessionKey, "old-viewer"),
                  current: projection.hasMembership(path, scope.sessionKey, "current-viewer"),
                  transient: projection.hasMembership(path, scope.sessionKey, "transient"),
                  groups: [...projection.sessionGroupTargets().keys()],
                }
              : [...projection.sessionGroupTargets()],
          );
        }
      });
      try {
        projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
        await projection.ensureMaterialized();
        observing = true;
        if (transaction) {
          agentDb.runOpenClawAgentWriteTransaction(() => {
            replace("intermediate", 2);
            replace("current", 3);
            addSessionMember(scope, { identityId: "transient", addedBy: "owner" });
            removeSessionMember(scope, "transient");
            addSessionMember(scope, { identityId: "current-viewer", addedBy: "owner" });
            recordSessionParticipant(scope, { ...participant("reviewer"), promptedAt: 2 });
            expect(() =>
              agentDb.runOpenClawAgentWriteTransaction(() => {
                replace("rolled-back", 4);
                addSessionMember(scope, { identityId: "rolled-back", addedBy: "owner" });
                throw new Error("rollback savepoint");
              }, scope),
            ).toThrow("rollback savepoint");
            expect(observed).toEqual([]);
          }, scope);
          expect(observed.length).toBeGreaterThan(0);
        } else {
          expect(
            await updateSessionGroupCategoriesInWorker({
              scope: { agentId: "main", sessionKey: "", storePath: path },
              from: "work",
              to: "done",
            }),
          ).toBe(2);
          expect(observed).toHaveLength(2);
        }
        const expected = transaction
          ? { old: false, current: true, transient: false, groups: ["current"] }
          : [["done", keys.map((sessionKey) => ({ agentId: "main", sessionKey }))]];
        for (const value of observed) {
          expect(value).toEqual(expected);
        }
        expect(projection.needsMembershipPreparation()).toBe(false);
        if (transaction) {
          const query = { agentId: scope.agentId, key: scope.sessionKey };
          const entry = await withReadySessionRows(
            projection,
            () => [query],
            (read) => read.describe(query)?.entry,
          );
          expect(entry).toMatchObject({
            sessionId: "current",
            category: "current",
            participants: [participant("research"), participant("reviewer")],
            participantCount: 2,
          });
        }
      } finally {
        stop();
        projection?.dispose();
      }
    });
  },
);
