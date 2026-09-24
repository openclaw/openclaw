import type { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  listSessionEntriesReadOnly,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { updateSessionGroupCategoriesInWorker } from "../config/sessions/session-group-categories.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import * as transcriptWorker from "../config/sessions/session-transcript-worker-runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readSessionGroupMembership } from "./session-group-membership.read.js";
import { putSessionGroups } from "./session-groups.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";

function observeQueries(prototype: StatementSync) {
  const executed: string[] = [];
  const spies = (["all", "get", "iterate"] as const).map((method) => {
    const original = prototype[method];
    return vi.spyOn(prototype, method).mockImplementation(
      new Proxy(original, {
        apply(target, receiver: StatementSync, args) {
          executed.push(receiver.sourceSQL);
          return Reflect.apply(target, receiver, args);
        },
      }),
    );
  });
  return { executed, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

it("publishes byte-identical group and participant facts without membership SQL during cold admission, row refresh or 50 viewer reads", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:projected-members" };
    await upsertSessionEntryCore(scope, {
      sessionId: "projected-members",
      updatedAt: Date.now(),
      category: " Work ",
    });
    addSessionMember(scope, { identityId: "viewer", addedBy: "owner", addedAt: 1 });
    recordSessionParticipant(scope, { identity: { type: "agent", id: "research" }, promptedAt: 2 });
    recordSessionParticipant(scope, { identity: { type: "agent", id: "main" }, promptedAt: 1 });
    const database = openOpenClawAgentDatabase(scope);
    const prototype: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
    const admissionReads = observeQueries(prototype);
    let projection: SessionRowProjection | undefined;
    const query = { agentId: scope.agentId, key: scope.sessionKey };
    try {
      projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
      await projection.ensureMaterialized();
      admissionReads.restore();
      expect(
        admissionReads.executed.filter((sql) => /\bsession_(members|participants)\b/i.test(sql)),
      ).toEqual([]);
      const nativeListEntry = listSessionEntriesReadOnly({
        agentId: scope.agentId,
        projection: "list",
      }).find(({ sessionKey }) => sessionKey === scope.sessionKey)?.entry;
      expect(nativeListEntry).toMatchObject({
        participants: [
          { identity: { type: "agent", id: "main" } },
          { identity: { type: "agent", id: "research" } },
        ],
        participantCount: 2,
      });
      const nativeEntry = loadSessionEntry(scope);
      expect(nativeEntry).toMatchObject({
        participants: nativeListEntry?.participants,
        participantCount: 2,
      });
      expect(
        JSON.stringify({
          participants: projection.describe(query)?.entry.participants,
          participantCount: projection.describe(query)?.entry.participantCount,
        }),
      ).toBe(
        JSON.stringify({
          participants: nativeEntry?.participants,
          participantCount: nativeEntry?.participantCount,
        }),
      );
      const goldenGroups = JSON.stringify([
        ...new Map(readSessionGroupMembership({}, process.env).groups),
      ]);
      const goldenParticipants = JSON.stringify(projection.snapshot(query).row?.participants);
      expect(projection.describe(query)?.membership.has("viewer")).toBe(true);
      const reads = observeQueries(prototype);
      try {
        for (let viewer = 0; viewer < 50; viewer++) {
          expect(JSON.stringify([...projection.sessionGroupTargets()])).toBe(goldenGroups);
          expect(JSON.stringify(projection.snapshot(query).row?.participants)).toBe(
            goldenParticipants,
          );
          expect(projection.hasMembership(database.path, scope.sessionKey, "viewer")).toBe(true);
        }
        expect(
          reads.executed.filter((sql) => /\bsession_(members|participants)\b/i.test(sql)),
        ).toEqual([]);
      } finally {
        reads.restore();
      }
      // Revocation is visible before full-row materialization or another awaited worker read.
      removeSessionMember(scope, "viewer");
      expect(projection.hasMembership(database.path, scope.sessionKey, "viewer")).toBe(false);
      const refreshReads = observeQueries(prototype);
      try {
        await projection.ensureMaterialized();
        await projection.prepareMembership();
        expect(projection.describe(query)?.membership.has("viewer")).toBe(false);
        expect(JSON.stringify(projection.snapshot(query).row?.participants)).toBe(
          goldenParticipants,
        );
        expect(
          refreshReads.executed.filter((sql) => /\bsession_(members|participants)\b/i.test(sql)),
        ).toEqual([]);
      } finally {
        refreshReads.restore();
      }
    } finally {
      admissionReads.restore();
      projection?.dispose();
    }
  });
});

it("retains prepared membership across config changes and reconciles explicitly invalidated facts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:config-members" };
    await upsertSessionEntryCore(scope, { sessionId: "config-members", updatedAt: 1 });
    addSessionMember(scope, { identityId: "viewer", addedBy: "owner" });
    recordSessionParticipant(scope, { identity: { type: "agent", id: "research" }, promptedAt: 1 });
    const projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
    const membershipReads = vi.fn<(keys: readonly string[] | undefined) => void>();
    const readDatabases = transcriptWorker.withSessionHistoryWorkerDatabases;
    const observer = vi
      .spyOn(transcriptWorker, "withSessionHistoryWorkerDatabases")
      .mockImplementation((targets, consume) =>
        readDatabases(targets, (owners) =>
          consume(
            owners.map((owner) => ({
              ...owner,
              readMembershipFacts: (input: Parameters<typeof owner.readMembershipFacts>[0]) => {
                membershipReads(input.sessionKeys);
                return owner.readMembershipFacts(input);
              },
            })),
          ),
        ),
      );
    try {
      await projection.ensureMaterialized();
      membershipReads.mockClear();
      for (const factsInvalidated of [false, true]) {
        sessionChanges.emit({
          all: true,
          scope: "config",
          ...(factsInvalidated ? { factsInvalidated: true as const } : {}),
        });
        const described = await projection.withPreparedExactRows(
          () => [{ agentId: scope.agentId, key: scope.sessionKey }],
          (read) => read.describe({ agentId: scope.agentId, key: scope.sessionKey }),
        );
        expect(described).toMatchObject({
          kind: "complete",
          value: {
            entry: {
              sessionId: "config-members",
              participants: [{ identity: { type: "agent", id: "research" } }],
            },
            membership: new Set(["viewer"]),
          },
        });
        if (factsInvalidated) {
          expect(membershipReads).toHaveBeenCalledExactlyOnceWith(undefined);
        } else {
          expect(membershipReads).not.toHaveBeenCalled();
        }
      }
    } finally {
      observer.mockRestore();
      projection.dispose();
    }
  });
});

it.each(["before", "after"] as const)(
  "publishes final replacement facts to observers registered %s the projection",
  async (registration) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = { agentId: "main", sessionKey: "agent:main:transaction-members" };
      await upsertSessionEntryCore(scope, { sessionId: "old", updatedAt: 1, category: "old" });
      addSessionMember(scope, { identityId: "old-viewer", addedBy: "owner" });
      recordSessionParticipant(scope, {
        identity: { type: "agent", id: "research" },
        promptedAt: 1,
      });
      const database = openOpenClawAgentDatabase(scope);
      let projection: SessionRowProjection | undefined;
      let observing = false;
      const observed: Array<{
        old: boolean;
        current: boolean;
        transient: boolean;
        groups: string[];
      }> = [];
      const observe = () => {
        if (observing && projection) {
          observed.push({
            old: projection.hasMembership(database.path, scope.sessionKey, "old-viewer"),
            current: projection.hasMembership(database.path, scope.sessionKey, "current-viewer"),
            transient: projection.hasMembership(database.path, scope.sessionKey, "transient"),
            groups: [...projection.sessionGroupTargets().keys()],
          });
        }
      };
      let stop = registration === "before" ? sessionChanges.subscribe(observe) : () => {};
      try {
        projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
        await projection.ensureMaterialized();
        if (registration === "after") {
          stop = sessionChanges.subscribe(observe);
        }
        observing = true;
        runOpenClawAgentWriteTransaction(() => {
          replaceSessionEntrySync(scope, {
            sessionId: "intermediate",
            updatedAt: 2,
            category: "intermediate",
          });
          replaceSessionEntrySync(scope, {
            sessionId: "current",
            updatedAt: 3,
            category: "current",
          });
          addSessionMember(scope, { identityId: "transient", addedBy: "owner" });
          removeSessionMember(scope, "transient");
          addSessionMember(scope, { identityId: "current-viewer", addedBy: "owner" });
          recordSessionParticipant(scope, {
            identity: { type: "agent", id: "reviewer" },
            promptedAt: 2,
          });
          expect(() =>
            runOpenClawAgentWriteTransaction(() => {
              replaceSessionEntrySync(scope, {
                sessionId: "rolled-back",
                updatedAt: 4,
                category: "rolled-back",
              });
              addSessionMember(scope, { identityId: "rolled-back", addedBy: "owner" });
              throw new Error("rollback savepoint");
            }, scope),
          ).toThrow("rollback savepoint");
          expect(observed).toEqual([]);
        }, scope);
        expect(observed.length).toBeGreaterThan(0);
        for (const value of observed) {
          expect(value).toEqual({
            old: false,
            current: true,
            transient: false,
            groups: ["current"],
          });
        }
        expect(projection.needsMembershipPreparation()).toBe(false);
        expect(
          projection.describe({ agentId: scope.agentId, key: scope.sessionKey })?.entry,
        ).toMatchObject({
          sessionId: "current",
          category: "current",
          participants: [
            { identity: { type: "agent", id: "research" } },
            { identity: { type: "agent", id: "reviewer" } },
          ],
          participantCount: 2,
        });
      } finally {
        stop();
        projection?.dispose();
      }
    });
  },
);

it("installs every category in a worker reply before the first row observer", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {};
    await putSessionGroups({ cfg, names: ["work", "done"] });
    const keys = ["agent:main:category-a", "agent:main:category-b"];
    for (const sessionKey of keys) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: sessionKey,
          updatedAt: 1,
          category: "work",
        },
      );
    }
    let projection: SessionRowProjection | undefined;
    let observing = false;
    const observed: Array<Array<[string, readonly { agentId: string; sessionKey: string }[]]>> = [];
    const stop = sessionChanges.subscribe(() => {
      if (observing && projection) {
        observed.push([...projection.sessionGroupTargets()]);
      }
    });
    try {
      projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      await projection.ensureMaterialized();
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      observing = true;
      expect(
        await updateSessionGroupCategoriesInWorker({
          scope: { agentId: "main", sessionKey: "", storePath: database.path },
          from: "work",
          to: "done",
        }),
      ).toBe(2);
      expect(observed).toHaveLength(2);
      for (const value of observed) {
        expect(value).toEqual([
          ["done", keys.map((sessionKey) => ({ agentId: "main", sessionKey }))],
        ]);
      }
      expect(projection.needsMembershipPreparation()).toBe(false);
    } finally {
      stop();
      projection?.dispose();
    }
  });
});
