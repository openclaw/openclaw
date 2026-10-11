import "./session-accessor.sqlite-replacement-publication.test-support.js";
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
  readSessionEntryCache,
  retainPreparedSessionSharingFacts,
  retainSessionEntryWorkerPublication,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { applySessionEntryExactReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import { prepareSessionDeliveryGeneration } from "./session-delivery-generation.js";
import { addSessionMember } from "./session-sharing-store.native.js";

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

it.each(["metadata only", "lost result", "callback failure", "release failure"] as const)(
  "preserves replacement publication through %s",
  async (boundary) => {
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
      const workerCategory = metadataOnly ? "before" : "worker";
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
      const writer = database;
      readSessionEntryCache(writer, { cache: true });
      const observed: Array<string | undefined> = [];
      const mutations: SessionIdentityMutation[] = [];
      const stopIdentity = onSessionIdentityMutation((mutation) => mutations.push(mutation));
      const stop = sessionChanges.subscribe((change) => {
        if ("sessionKey" in change && change.sessionKey === sessionKey) {
          observed.push(sharing.readCurrent()?.entry?.visibility);
        }
      });
      let executions = 0;
      let whileWaiting: ReturnType<typeof sharing.readCurrent>;
      const failure = new Error(`synthetic ${boundary}`);
      delivery.afterResult = () => {
        executions++;
        whileWaiting = sharing.readCurrent();
        generation.assertCurrent();
        if (boundary === "lost result") {
          throw failure;
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
            return {
              result: undefined,
              replacements: [
                {
                  sessionKey,
                  entry: {
                    ...row!.entry,
                    visibility: workerVisibility,
                    label: "worker",
                    category: workerCategory,
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
        } else {
          expect(whileWaiting).toBeUndefined();
        }
        expect(sharing.readCurrent()).toMatchObject({
          entry: { visibility: workerVisibility },
          membership: new Set(["member"]),
        });
        generation.assertCurrent();
        expect(mutations).toEqual([]);
        expect(readExactSessionEntryRow(writer, sessionKey)?.entry.label).toBe("worker");
        expect(projection.needsPreparation).toBe(false);
        expect(projection.membership(database.path, sessionKey)).toEqual(["member"]);
        await projection.prepare();
        expect([...projection.groupTargets()]).toEqual([
          [workerCategory, [{ sessionKey, agentId: "main" }]],
        ]);
        expect(observed).toEqual([workerVisibility]);
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

it("refreshes inline maintenance rows", async () => {
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
      expect(sharing.readCurrent()).toBeUndefined();
      await projection.ensureMaterialized();
      const current = readExactSessionEntryRow(database, archivedKey)?.entry;
      expect(current).toMatchObject({ archivedAt: expect.any(Number) });
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
});
