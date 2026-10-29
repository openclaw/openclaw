import "./session-accessor.sqlite-replacement-publication.test-support.js";
import { afterEach, expect, it, vi } from "vitest";
import { createSessionMembershipProjection } from "../../gateway/session-membership-projection.js";
import { createSessionRowProjection } from "../../gateway/session-row-projection.js";
import { isSqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
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
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { retainConversationBindingFacts } from "./conversation-binding-facts.js";
import { buildConversationIdentity } from "./conversation-identity.js";
import { captureConversationBindingFacts } from "./conversation-registry.js";
import { conversationPublication } from "./session-accessor.sqlite-conversation-publication.js";
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
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import { prepareSessionDeliveryGeneration } from "./session-delivery-generation.js";
import { captureSessionEntryCurrentCheckAsyncInternal } from "./session-entry-current-check.js";
import { sealSessionEntryPublicationSource } from "./session-entry-publication-source.js";
import { withSessionStoreReaderInWorker } from "./session-entry-read-runtime.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
import { addSessionMember } from "./session-sharing-store.native.js";
import type { SessionEntry } from "./types.js";

const { getReplacementPublicationDelivery } =
  await import("./session-accessor.sqlite-replacement-publication.test-support.js");
const delivery = getReplacementPublicationDelivery();
const cleanupWarning = "Session mutation completed before executor cleanup failed";

function withoutSql(assertions: () => void) {
  const sql = observeMainThreadSql();
  try {
    assertions();
    sql.expectIdle();
  } finally {
    sql.restore();
  }
}

function conversation(peerId: string) {
  const address = { channel: "slack", accountId: "default", kind: "channel" as const, peerId };
  return {
    address,
    routed: (sessionId: string, updatedAt: number): SessionEntry => ({
      sessionId,
      updatedAt,
      chatType: "channel",
      delivery: normalizeSessionDeliveryState({
        context: { channel: address.channel, accountId: address.accountId, to: peerId },
      }),
    }),
  };
}

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

it("publishes full replacement snapshots without returning unused historical rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { scope, write, read } = setup("replacement-reply-payload");
    const skillsSnapshot = { prompt: "synthetic saved instructions ".repeat(1024), skills: [] };
    write(makeEntry("replacement-reply-payload", { label: "before", skillsSnapshot }));
    const replies: unknown[] = [];
    const publications: Array<ReturnType<typeof readPreparedSessionEntryChange>> = [];
    const stop = sessionChanges.subscribeFacts((change) => {
      if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
        publications.push(readPreparedSessionEntryChange(change, scope.sessionKey));
      }
    });
    delivery.afterResult = (result) => {
      replies.push(result);
    };
    try {
      const result = await applySessionEntryExactReplacements({
        ...scope,
        sessionKeys: [scope.sessionKey],
        update: ([row]) => ({
          result: "replacement result",
          replacements: [
            { sessionKey: scope.sessionKey, entry: { ...row!.entry, label: "after" } },
          ],
        }),
      });
      expect(result).toBe("replacement result");
      expect(read()).toMatchObject({ label: "after", skillsSnapshot });
      expect(publications).toEqual([
        expect.objectContaining({
          entry: expect.objectContaining({ label: "after" }),
          fullEntry: expect.objectContaining({ label: "after", skillsSnapshot }),
        }),
      ]);
      expect(replies).toEqual([
        { maintenancePlans: expect.any(Array), publication: expect.any(Object) },
      ]);
    } finally {
      delivery.afterResult = undefined;
      stop();
    }
  });
});

it.each(["full entry", "write token", "receipt"])(
  "invalidates an unchanged publication missing its %s",
  async (missing) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { database, scope, write, read } = setup("incomplete-retention");
      write(makeEntry("incomplete-retention", { label: "initial" }));
      const entry = read()!;
      const receipt = runOpenClawAgentWriteTransaction(
        (current) => {
          const postimages: SessionEntryWritePostimages = new Map();
          const written = writeSessionEntry(current, scope.sessionKey, entry, { postimages });
          return prepareSessionEntryReplacementPublication(
            {
              previous: new Map([[scope.sessionKey, entry]]),
              current: new Map([[scope.sessionKey, written]]),
              pendingArchiveRecovery: false,
              maintenancePlans: [],
              membershipInvalidatedKeys: [],
            },
            current,
            { captureFullFacts: missing !== "full entry", postimages },
          );
        },
        { agentId: scope.agentId, path: database.path },
      );
      expect(receipt.changedKeys).toEqual([]);
      const source = receipt.source;
      if (!source || typeof source.identity !== "string") {
        throw new Error("Expected a durable publication source");
      }
      sealSessionEntryPublicationSource(source);
      expect(source.writeToken).toBeDefined();
      if (missing === "write token") {
        delete source.writeToken;
      }
      const publication = retainSessionEntryWorkerPublication({
        ...scope,
        databaseIdentity: source.identity,
      });
      const changes: string[] = [];
      const stop = sessionChanges.subscribe((change) => {
        if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
          changes.push(change.sessionKey);
        }
      });
      try {
        publication.begin(
          [],
          [],
          receipt.sharingUnchangedKeys,
          receipt.generationUnchangedKeys,
          undefined,
          receipt.current,
          undefined,
          receipt.fullEntries,
        );
        publication.settle(missing === "receipt" ? undefined : receipt, false);
        expect(changes).toEqual([scope.sessionKey]);
      } finally {
        publication.settle(undefined, false);
        stop();
      }
    });
  },
);

it.each(["changed", "initial"])("publishes a repeated replacement ending at %s", async (label) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { scope, write, read } = setup("repeated-replacement");
    const initial = makeEntry("repeated-replacement", { label: "initial" });
    write(initial);
    const changed = { ...initial, label: "changed" };
    const changes: string[] = [];
    const stop = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
        changes.push(change.scope ?? "unspecified");
      }
    });
    try {
      await applySessionEntryExactReplacements({
        ...scope,
        sessionKeys: [scope.sessionKey],
        update: () => ({
          result: undefined,
          replacements: [
            { sessionKey: scope.sessionKey, entry: changed },
            { sessionKey: scope.sessionKey, entry: { ...initial, label } },
            { sessionKey: scope.sessionKey, entry: { ...initial, label } },
          ],
        }),
      });
      expect(read()?.label).toBe(label);
      expect(changes).toEqual(["session-entry"]);
    } finally {
      stop();
    }
  });
});

it("does not restore retained-only sharing facts after a successor write", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { database, scope, write, read, replace } = setup("retained-successor");
    const initial = makeEntry("retained-successor", { visibility: "shared" as const });
    write(initial);
    const { sharing } = retainSharing(database, scope.sessionKey, initial);
    const observed: Array<string | undefined> = [];
    const stop = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
        observed.push(sharing.readCurrent()?.entry?.visibility);
      }
    });
    delivery.afterResult = () => {
      write({ ...initial, updatedAt: 2, visibility: "draft" });
    };
    try {
      await replace({});
      expect(read()?.visibility).toBe("draft");
      expect(sharing.readCurrent()?.entry?.visibility).toBe("draft");
      expect(observed).toEqual(["draft", "draft"]);
    } finally {
      delivery.afterResult = undefined;
      stop();
      sharing.release();
    }
  });
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

it.each(["delivered", "lost", "overtaken"] as const)(
  "settles conversation authority before observers when replacement delivery is %s",
  async (boundary) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { scope, write, replace } = setup("conversation-competitor");
      const selected = { ...scope, sessionKey: "agent:main:conversation-selected" };
      const { address, routed } = conversation("channel:C_SYNTHETIC");
      replaceSessionEntrySync(selected, routed("selected", 10));
      write(makeEntry("competitor", {}));
      const check = await captureSessionEntryCurrentCheckAsyncInternal({
        ...selected,
        matchGeneration: false,
        alternatives: [{ conversations: [{ ...address, sessionKey: selected.sessionKey }] }],
      });
      const assertRefusedWithoutSql = () =>
        withoutSql(() => {
          expect(() => check.source()).toThrow("selected session changed");
        });
      let observed = 0;
      let delivered = 0;
      const stop = sessionChanges.subscribe((change) => {
        if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
          assertRefusedWithoutSql();
          observed++;
        }
      });
      const failure = new Error("Synthetic lost conversation result");
      delivery.afterResult = () => {
        delivered++;
        assertRefusedWithoutSql();
        if (boundary === "overtaken") {
          replaceSessionEntrySync(selected, routed("selected", 30));
        }
        if (boundary === "lost") {
          throw failure;
        }
      };
      try {
        const operation = replace(routed("competitor", 20));
        if (boundary === "lost") {
          await expect(operation).rejects.toBe(failure);
        } else {
          await operation;
        }
        expect(delivered).toBe(1);
        expect(observed).toBe(1);
        assertRefusedWithoutSql();
        if (boundary === "overtaken") {
          const fresh = await captureSessionEntryCurrentCheckAsyncInternal({
            ...selected,
            matchGeneration: false,
            alternatives: [{ conversations: [{ ...address, sessionKey: selected.sessionKey }] }],
          });
          try {
            withoutSql(() => expect(() => fresh.source()).not.toThrow());
          } finally {
            fresh.release();
          }
        }
      } finally {
        delivery.afterResult = undefined;
        stop();
        check.release();
      }
    });
  },
);

it.each(["commit", "rollback", "unknown"] as const)(
  "settles a binding subscriber acquired during pending publication after %s",
  async (boundary) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { scope, write, replace } = setup("pending-conversation-competitor");
      const selected = { ...scope, sessionKey: "agent:main:pending-conversation-selected" };
      const { address, routed } = conversation("channel:C_PENDING_SYNTHETIC");
      const { conversationRef } = buildConversationIdentity({
        ...address,
        deliveryTarget: address.peerId,
      })!;
      replaceSessionEntrySync(selected, routed("pending-selected", 10));
      write(makeEntry("pending-competitor", {}));
      const snapshot = await withSessionStoreReaderInWorker(
        scope,
        ({ reader, database }) =>
          reader.readConversationBindings({
            conversationRefs: [conversationRef],
            env: database.env,
          }),
        { dataOnly: true },
      );
      let acquired: ReturnType<typeof retainConversationBindingFacts> | undefined;
      let acquisition: unknown;
      let acquisitionSql = -1;
      let scheduled = false;
      const stop = conversationPublication.subscribeFacts((change) => {
        if (
          "kind" in change &&
          change.kind === "pending" &&
          change.databaseIdentity === snapshot.source?.identity &&
          !scheduled
        ) {
          scheduled = true;
          // Subscribe after this notification: listeners added during it see the live Set.
          queueMicrotask(() => {
            acquired = retainConversationBindingFacts([conversationRef], scope.storePath);
            acquired.acknowledge(snapshot);
            const sql = observeMainThreadSql();
            try {
              acquisition = acquired.currentSessionKey(conversationRef);
            } catch (error) {
              acquisition = error;
            } finally {
              acquisitionSql = sql.count();
              sql.restore();
            }
          });
        }
      });
      const failure = new Error(`Synthetic conversation ${boundary}`);
      let nativeAdmission: admission.SqliteWorkerOperationAdmission | undefined;
      const createAdmission = admission.createSqliteWorkerOperationAdmission;
      const admissionProbe = vi
        .spyOn(admission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit, attachment) => {
          const owned = createAdmission((request, grant) => {
            if (request.stage === "commit") {
              nativeAdmission = owned;
            }
            admit(
              request,
              request.stage === "commit" && boundary === "rollback"
                ? () => {
                    // The real owner has begun publication; refusal makes its native writer roll back.
                    throw failure;
                  }
                : grant,
            );
          }, attachment);
          return owned;
        });
      let delivered = 0;
      delivery.afterResult = () => {
        delivered++;
        expect(acquired).toBeDefined();
        withoutSql(() => {
          // Real COMMIT has finished; the publication owner has not installed its receipt yet.
          expect(() => acquired!.currentSessionKey(conversationRef)).toThrow(
            "Conversation binding publication is unavailable",
          );
        });
        if (boundary === "unknown") {
          const owned = nativeAdmission!;
          expect(owned.committed).toBeDefined();
          // Withhold real receipt/result delivery; do not invent a committed postimage.
          vi.spyOn(owned, "committed", "get").mockReturnValue(undefined);
          vi.spyOn(owned, "settlement", "get").mockReturnValue({ kind: "completed" });
          throw failure;
        }
      };
      try {
        const outcome = await replace(routed("pending-competitor", 20)).then(
          () => ({ kind: "returned" as const }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        );
        expect(acquisition).toBeInstanceOf(Error);
        expect(acquisitionSql).toBe(0);
        expect(delivered).toBe(boundary === "rollback" ? 0 : 1);
        expect(outcome.kind).toBe(boundary === "commit" ? "returned" : "failed");
        if (outcome.kind === "failed") {
          expect(isSqliteWorkerError(outcome.error, "outcome-unknown")).toBe(true);
        }
        vi.restoreAllMocks();
        withoutSql(() => {
          if (boundary === "commit") {
            expect(acquired!.currentSessionKey(conversationRef)).toBe(scope.sessionKey);
          } else {
            // No received COMMIT receipt retires the old view even after confirmed native rollback.
            expect(() => acquired!.currentSessionKey(conversationRef)).toThrow(
              "Conversation binding publication is unavailable",
            );
          }
        });
        const fresh = await captureConversationBindingFacts(scope, [conversationRef]);
        try {
          withoutSql(() =>
            expect(fresh.currentSessionKey(conversationRef)).toBe(
              boundary === "rollback" ? selected.sessionKey : scope.sessionKey,
            ),
          );
        } finally {
          fresh.release();
        }
      } finally {
        delivery.afterResult = undefined;
        admissionProbe.mockRestore();
        stop();
        acquired?.release();
      }
    });
  },
);

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
      readSessionEntryCache(database, { cache: true });
      const observed: Array<string | undefined> = [];
      const mutations: SessionIdentityMutation[] = [];
      const stopIdentity = onSessionIdentityMutation((mutation) => mutations.push(mutation));
      const stop = sessionChanges.subscribe((change) => {
        if ("sessionKey" in change && change.sessionKey === sessionKey) {
          observed.push(sharing.readCurrent()?.entry?.visibility);
        }
      });
      let whileWaiting: ReturnType<typeof sharing.readCurrent>;
      const failure = new Error(`synthetic ${boundary}`);
      delivery.afterResult = () => {
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
