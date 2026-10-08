import "./session-accessor.sqlite-replacement-publication.test-support.js";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createSessionMembershipProjection } from "../../gateway/session-membership-projection.js";
import { createSessionRowProjection } from "../../gateway/session-row-projection.js";
import * as logging from "../../logging/logger.js";
import {
  onSessionIdentityMutation,
  type SessionIdentityMutation,
} from "../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readPreparedSessionEntryChange } from "./session-accessor.sqlite-entry-cache-publication.js";
import {
  projectSessionSharingEntry,
  readCommittedSessionEntryCache,
  readSessionEntryCache,
  retainPreparedSessionSharingFacts,
  retainSessionEntryWorkerPublication,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { assignSessionOwner } from "./session-accessor.sqlite-owner.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { applySessionEntryExactReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import { prepareSessionDeliveryGeneration } from "./session-delivery-generation.js";
import { readPreparedSessionParticipants } from "./session-participant-prepared-read.js";
import { addSessionMember, removeSessionMember } from "./session-sharing-store.native.js";
import type { InternalSessionEntry } from "./types.js";

const { getReplacementPublicationDelivery } =
  await import("./session-accessor.sqlite-replacement-publication.test-support.js");
const delivery = getReplacementPublicationDelivery();

afterEach(() => {
  vi.restoreAllMocks();
});

it("settles publication before a successor writer and preserves metadata after worker retirement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:successor-worker",
      storePath: database.path,
    };
    replaceSessionEntrySync(scope, {
      sessionId: "successor-worker",
      updatedAt: 1,
      label: "initial",
    });
    const projection = await createSessionRowProjection({ cfg: {} });
    const replace = (label: string) =>
      applySessionEntryExactReplacements({
        agentId: scope.agentId,
        storePath: scope.storePath,
        sessionKeys: [scope.sessionKey],
        update: ([row]) => ({
          result: undefined,
          replacements: [{ sessionKey: scope.sessionKey, entry: { ...row!.entry, label } }],
        }),
      });
    let successor: Promise<void> | undefined;
    delivery.afterRelease = async () => {
      successor = replace("successor");
    };
    try {
      await replace("retired");
      expect(successor).toBeDefined();
      await successor;
      const query = { agentId: scope.agentId, key: scope.sessionKey, storePath: scope.storePath };
      expect(projection.capture(query)?.storedEntry?.label).toBe("successor");
      expect(projection.sharingTarget(query)?.entry.sessionId).toBe("successor-worker");
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
      await replace("new generation");
      await projection.ensureMaterialized();
      expect(projection.capture(query)?.storedEntry?.label).toBe("new generation");
    } finally {
      projection.dispose();
    }
  });
});

it("publishes foreign membership facts and fences native side changes after worker commit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const scope = {
      agentId: "main",
      storePath: database.path,
      sessionKey: "agent:main:membership-receipt",
    };
    const original = {
      sessionId: "membership-receipt",
      lifecycleRevision: "membership-receipt-lifecycle",
      updatedAt: 1,
      category: "work",
    };
    writeSessionEntry(database, scope.sessionKey, original);
    const identity = readOpenClawAgentDatabaseIdentity(database);
    if (typeof identity.identity !== "string") {
      throw new Error("Expected durable membership fixture");
    }
    const generation = await prepareSessionDeliveryGeneration({
      ...scope,
      sessionId: original.sessionId,
      lifecycleRevision: original.lifecycleRevision,
    });
    generation.assertCurrent();
    const projection = createSessionMembershipProjection();
    projection.updateTargets([{ ...scope, ...identity }]);
    const stop = sessionChanges.subscribeFacts((change) => projection.invalidate(change));
    const participants = () =>
      projection.withPreparedParticipantRead(() =>
        readPreparedSessionParticipants(database.db, scope.sessionKey),
      );
    const replace = (label: string) =>
      applySessionEntryExactReplacements({
        agentId: scope.agentId,
        storePath: scope.storePath,
        sessionKeys: [scope.sessionKey],
        update: ([row]) => ({
          result: undefined,
          replacements: [{ sessionKey: scope.sessionKey, entry: { ...row!.entry, label } }],
        }),
      });
    try {
      await projection.prepare();
      const expectedParticipants: NonNullable<InternalSessionEntry["participants"]> = [];
      const interventions = ["none", "member", "participant", "entry"] as const;
      for (const [index, intervention] of interventions.entries()) {
        for (const member of projection.membership(database.path, scope.sessionKey) ?? []) {
          removeSessionMember(scope, member);
        }
        addSessionMember(scope, { identityId: "original-member", addedBy: "owner", addedAt: 1 });
        await projection.prepare();
        const sharing = retainPreparedSessionSharingFacts({
          databaseIdentity: `file:${identity.identity}`,
          sessionKey: scope.sessionKey,
          entry: projectSessionSharingEntry(
            readExactSessionEntryRow(database, scope.sessionKey)!.entry,
          ),
          membership: new Set(projection.membership(database.path, scope.sessionKey)),
        });
        const foreignMember = `foreign-member-${index}`;
        const foreignParticipant = `foreign-participant-${index}`;
        try {
          expect(sharing.readCurrent()?.membership).toEqual(new Set(["original-member"]));
          {
            using peer = new DatabaseSync(database.path);
            peer
              .prepare("UPDATE session_members SET identity_id = ? WHERE session_key = ?")
              .run(foreignMember, scope.sessionKey);
            peer
              .prepare(
                `INSERT INTO session_participants
                 (session_key, identity_namespace, actor_id, contribution_count, first_prompted_at)
                 VALUES (?, ?, ?, 1, ?)`,
              )
              .run(
                scope.sessionKey,
                JSON.stringify({ type: "agent" }),
                foreignParticipant,
                index * 2 + 1,
              );
          }
          expectedParticipants.push({ identity: { type: "agent", id: foreignParticipant } });
          delivery.afterResult = () => {
            if (intervention === "member") {
              removeSessionMember(scope, foreignMember);
            } else if (intervention === "participant") {
              recordSessionParticipant(scope, {
                identity: { type: "agent", id: "native-participant" },
                promptedAt: index * 2 + 2,
              });
              expectedParticipants.push({ identity: { type: "agent", id: "native-participant" } });
            } else if (intervention === "entry") {
              replaceSessionEntrySync(scope, {
                ...readExactSessionEntryRow(database, scope.sessionKey)!.entry,
                label: "newer native entry",
                category: "native",
              });
            }
          };
          await replace(`foreign facts before ${intervention}`);
          generation.assertCurrent();
          expect(projection.needsPreparation).toBe(intervention !== "none");
          if (intervention === "none") {
            expect(sharing.readCurrent()?.membership).toEqual(new Set([foreignMember]));
            expect(projection.membership(database.path, scope.sessionKey)).toEqual([foreignMember]);
          } else {
            // A current session generation cannot certify a suppressed membership receipt.
            expect(sharing.readCurrent()).toBeUndefined();
            expect(projection.membership(database.path, scope.sessionKey)).toEqual([]);
          }
          await projection.prepare();
          expect(projection.membership(database.path, scope.sessionKey)).toEqual(
            intervention === "member" ? [] : [foreignMember],
          );
          expect(participants()).toEqual({
            participants: expectedParticipants,
            participantCount: expectedParticipants.length,
          });
          if (intervention === "entry") {
            expect(readExactSessionEntryRow(database, scope.sessionKey)?.entry).toMatchObject({
              label: "newer native entry",
              category: "native",
            });
            expect([...projection.groupTargets().keys()]).toEqual(["native"]);
          }
        } finally {
          delivery.afterResult = undefined;
          sharing.release();
        }
      }
    } finally {
      delivery.afterResult = undefined;
      stop();
      projection.dispose();
      generation.release();
    }
  });
});

it.each([
  "metadata only",
  "metadata then newer native write",
  "metadata then newer native reset",
  "lost result",
  "callback failure",
  "release failure",
  "newer native write",
  "newer native write after reset",
  "late writer",
] as const)("preserves replacement publication through %s", async (boundary) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cleanupWarnings: unknown[][] = [];
    const getChildLogger = logging.getChildLogger;
    vi.spyOn(logging, "getChildLogger").mockImplementation((...args) => {
      const logger = getChildLogger(...args);
      const warn = logger.warn.bind(logger);
      vi.spyOn(logger, "warn").mockImplementation((...values) => {
        if (values[0] === "Session mutation completed before executor cleanup failed") {
          cleanupWarnings.push(values);
        }
        return warn(...values);
      });
      return logger;
    });
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const options = { agentId: "main", path: database.path };
    const sessionKey = "agent:main:replacement-settlement";
    const metadataOnly = boundary.startsWith("metadata");
    const workerVisibility = metadataOnly ? "shared" : "read-only";
    const reset =
      boundary === "newer native write after reset" ||
      boundary === "metadata then newer native reset";
    const newerNative =
      boundary === "newer native write" || boundary === "metadata then newer native write" || reset;
    const original = {
      sessionId: "settlement",
      lifecycleRevision: "initial-lifecycle",
      updatedAt: 1,
      visibility: "shared" as const,
      label: "before",
      category: "before",
    };
    writeSessionEntry(database, sessionKey, original);
    addSessionMember(
      { agentId: "main", storePath: database.path, sessionKey },
      { identityId: "member", addedBy: "owner", addedAt: 1 },
    );
    const identity = readOpenClawAgentDatabaseIdentity(database).identity;
    if (typeof identity !== "string") {
      throw new Error("Expected durable fixture");
    }
    const sharing = retainPreparedSessionSharingFacts({
      databaseIdentity: `file:${identity}`,
      sessionKey,
      entry: projectSessionSharingEntry(original),
      membership: new Set(["member"]),
    });
    const generation = await prepareSessionDeliveryGeneration({
      agentId: "main",
      storePath: database.path,
      sessionKey,
      sessionId: original.sessionId,
      lifecycleRevision: original.lifecycleRevision,
    });
    generation.assertCurrent();
    const projection = createSessionMembershipProjection();
    projection.updateTargets([
      { ...options, storePath: database.path, ...readOpenClawAgentDatabaseIdentity(database) },
    ]);
    let callbackPublication: ReturnType<typeof readPreparedSessionEntryChange>;
    const stopFacts = sessionChanges.subscribeFacts((change) => {
      projection.invalidate(change);
      if (
        boundary === "callback failure" &&
        "sessionKey" in change &&
        change.sessionKey === sessionKey
      ) {
        callbackPublication = readPreparedSessionEntryChange(change, sessionKey);
      }
    });
    await projection.prepare();
    expect([...projection.groupTargets().keys()]).toEqual(["before"]);
    expect(projection.membership(database.path, sessionKey)).toEqual(["member"]);
    let writer = database;
    if (boundary === "late writer") {
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
    } else {
      readSessionEntryCache(writer, { cache: true });
    }
    const observed: Array<string | undefined> = [];
    const caches: unknown[] = [];
    const mutations: SessionIdentityMutation[] = [];
    const stopIdentity = onSessionIdentityMutation((mutation) => mutations.push(mutation));
    const stop = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === sessionKey) {
        observed.push(sharing.readCurrent()?.entry?.visibility);
        caches.push(readCommittedSessionEntryCache(writer.db)?.get(sessionKey)?.label);
      }
    });
    let executions = 0;
    let whileWaiting: ReturnType<typeof sharing.readCurrent>;
    const failure = new Error(`synthetic ${boundary}`);
    delivery.afterResult = () => {
      executions++;
      whileWaiting = sharing.readCurrent();
      // Only a held write that changes the incarnation fences generation reads; a
      // replaced writer database leaves the retained source unverifiable either way.
      if (boundary === "newer native write after reset" || boundary === "late writer") {
        expect(generation.assertCurrent).toThrow(
          expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
        );
      } else {
        generation.assertCurrent();
      }
      if (boundary === "lost result") {
        throw failure;
      }
      if (newerNative) {
        replaceSessionEntrySync(
          { agentId: "main", storePath: database.path, sessionKey },
          {
            ...readExactSessionEntryRow(database, sessionKey)!.entry,
            updatedAt: 3,
            visibility: "draft",
            label: "newer",
            category: "newer",
            ...(boundary === "metadata then newer native reset"
              ? { lifecycleRevision: "next-lifecycle" }
              : {}),
          },
        );
      }
    };
    if (boundary === "release failure") {
      delivery.releaseFailure = failure;
    }
    try {
      const operation = applySessionEntryExactReplacements({
        storePath: database.path,
        sessionKeys: [sessionKey],
        ...(boundary === "callback failure" && {
          onLifecycleCommitted: () => {
            throw failure;
          },
        }),
        update: ([row]) => {
          if (boundary === "late writer") {
            writer = openOpenClawAgentDatabase(options);
            readSessionEntryCache(writer, { cache: true });
          }
          return {
            result: undefined,
            replacements: [
              {
                sessionKey,
                entry: {
                  ...row!.entry,
                  visibility: workerVisibility,
                  label: "worker",
                  category: "worker",
                  ...(boundary === "newer native write after reset"
                    ? { lifecycleRevision: "next-lifecycle" }
                    : {}),
                },
              },
            ],
          };
        },
      });
      if (boundary === "lost result" || boundary === "callback failure") {
        await expect(operation).rejects.toBe(failure);
      } else {
        await operation;
      }
      if (boundary === "callback failure") {
        expect(callbackPublication?.entry).toMatchObject({
          sessionId: original.sessionId,
          label: "worker",
          category: "worker",
        });
        expect(callbackPublication?.source).toMatchObject({
          identity,
          revision: expect.any(Number),
        });
      }
      expect(executions).toBe(1);
      expect(cleanupWarnings).toEqual(
        boundary === "release failure"
          ? [
              [
                "Session mutation completed before executor cleanup failed",
                { errors: [failure.message] },
              ],
            ]
          : [],
      );
      if (metadataOnly) {
        expect(whileWaiting).toMatchObject({
          entry: { visibility: "shared" },
          membership: new Set(["member"]),
        });
      } else if (boundary !== "late writer") {
        expect(whileWaiting).toBeUndefined();
      }
      if (newerNative) {
        expect(sharing.readCurrent()).toBeUndefined();
      } else {
        expect(sharing.readCurrent()).toMatchObject({
          entry: { visibility: workerVisibility },
          membership: new Set(["member"]),
        });
      }
      if (reset) {
        expect(generation.assertCurrent).toThrow(
          expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_REVOKED" }),
        );
      } else if (boundary === "late writer") {
        expect(generation.assertCurrent).toThrow(
          expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
        );
      } else {
        generation.assertCurrent();
      }
      expect(mutations).toEqual(
        reset
          ? [
              {
                agentId: "main",
                databaseIdentity: identity,
                kind: "reset",
                previous: { sessionId: "settlement", sessionKeys: [sessionKey] },
                current: { sessionId: "settlement", sessionKeys: [sessionKey] },
              },
            ]
          : [],
      );
      expect(readExactSessionEntryRow(writer, sessionKey)?.entry.label).toBe(
        newerNative ? "newer" : "worker",
      );
      expect(projection.needsPreparation).toBe(newerNative);
      if (!newerNative) {
        expect(projection.membership(database.path, sessionKey)).toEqual(["member"]);
      }
      await projection.prepare();
      expect([...projection.groupTargets()]).toEqual([
        [newerNative ? "newer" : "worker", [{ sessionKey, agentId: "main" }]],
      ]);
      expect(observed).toEqual(
        newerNative ? [reset ? undefined : "draft", undefined] : [workerVisibility],
      );
      if (boundary === "late writer") {
        expect(caches).toEqual([undefined]);
      }
    } finally {
      delivery.afterResult = undefined;
      delivery.releaseFailure = undefined;
      stop();
      stopIdentity();
      stopFacts();
      projection.dispose();
      sharing.release();
      generation.release();
    }
  });
});

it.each([
  { boundary: "reply", reset: false },
  { boundary: "reply", reset: true },
  { boundary: "observer", reset: false },
  { boundary: "observer", reset: true },
])(
  "preserves native owner changes during $boundary publication (reset=$reset)",
  async ({ boundary, reset }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: "agent:main:owner-publication-race",
      };
      const original = {
        sessionId: "owner-publication-race",
        lifecycleRevision: "retained-lifecycle",
        updatedAt: 1,
        label: "before",
      };
      replaceSessionEntrySync(scope, original);
      const initialOwner = {
        actor: { type: "human" as const, id: "initial-owner" },
        assignedBy: { type: "system" as const, id: "fixture" },
        assignedAt: 1,
      };
      assignSessionOwner(scope, {
        owner: initialOwner.actor,
        assignedBy: initialOwner.assignedBy,
        assignedAt: initialOwner.assignedAt,
      });
      const identity = readOpenClawAgentDatabaseIdentity(database).identity;
      if (typeof identity !== "string") {
        throw new Error("Expected durable owner fixture");
      }
      const generation = await prepareSessionDeliveryGeneration({
        ...scope,
        sessionId: original.sessionId,
        lifecycleRevision: original.lifecycleRevision,
      });
      const sharing = retainPreparedSessionSharingFacts({
        databaseIdentity: `file:${identity}`,
        sessionKey: scope.sessionKey,
        entry: projectSessionSharingEntry(
          readExactSessionEntryRow(database, scope.sessionKey)!.entry,
        ),
        membership: new Set(),
      });
      const projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
      const query = { agentId: scope.agentId, storePath: scope.storePath, key: scope.sessionKey };
      const newerOwner = {
        ...initialOwner,
        actor: { type: "human" as const, id: "newer-owner" },
        assignedAt: 2,
      };
      const lifecycleRevision = reset ? "worker-reset-lifecycle" : original.lifecycleRevision;
      const observed: Array<{
        entryOwner: InternalSessionEntry["owner"];
        storedOwner: InternalSessionEntry["owner"];
        sharingOwner: InternalSessionEntry["owner"];
      }> = [];
      const identityRows: Array<{
        entry: InternalSessionEntry | undefined;
        storedEntry: InternalSessionEntry | undefined;
      }> = [];
      let ownerAssigned = false;
      let assignment: ReturnType<typeof assignSessionOwner> | undefined;
      const assignNewOwner = () => {
        ownerAssigned = true;
        assignment = assignSessionOwner(scope, {
          owner: newerOwner.actor,
          assignedBy: newerOwner.assignedBy,
          assignedAt: newerOwner.assignedAt,
        });
      };
      let stop = () => {};
      let stopIdentity = () => {};
      try {
        await projection.ensureMaterialized();
        expect(projection.capture(query)?.storedEntry?.owner).toEqual(initialOwner);
        expect(sharing.readCurrent()?.entry?.owner).toEqual(initialOwner);
        generation.assertCurrent();
        stop = sessionChanges.subscribe((change) => {
          if (!("sessionKey" in change) || change.sessionKey !== scope.sessionKey) {
            return;
          }
          if (boundary === "observer" && !ownerAssigned) {
            assignNewOwner();
          }
          const row = projection.capture(query);
          observed.push(
            structuredClone({
              entryOwner: row?.entry?.owner,
              storedOwner: row?.storedEntry?.owner,
              sharingOwner: sharing.readCurrent()?.entry?.owner,
            }),
          );
        });
        stopIdentity = onSessionIdentityMutation((mutation) => {
          if (
            !("current" in mutation) ||
            !mutation.current.sessionKeys.includes(scope.sessionKey)
          ) {
            return;
          }
          const row = projection.capture(query);
          identityRows.push(structuredClone({ entry: row?.entry, storedEntry: row?.storedEntry }));
        });
        delivery.afterResult = () => {
          expect(readExactSessionEntryRow(database, scope.sessionKey)?.entry).toMatchObject({
            label: "worker committed",
            lifecycleRevision,
            owner: initialOwner,
          });
          const assertHeldGeneration = () => {
            // An identity-preserving held write leaves the generation readable.
            if (reset) {
              expect(generation.assertCurrent).toThrow(
                expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
              );
            } else {
              generation.assertCurrent();
            }
          };
          assertHeldGeneration();
          if (boundary === "reply") {
            assignNewOwner();
            // An owner-only publication cannot restore the old lifecycle before settlement.
            assertHeldGeneration();
            if (reset) {
              expect(sharing.readCurrent()).toBeUndefined();
            }
          }
        };
        await applySessionEntryExactReplacements({
          agentId: scope.agentId,
          storePath: scope.storePath,
          sessionKeys: [scope.sessionKey],
          update: ([row]) => ({
            result: undefined,
            replacements: [
              {
                sessionKey: scope.sessionKey,
                entry: { ...row!.entry, label: "worker committed", lifecycleRevision },
              },
            ],
          }),
        });
        expect(assignment).toEqual(newerOwner);
        expect(observed.length).toBeGreaterThan(0);
        if (reset) {
          expect(generation.assertCurrent).toThrow(
            expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_REVOKED" }),
          );
          expect(sharing.readCurrent()).toBeUndefined();
        } else {
          generation.assertCurrent();
          for (const publication of observed) {
            expect(publication).toEqual({
              entryOwner: newerOwner,
              storedOwner: newerOwner,
              sharingOwner: newerOwner,
            });
          }
          expect(sharing.readCurrent()?.entry?.owner).toEqual(newerOwner);
        }
        const committed = { label: "worker committed", lifecycleRevision, owner: newerOwner };
        if (reset) {
          expect(identityRows).toEqual([
            {
              entry: expect.objectContaining(committed),
              storedEntry: expect.objectContaining(committed),
            },
          ]);
        }
        expect(projection.capture(query)?.entry).toMatchObject(committed);
        expect(projection.capture(query)?.storedEntry).toMatchObject(committed);
        expect(readExactSessionEntryRow(database, scope.sessionKey)?.entry).toMatchObject(
          committed,
        );
      } finally {
        delivery.afterResult = undefined;
        stop();
        stopIdentity();
        projection.dispose();
        sharing.release();
        generation.release();
      }
    });
  },
);

it.each(["alias membership", "metadata only"] as const)(
  "invalidates unknown %s publication without a receipt",
  async (boundary) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const metadataOnly = boundary === "metadata only";
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const sessionKey = "agent:main:replacement-unknown-membership";
      const entry = {
        sessionId: "unknown-membership",
        lifecycleRevision: "unchanged-lifecycle",
        updatedAt: 1,
        visibility: "shared" as const,
      };
      writeSessionEntry(database, sessionKey, entry);
      const identity = readOpenClawAgentDatabaseIdentity(database).identity;
      if (typeof identity !== "string") {
        throw new Error("Expected durable fixture");
      }
      const sharing = retainPreparedSessionSharingFacts({
        databaseIdentity: `file:${identity}`,
        sessionKey,
        entry: projectSessionSharingEntry(entry),
        membership: new Set(["previous-member"]),
      });
      const publication = retainSessionEntryWorkerPublication({
        agentId: "main",
        storePath: database.path,
        databaseIdentity: identity,
      });
      const invalidations: Array<{ sessionKey: string; scope: string | undefined }> = [];
      const stop = sessionChanges.subscribeFacts((change) => {
        if ("sessionKey" in change && change.sessionKey === sessionKey && change.factsInvalidated) {
          invalidations.push({ sessionKey: change.sessionKey, scope: change.scope });
        }
      });
      try {
        publication.begin(
          [sessionKey],
          metadataOnly ? [] : [sessionKey],
          metadataOnly ? [sessionKey] : [],
        );
        if (metadataOnly) {
          expect(sharing.readCurrent()?.entry?.visibility).toBe("shared");
        } else {
          replaceSessionEntrySync(
            { agentId: "main", storePath: database.path, sessionKey },
            { ...entry, updatedAt: 2, visibility: "draft" },
          );
          expect(sharing.readCurrent()).toBeUndefined();
        }
        expect(invalidations).toEqual([]);
        publication.settle(undefined, true);
        expect(sharing.readCurrent()).toBeUndefined();
        expect(invalidations).toEqual([{ sessionKey, scope: undefined }]);
        expect(readExactSessionEntryRow(database, sessionKey)?.entry.visibility).toBe(
          metadataOnly ? "shared" : "draft",
        );
      } finally {
        publication.settle(undefined, false);
        stop();
        sharing.release();
      }
    });
  },
);

it.each([false, true])(
  "refreshes inline maintenance rows and preserves newer native metadata (%s)",
  async (newerNative) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { resetConfigRuntimeState, setRuntimeConfigSnapshot } = await import("../config.js");
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const activeKey = "agent:main:replacement-maintenance-active";
      const siblingKey = "agent:main:replacement-maintenance-sibling";
      const archivedKey = "agent:main:replacement-maintenance-old";
      writeSessionEntry(database, activeKey, { sessionId: "active", updatedAt: Date.now() });
      writeSessionEntry(database, siblingKey, { sessionId: "sibling", updatedAt: Date.now() });
      const original = {
        sessionId: "maintenance-old",
        updatedAt: 1,
        visibility: "shared" as const,
      };
      writeSessionEntry(database, archivedKey, original);
      const identity = readOpenClawAgentDatabaseIdentity(database).identity;
      if (typeof identity !== "string") {
        throw new Error("Expected durable fixture");
      }
      const sharing = retainPreparedSessionSharingFacts({
        databaseIdentity: `file:${identity}`,
        sessionKey: archivedKey,
        entry: projectSessionSharingEntry(original),
        membership: new Set(["member"]),
      });
      const config = {
        session: {
          maintenance: { mode: "enforce" as const, maxEntries: 1, pruneAfter: "1000000d" },
        },
      };
      setRuntimeConfigSnapshot(config, config);
      const projection = await createSessionRowProjection({ cfg: config, modelCatalog: [] });
      await projection.ensureMaterialized();
      const replacementKeys = [activeKey, siblingKey];
      const factKeys = new Set<string>();
      const observerFacts: string[][] = [];
      const stopFacts = sessionChanges.subscribeFacts((change) => {
        if ("sessionKey" in change && replacementKeys.includes(change.sessionKey)) {
          factKeys.add(change.sessionKey);
        }
      });
      const stopObserver = sessionChanges.subscribe((change) => {
        if ("sessionKey" in change && replacementKeys.includes(change.sessionKey)) {
          observerFacts.push([...factKeys].toSorted());
        }
      });
      let whileWaiting: ReturnType<typeof sharing.readCurrent>;
      delivery.afterResult = () => {
        expect(readExactSessionEntryRow(database, archivedKey)?.entry.archivedAt).toEqual(
          expect.any(Number),
        );
        whileWaiting = sharing.readCurrent();
        if (newerNative) {
          replaceSessionEntrySync(
            { agentId: "main", storePath: database.path, sessionKey: archivedKey },
            {
              ...original,
              updatedAt: Date.now(),
              visibility: "draft",
              label: "newer maintenance row",
            },
          );
        }
      };
      try {
        await applySessionEntryExactReplacements({
          storePath: database.path,
          activeSessionKey: activeKey,
          sessionKeys: replacementKeys,
          skipMaintenance: false,
          update: (rows) => ({
            result: undefined,
            replacements: rows.map(({ sessionKey, entry }) => ({
              sessionKey,
              entry: { ...entry, label: "updated" },
            })),
          }),
        });
        expect(observerFacts).toEqual([replacementKeys.toSorted(), replacementKeys.toSorted()]);
        expect(whileWaiting).toBeUndefined();
        if (newerNative) {
          expect(sharing.readCurrent()).toMatchObject({
            entry: { visibility: "draft" },
            membership: new Set(["member"]),
          });
        } else {
          expect(sharing.readCurrent()).toBeUndefined();
        }
        await projection.ensureMaterialized();
        const current = readExactSessionEntryRow(database, archivedKey)?.entry;
        expect(current).toMatchObject(
          newerNative ? { label: "newer maintenance row" } : { archivedAt: expect.any(Number) },
        );
        for (const key of [...replacementKeys, archivedKey]) {
          const committed = readExactSessionEntryRow(database, key)?.entry;
          expect(committed).toBeDefined();
          const resident = projection.capture({ agentId: "main", key })?.entry;
          expect(resident).toBeDefined();
          expect(resident?.sessionId).toBe(committed?.sessionId);
          expect(resident?.archivedAt).toBe(committed?.archivedAt);
          expect(resident?.label).toBe(committed?.label);
        }
      } finally {
        delivery.afterResult = undefined;
        projection.dispose();
        resetConfigRuntimeState();
        stopObserver();
        stopFacts();
        sharing.release();
      }
    });
  },
);
