import { afterEach, expect, it, vi } from "vitest";
import { createSessionMembershipProjection } from "../../gateway/session-membership-projection.js";
import { createSessionRowProjection } from "../../gateway/session-row-projection.js";
import {
  emitSessionIdentityMutation,
  onSessionIdentityMutation,
  type SessionIdentityMutation,
} from "../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  projectSessionSharingEntry,
  readPreparedSessionEntryChange,
  readPreparedSessionSharingChange,
} from "./session-accessor.sqlite-entry-cache-publication.js";
import {
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
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import {
  applySessionEntryCanonicalReplacements,
  applySessionEntryExactReplacements,
} from "./session-accessor.sqlite-replacement-projection.js";
import { prepareSessionDeliveryGeneration } from "./session-delivery-generation.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import { addSessionMember } from "./session-sharing-store.native.js";

// The canonical executor still owns real SQL, admission, and settlement; only reply delivery changes.
const delivery = vi.hoisted(() => ({
  afterResult: undefined as (() => void | Promise<void>) | undefined,
  releaseFailure: undefined as Error | undefined,
  afterRelease: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("../../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-agent-execution.js")>();
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>
    ): ReturnType<typeof actual.captureOpenClawAgentDatabaseExecution> => {
      const owned = actual.captureOpenClawAgentDatabaseExecution(...args);
      return {
        ...owned,
        runExisting: (source, operation, options) =>
          owned.runExisting(
            source,
            (scope) =>
              operation({
                execute: async (command, commandOptions) => {
                  const result = await scope.execute(command, commandOptions);
                  if (command.type === "session.entries.replace") {
                    await delivery.afterResult?.();
                  }
                  return result;
                },
              }),
            options,
          ),
        release: async () => {
          await owned.release();
          const afterRelease = delivery.afterRelease;
          delivery.afterRelease = undefined;
          await afterRelease?.();
          if (delivery.releaseFailure) {
            throw delivery.releaseFailure;
          }
        },
      };
    },
  };
});

afterEach(() => {
  delivery.afterResult = undefined;
  delivery.releaseFailure = undefined;
  delivery.afterRelease = undefined;
});

it("fences a delivery generation during native writes and restores it only on rollback", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const options = { agentId: "main", path: database.path };
    const sessionKey = "agent:main:native-generation-publication";
    const original = {
      sessionId: "native-generation",
      lifecycleRevision: "original-generation",
      updatedAt: 1,
    };
    writeSessionEntry(database, sessionKey, original);
    const originalRow = readExactSessionEntryRow(database, sessionKey);
    expect(originalRow).toBeDefined();
    const generation = await prepareSessionDeliveryGeneration({
      agentId: options.agentId,
      storePath: database.path,
      sessionKey,
      sessionId: original.sessionId,
      lifecycleRevision: original.lifecycleRevision,
    });
    const rollback = new Error("roll back staged generation");
    try {
      generation.assertCurrent();
      expect(() =>
        runOpenClawAgentWriteTransaction((writer) => {
          writeSessionEntry(writer, sessionKey, {
            ...original,
            lifecycleRevision: "uncommitted-generation",
            updatedAt: 2,
          });
          expect(writer.db.isTransaction).toBe(true);
          expect(readExactSessionEntryRow(writer, sessionKey)?.entry.lifecycleRevision).toBe(
            "uncommitted-generation",
          );
          expect(generation.assertCurrent).toThrow(
            expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
          );
          throw rollback;
        }, options),
      ).toThrow(rollback);
      expect(database.db.isTransaction).toBe(false);
      expect(readExactSessionEntryRow(database, sessionKey)).toEqual(originalRow);
      generation.assertCurrent();

      runOpenClawAgentWriteTransaction((writer) => {
        writeSessionEntry(writer, sessionKey, {
          ...original,
          lifecycleRevision: "committed-replacement",
          updatedAt: 3,
        });
      }, options);
      expect(readExactSessionEntryRow(database, sessionKey)?.entry.lifecycleRevision).toBe(
        "committed-replacement",
      );
      // Restoring the old values cannot restore a generation already replaced at COMMIT.
      runOpenClawAgentWriteTransaction((writer) => {
        writeSessionEntry(writer, sessionKey, original);
      }, options);
      expect(generation.assertCurrent).toThrow(
        expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_REVOKED" }),
      );
    } finally {
      generation.release();
    }
  });
});

it("classifies prepared lifecycle publications without classifying copied raw events", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const key = "agent:main:identity-record";
    const entry = { sessionId: "identity-record", lifecycleRevision: "first", updatedAt: 1 };
    const observations: Array<{
      mutation: SessionIdentityMutation;
      sharingChange: ReturnType<typeof readPreparedSessionSharingChange>;
      prepared: ReturnType<typeof readPreparedSessionEntryChange>;
    }> = [];
    const stop = onSessionIdentityMutation((mutation) => {
      const selectedKey = mutation.kind === "delete" ? key : mutation.current.sessionKeys[0];
      observations.push({
        mutation,
        sharingChange: readPreparedSessionSharingChange(mutation),
        prepared:
          selectedKey === undefined
            ? undefined
            : readPreparedSessionEntryChange(mutation, selectedKey),
      });
    });
    const previous = new Map([[key, entry]]);
    const empty = new Map<string, typeof entry>();
    const transitions = [
      { previous: empty, current: previous },
      { previous, current: new Map([[`${key}-moved`, entry]]) },
      { previous, current: new Map([[key, { ...entry, sessionId: "replacement" }]]) },
      { previous, current: new Map([[key, { ...entry, lifecycleRevision: "next" }]]) },
      { previous, current: empty },
    ];
    try {
      for (const transition of transitions) {
        publishCommittedSessionIdentity("main", transition.previous, transition.current, {
          source: readOpenClawAgentDatabaseIdentity(database),
          entries: transition.current,
        });
      }
      expect(observations.map(({ mutation }) => mutation.kind)).toEqual([
        "create",
        "move",
        "replace",
        "reset",
        "delete",
      ]);
      const prepared = observations.splice(0);
      for (const observation of prepared) {
        expect(observation.sharingChange).toBe("changed");
        expect(observation.prepared).toBeDefined();
        emitSessionIdentityMutation({ ...observation.mutation });
      }
      expect(observations).toHaveLength(5);
      for (const observation of observations) {
        expect(observation.sharingChange).toBeUndefined();
        expect(observation.prepared).toBeUndefined();
      }
    } finally {
      stop();
    }
  });
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
      expect(generation.assertCurrent).toThrow(
        expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
      );
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
      if (
        boundary === "lost result" ||
        boundary === "callback failure" ||
        boundary === "release failure"
      ) {
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
      if (metadataOnly) {
        expect(whileWaiting).toMatchObject({
          entry: { visibility: "shared" },
          membership: new Set(["member"]),
        });
      } else if (boundary !== "late writer") {
        expect(whileWaiting).toBeUndefined();
      }
      if (reset) {
        expect(sharing.readCurrent()).toBeUndefined();
      } else {
        expect(sharing.readCurrent()).toMatchObject({
          entry: { visibility: newerNative ? "draft" : workerVisibility },
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
      await projection.prepare();
      expect([...projection.groupTargets()]).toEqual([
        [newerNative ? "newer" : "worker", [{ sessionKey, agentId: "main" }]],
      ]);
      expect(observed).toEqual([reset ? undefined : newerNative ? "draft" : workerVisibility]);
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
      const invalidations: string[] = [];
      const stop = sessionChanges.subscribeFacts((change) => {
        if ("sessionKey" in change && change.sessionKey === sessionKey && change.factsInvalidated) {
          invalidations.push(change.sessionKey);
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
        expect(invalidations).toEqual([sessionKey]);
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
  "invalidates rehomed membership while preserving newer native metadata (%s)",
  async (newerNative) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const sessionKey = "agent:main:replacement-member-target";
      const aliasKey = "agent:main:replacement-member-alias";
      const entry = {
        sessionId: "member-target",
        lifecycleRevision: "unchanged-lifecycle",
        updatedAt: 2,
        visibility: "shared" as const,
      };
      writeSessionEntry(database, sessionKey, entry);
      writeSessionEntry(database, aliasKey, { sessionId: "member-alias", updatedAt: 1 });
      for (const [key, identityId] of [
        [sessionKey, "target-member"],
        [aliasKey, "alias-member"],
      ] as const) {
        addSessionMember(
          { agentId: "main", storePath: database.path, sessionKey: key },
          { identityId, addedBy: "owner", addedAt: 1 },
        );
      }
      const identity = readOpenClawAgentDatabaseIdentity(database).identity;
      if (typeof identity !== "string") {
        throw new Error("Expected durable fixture");
      }
      const sharing = retainPreparedSessionSharingFacts({
        databaseIdentity: `file:${identity}`,
        sessionKey,
        entry: projectSessionSharingEntry(entry),
        membership: new Set(
          listSessionMembersInDatabase(database, sessionKey).map((member) => member.identityId),
        ),
      });
      expect(sharing.readCurrent()?.membership).toEqual(new Set(["target-member"]));
      delivery.afterResult = () => {
        if (newerNative) {
          replaceSessionEntrySync(
            { agentId: "main", storePath: database.path, sessionKey },
            { ...entry, updatedAt: 3, visibility: "draft" },
          );
          expect(sharing.readCurrent()).toBeUndefined();
        }
      };
      try {
        await applySessionEntryCanonicalReplacements({
          storePath: database.path,
          sessionKeys: [sessionKey, aliasKey],
          update: () => ({
            result: undefined,
            replacements: [{ sessionKey, previousSessionKeys: [aliasKey], entry }],
          }),
        });
        expect(readExactSessionEntryRow(database, aliasKey)).toBeUndefined();
        expect(readExactSessionEntryRow(database, sessionKey)?.entry.visibility).toBe(
          newerNative ? "draft" : "shared",
        );
        expect(
          listSessionMembersInDatabase(database, sessionKey).map((member) => member.identityId),
        ).toEqual(["alias-member", "target-member"]);
        expect(sharing.readCurrent()).toBeUndefined();
      } finally {
        delivery.afterResult = undefined;
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

it.each([false, true])(
  "retires a removed alias before observers without replacing a newer alias (%s)",
  async (recreated) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const key = "agent:main:alias-survivor";
      const alias = "agent:main:alias-retired";
      const entry = { sessionId: "alias-generation", updatedAt: 1 };
      for (const sessionKey of [key, alias]) {
        replaceSessionEntrySync({ agentId: "main", storePath: database.path, sessionKey }, entry);
      }
      const projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
      await projection.ensureMaterialized();
      const query = { agentId: "main", key: alias, storePath: database.path };
      expect(projection.capture(query)).toBeDefined();
      const seen: Array<{
        native: boolean;
        sessionId: string | undefined;
        sharingId: string | undefined;
      }> = [];
      let nativeRecreation = false;
      delivery.afterResult = () => {
        if (recreated) {
          nativeRecreation = true;
          try {
            replaceSessionEntrySync(
              { agentId: "main", storePath: database.path, sessionKey: alias },
              { ...entry, sessionId: "newer-alias-generation", updatedAt: 2 },
            );
          } finally {
            nativeRecreation = false;
          }
        }
      };
      const stop = sessionChanges.subscribe((change) => {
        if ("sessionKey" in change && change.sessionKey === alias) {
          seen.push({
            native: nativeRecreation,
            sessionId: projection.capture(query)?.storedEntry?.sessionId,
            sharingId: projection.sharingTarget(query)?.entry.sessionId,
          });
        }
      });
      try {
        await applySessionEntryCanonicalReplacements({
          storePath: database.path,
          sessionKeys: [key, alias],
          update: () => ({
            result: undefined,
            replacements: [{ sessionKey: key, previousSessionKeys: [alias], entry }],
          }),
        });
        if (recreated) {
          expect(seen).toHaveLength(1);
          expect(seen[0]).toMatchObject({ native: true, sharingId: undefined });
        } else {
          expect(seen).toEqual([{ native: false, sessionId: undefined, sharingId: undefined }]);
        }
        await projection.ensureMaterialized();
        const expected = recreated ? "newer-alias-generation" : undefined;
        expect(projection.capture(query)?.storedEntry?.sessionId).toBe(expected);
        expect(readExactSessionEntryRow(database, alias)?.entry.sessionId).toBe(expected);
      } finally {
        stop();
        projection.dispose();
      }
    });
  },
);
