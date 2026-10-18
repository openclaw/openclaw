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
import type { SessionEntry } from "./types.js";

const { getReplacementPublicationDelivery } =
  await import("./session-accessor.sqlite-replacement-publication.test-support.js");
const delivery = getReplacementPublicationDelivery();
const cleanupWarning = "Session mutation completed before executor cleanup failed";

function setup(name: string) {
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const scope = { agentId: "main", sessionKey: `agent:main:${name}`, storePath: database.path };
  const write = (entry: SessionEntry) => replaceSessionEntrySync(scope, entry);
  const read = () => readExactSessionEntryRow(database, scope.sessionKey)?.entry;
  const replace = (entry: Partial<SessionEntry>, onLifecycleCommitted?: () => void) =>
    applySessionEntryExactReplacements({
      ...scope,
      ...(onLifecycleCommitted ? { onLifecycleCommitted } : {}),
      sessionKeys: [scope.sessionKey],
      update: ([row]) => ({
        result: undefined,
        replacements: [{ sessionKey: scope.sessionKey, entry: { ...row!.entry, ...entry } }],
      }),
    });
  return { database, scope, write, read, replace };
}

function makeEntry<T extends Partial<SessionEntry>>(sessionId: string, overrides: T) {
  return { sessionId, updatedAt: 1, ...overrides };
}

function retainSharing(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  sessionKey: string,
  entry: SessionEntry,
  member = "member",
) {
  const identity = readOpenClawAgentDatabaseIdentity(database).identity;
  if (typeof identity !== "string") {
    throw new Error("Expected durable fixture");
  }
  const sharing = retainPreparedSessionSharingFacts({
    databaseIdentity: `file:${identity}`,
    sessionKey,
    entry: projectSessionSharingEntry(entry),
    membership: new Set([member]),
  });
  return { identity, sharing };
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("publishes successive replacement identities without changing folded siblings", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { database, scope, write, read } = setup("matrix:channel:!Room:example.org");
    const siblingKey = scope.sessionKey.toLowerCase();
    write(makeEntry("original", { lifecycleRevision: "first" }));
    replaceSessionEntrySync({ ...scope, sessionKey: siblingKey }, makeEntry("sibling", {}));
    const mutations: SessionIdentityMutation[] = [];
    const observed: Array<string | undefined> = [];
    const stop = onSessionIdentityMutation((mutation) => {
      mutations.push(mutation);
      observed.push(read()?.label);
    });
    try {
      write(makeEntry("original", { lifecycleRevision: "second", updatedAt: 2, label: "reset" }));
      write(
        makeEntry("replacement", { lifecycleRevision: "third", updatedAt: 3, label: "replaced" }),
      );
      expect(mutations).toMatchObject([
        { kind: "reset", previous: { sessionKeys: [scope.sessionKey] } },
        { kind: "replace", previous: { sessionKeys: [scope.sessionKey] } },
      ]);
      expect(observed).toEqual(["reset", "replaced"]);
      expect(readExactSessionEntryRow(database, siblingKey)?.entry.sessionId).toBe("sibling");
    } finally {
      stop();
    }
  });
});

it("settles publication before a successor writer and preserves metadata after worker retirement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { database, scope, write, replace } = setup("successor-worker");
    write(makeEntry("successor-worker", { label: "initial" }));
    const projection = await createSessionRowProjection({ cfg: {} });
    let successor: Promise<void> | undefined;
    delivery.afterRelease = async () => {
      successor = replace({ label: "successor" });
    };
    try {
      await replace({ label: "retired" });
      expect(successor).toBeDefined();
      await successor;
      const query = { agentId: scope.agentId, key: scope.sessionKey, storePath: scope.storePath };
      expect(projection.capture(query)?.storedEntry?.label).toBe("successor");
      expect(projection.sharingTarget(query)?.entry.sessionId).toBe("successor-worker");
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
      await replace({ label: "new generation" });
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
          if (values[0] === cleanupWarning) {
            cleanupWarnings.push(values);
          }
          return warn(...values);
        });
        return logger;
      });
      const { database, scope, replace, read } = setup("replacement-settlement");
      const options = { agentId: "main", path: database.path };
      const { sessionKey } = scope;
      const members = new Set(["member"]);
      const metadataOnly = boundary.startsWith("metadata");
      const workerVisibility = metadataOnly ? "shared" : "read-only";
      const workerCategory = metadataOnly ? "before" : "worker";
      const original = makeEntry("settlement", {
        lifecycleRevision: "initial-lifecycle",
        visibility: "shared" as const,
        label: "before",
        category: "before",
      });
      writeSessionEntry(database, sessionKey, original);
      addSessionMember(scope, { identityId: "member", addedBy: "owner", addedAt: 1 });
      const { identity, sharing } = retainSharing(database, sessionKey, original);
      const generation = await prepareSessionDeliveryGeneration({
        ...scope,
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
      readSessionEntryCache(database, { cache: true });
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
        const operation = replace(
          { visibility: workerVisibility, label: "worker", category: workerCategory },
          boundary === "callback failure"
            ? () => {
                throw failure;
              }
            : undefined,
        );
        if (boundary === "lost result" || boundary === "callback failure") {
          await expect(operation).rejects.toBe(failure);
        } else {
          await operation;
        }
        if (boundary === "callback failure") {
          expect(callbackPublication).toMatchObject({
            entry: { sessionId: original.sessionId, label: "worker", category: "worker" },
            source: { identity, revision: expect.any(Number) },
          });
        }
        expect(executions).toBe(1);
        expect(cleanupWarnings).toEqual(
          boundary === "release failure" ? [[cleanupWarning, { errors: [failure.message] }]] : [],
        );
        if (metadataOnly) {
          expect(whileWaiting).toMatchObject({
            entry: { visibility: "shared" },
            membership: members,
          });
        } else {
          expect(whileWaiting).toBeUndefined();
        }
        expect(sharing.readCurrent()).toMatchObject({
          entry: { visibility: workerVisibility },
          membership: members,
        });
        generation.assertCurrent();
        expect(mutations).toEqual([]);
        expect(read()?.label).toBe("worker");
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
      const { database, scope, read } = setup("replacement-unknown-membership");
      const { sessionKey } = scope;
      const original = makeEntry("unknown-membership", {
        lifecycleRevision: "unchanged-lifecycle",
        visibility: "shared" as const,
      });
      writeSessionEntry(database, sessionKey, original);
      const { identity, sharing } = retainSharing(
        database,
        sessionKey,
        original,
        "previous-member",
      );
      const publication = retainSessionEntryWorkerPublication({
        ...scope,
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
          replaceSessionEntrySync(scope, { ...original, updatedAt: 2, visibility: "draft" });
          expect(sharing.readCurrent()).toBeUndefined();
        }
        expect(invalidations).toEqual([]);
        publication.settle(undefined, true);
        expect(sharing.readCurrent()).toBeUndefined();
        expect(invalidations).toEqual([{ sessionKey, scope: undefined }]);
        expect(read()?.visibility).toBe(metadataOnly ? "shared" : "draft");
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
    const original = makeEntry("maintenance-old", { visibility: "shared" });
    writeSessionEntry(database, archivedKey, original);
    const { sharing } = retainSharing(database, archivedKey, original);
    const config = {
      session: { maintenance: { mode: "enforce" as const, maxEntries: 1, pruneAfter: "1000000d" } },
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
      const current = readExactSessionEntryRow(database, archivedKey)?.entry;
      expect(current).toMatchObject({ archivedAt: expect.any(Number) });
      if (!current) {
        throw new Error("Expected committed archived entry");
      }
      expect(sharing.readCurrent()).toEqual({
        entry: projectSessionSharingEntry(current),
        membership: new Set(),
      });
      await projection.ensureMaterialized();
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
