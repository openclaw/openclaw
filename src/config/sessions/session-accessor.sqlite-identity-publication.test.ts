import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createSessionRowProjection } from "../../gateway/session-row-projection.js";
import {
  emitSessionIdentityMutation,
  onSessionIdentityMutation,
  type SessionIdentityMutation,
} from "../../sessions/session-lifecycle-events.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveRestartRecoverySteeringBlockReason } from "./restart-recovery-receipt.js";
import {
  readPreparedSessionEntryChange,
  readPreparedSessionSharingChange,
} from "./session-accessor.sqlite-entry-cache-publication.js";
import {
  readCommittedSessionEntryCache,
  readSessionEntryCache,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import {
  readCommittedIncognitoSessionSharing,
  readIncognitoSessionSteeringEntry,
} from "./session-accessor.sqlite-incognito-sharing.js";
import { applySessionEntryExactReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import { prepareSessionDeliveryGeneration } from "./session-delivery-generation.js";
import { captureSessionEntryCurrentRead } from "./session-entry-current-runtime.js";
import { withSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import { addSessionMember } from "./session-sharing-store.native.js";
import type { InternalSessionEntry } from "./types.js";

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
        publishCommittedSessionIdentity(
          "main",
          readOpenClawAgentDatabaseIdentity(database).identity,
          transition.previous,
          transition.current,
          {
            source: readOpenClawAgentDatabaseIdentity(database),
            entries: transition.current,
          },
        );
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

it.each(["session ID", "lifecycle revision"] as const)(
  "preserves a newer native %s when an earlier worker identity listener replaces a later row",
  async (replacement) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const firstKey = "agent:main:identity-batch-a";
      const laterKey = "agent:main:identity-batch-b";
      const scope = { agentId: "main", storePath: database.path, sessionKey: laterKey };
      const original = {
        sessionId: "later-session",
        lifecycleRevision: "original-lifecycle",
        updatedAt: 1,
        visibility: "shared" as const,
      };
      replaceSessionEntrySync(
        { ...scope, sessionKey: firstKey },
        { ...original, sessionId: "first-session" },
      );
      replaceSessionEntrySync(scope, original);
      const newer = {
        ...original,
        sessionId: replacement === "session ID" ? "newer-session" : original.sessionId,
        lifecycleRevision: "newer-native-lifecycle",
        updatedAt: 3,
        visibility: "draft" as const,
        label: "newer native metadata",
      };
      const expectedEntry: Partial<InternalSessionEntry> = { ...newer };
      if (replacement === "session ID") {
        // Visibility belongs to the replaced session and does not copy into its successor.
        delete expectedEntry.visibility;
      }
      const projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
      const query = { agentId: scope.agentId, storePath: scope.storePath, key: laterKey };
      const observed: Array<{
        entry: InternalSessionEntry | undefined;
        storedEntry: InternalSessionEntry | undefined;
        sharingEntry: InternalSessionEntry | undefined;
      }> = [];
      const workerPublications: Array<ReturnType<typeof readPreparedSessionEntryChange>> = [];
      const callbackErrors: unknown[] = [];
      let nativeReplacementStarted = false;
      let inNativeReplacement = false;
      let nativeCacheWasCold = false;
      let stop = () => {};
      try {
        await projection.ensureMaterialized();
        readSessionEntryCache(database, { cache: true });
        stop = onSessionIdentityMutation((mutation) => {
          if (!("current" in mutation)) {
            return;
          }
          if (mutation.current.sessionKeys.includes(firstKey) && !nativeReplacementStarted) {
            workerPublications.push(readPreparedSessionEntryChange(mutation, firstKey));
            nativeReplacementStarted = true;
            nativeCacheWasCold = readCommittedSessionEntryCache(database.db) === undefined;
            inNativeReplacement = true;
            try {
              replaceSessionEntrySync(scope, newer);
            } catch (error) {
              callbackErrors.push(error);
            } finally {
              inNativeReplacement = false;
            }
            return;
          }
          if (
            mutation.current.sessionKeys.includes(laterKey) &&
            nativeReplacementStarted &&
            !inNativeReplacement
          ) {
            workerPublications.push(readPreparedSessionEntryChange(mutation, laterKey));
            const row = projection.capture(query);
            observed.push(
              structuredClone({
                entry: row?.entry,
                storedEntry: row?.storedEntry,
                sharingEntry: projection.sharingTarget(query)?.entry,
              }),
            );
          }
        });
        await applySessionEntryExactReplacements({
          agentId: scope.agentId,
          storePath: scope.storePath,
          sessionKeys: [firstKey, laterKey],
          update: (rows) => ({
            result: undefined,
            replacements: rows.map(({ sessionKey, entry }) => ({
              sessionKey,
              entry: {
                ...entry,
                lifecycleRevision: "worker-lifecycle",
                updatedAt: 2,
                label: "older worker metadata",
              },
            })),
          }),
        });
        expect(callbackErrors).toEqual([]);
        expect(workerPublications).toHaveLength(2);
        for (const publication of workerPublications) {
          expect(publication?.source).toMatchObject({
            identity: readOpenClawAgentDatabaseIdentity(database).identity,
            revision: expect.any(Number),
          });
          expect(publication?.entry).toMatchObject({
            lifecycleRevision: "worker-lifecycle",
            label: "older worker metadata",
          });
        }
        expect(nativeReplacementStarted).toBe(true);
        // Cold native writes carry no revision comparable with the worker's prepared receipt.
        expect(nativeCacheWasCold).toBe(true);
        expect(observed).toHaveLength(1);
        for (const entry of [observed[0]!.entry, observed[0]!.storedEntry]) {
          if (entry !== undefined) {
            expect(entry).toMatchObject(expectedEntry);
            expect(entry.visibility).toBe(expectedEntry.visibility);
          }
        }
        const expectedSharing = {
          sessionId: newer.sessionId,
          lifecycleRevision: newer.lifecycleRevision,
        };
        if (observed[0]!.sharingEntry !== undefined) {
          expect(observed[0]!.sharingEntry).toMatchObject(expectedSharing);
          expect(observed[0]!.sharingEntry.visibility).toBe(expectedEntry.visibility);
        }
        const committed = readExactSessionEntryRow(database, laterKey)?.entry;
        expect(committed).toMatchObject(expectedEntry);
        expect(committed?.visibility).toBe(expectedEntry.visibility);
        await projection.ensureMaterialized();
        const current = projection.capture(query);
        for (const entry of [current?.entry, current?.storedEntry]) {
          expect(entry).toMatchObject(expectedEntry);
          expect(entry?.visibility).toBe(expectedEntry.visibility);
        }
        expect(projection.sharingTarget(query)?.entry).toMatchObject(expectedSharing);
        expect(projection.sharingTarget(query)?.entry.visibility).toBe(expectedEntry.visibility);
      } finally {
        stop();
        projection.dispose();
      }
    });
  },
);

it("uses incognito transaction postimages for currency and steering while delivery retains committed facts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "main";
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: state.env });
    const options = { agentId, path: storePath, env: state.env };
    const scope = {
      agentId,
      storePath,
      env: state.env,
      sessionKey: "agent:main:subagent:incognito-currency",
    };
    const originalCurrency = {
      sessionId: "incognito-currency-session",
      lifecycleRevision: "incognito-currency-lifecycle",
      lifecycleRunId: "original-run",
      activeWriterRunId: "original-writer",
      subagentRecovery: { lastRunId: "original-hidden-run" },
    };
    const original = {
      ...originalCurrency,
      incognito: true,
      updatedAt: 1,
      status: "running",
      restartRecoveryDeliveryRunId: "original-run",
      restartRecoveryDeliverySourceRunId: "original-source",
      restartRecoveryTerminalRunIds: ["earlier-source"],
    } satisfies InternalSessionEntry;
    const database = openOpenClawAgentDatabase(options);
    const readSteeringBlockReason = () => {
      const sql = observeHostDataSql();
      try {
        const entry = readIncognitoSessionSteeringEntry(database.db, scope.sessionKey);
        const reason = resolveRestartRecoverySteeringBlockReason(
          entry,
          original.sessionId,
          "original-source",
        );
        expect(sql.queries).toEqual([]);
        return reason;
      } finally {
        sql.restore();
      }
    };
    runOpenClawAgentWriteTransaction(
      (writer) => writeSessionEntry(writer, scope.sessionKey, original),
      options,
    );
    const reader = await withSessionEntryReadOnlyInWorker(
      scope,
      () => {},
      async (read, owner) => {
        expect(read.ok).toBe(true);
        return captureSessionEntryCurrentRead(scope, owner);
      },
    );
    if (reader.source) {
      throw new Error("Expected a process-held incognito currency reader");
    }
    const generation = await prepareSessionDeliveryGeneration({
      agentId,
      storePath,
      sessionKey: scope.sessionKey,
      sessionId: original.sessionId,
      lifecycleRevision: original.lifecycleRevision,
    });
    const rollback = new Error("roll back incognito currency postimage");
    try {
      expect(reader.readCurrent()).toMatchObject(originalCurrency);
      expect(readSteeringBlockReason()).toBeUndefined();
      expect(() =>
        runOpenClawAgentWriteTransaction((writer) => {
          writeSessionEntry(writer, scope.sessionKey, {
            ...original,
            lifecycleRunId: "pending-run",
            activeWriterRunId: "pending-writer",
            subagentRecovery: { lastRunId: "pending-hidden-run" },
            updatedAt: 2,
            restartRecoveryDeliveryReceiptState: "terminal-pending",
            restartRecoveryDeliveryToolCallId: "pending-tool",
          });
          // A later field publication must retain the staged entry's currency fields.
          addSessionMember(scope, { identityId: "member", addedBy: "operator" });
          expect(reader.readCurrent()).toMatchObject({
            lifecycleRunId: "pending-run",
            activeWriterRunId: "pending-writer",
            subagentRecovery: { lastRunId: "pending-hidden-run" },
          });
          expect(readSteeringBlockReason()).toBe("terminal-pending");
          expect(() => readCommittedIncognitoSessionSharing(writer.db, scope.sessionKey)).toThrow(
            "publication is pending",
          );
          expect(generation.assertCurrent).toThrow(
            expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
          );
          throw rollback;
        }, options),
      ).toThrow(rollback);
      expect(database.db.isTransaction).toBe(false);
      expect(reader.readCurrent()).toMatchObject(originalCurrency);
      expect(readSteeringBlockReason()).toBeUndefined();
      generation.assertCurrent();
      runOpenClawAgentWriteTransaction(
        (writer) =>
          writeSessionEntry(writer, scope.sessionKey, {
            ...original,
            lifecycleRunId: "committed-run",
            subagentRecovery: { lastRunId: "committed-hidden-run" },
            updatedAt: 3,
            restartRecoveryDeliveryReceiptState: "delivered-terminal",
            restartRecoveryDeliveryToolCallId: "committed-tool",
          }),
        options,
      );
      expect(reader.readCurrent()).toMatchObject({
        lifecycleRunId: "committed-run",
        subagentRecovery: { lastRunId: "committed-hidden-run" },
      });
      expect(readSteeringBlockReason()).toBe("delivered-terminal");
      // Delivery owns session/lifecycle identity, not recovery's execution predicate.
      generation.assertCurrent();
    } finally {
      generation.release();
    }
  });
});
