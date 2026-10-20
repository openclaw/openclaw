import { expect, it } from "vitest";
import { createSessionRowProjection } from "../../gateway/session-row-projection.js";
import {
  emitSessionIdentityMutation,
  onSessionIdentityMutation,
  type SessionIdentityMutation,
} from "../../sessions/session-lifecycle-events.js";
import { readOpenClawAgentDatabaseIdentity as readIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readPreparedSessionEntryChange as readPrepared,
  readPreparedSessionSharingChange as readSharingChange,
} from "./session-accessor.sqlite-entry-cache-publication.js";
import { readSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import { readCommittedSessionEntryCache } from "./session-accessor.sqlite-entry-cache.test-support.js";
import {
  readExactSessionEntryRow as readRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync as replaceEntry } from "./session-accessor.sqlite-entry.js";
import { publishCommittedSessionIdentity as publishIdentity } from "./session-accessor.sqlite-identity.js";
import { applySessionEntryExactReplacements as replaceBatch } from "./session-accessor.sqlite-replacement-projection.js";
import { prepareSessionDeliveryGeneration } from "./session-delivery-generation.js";
import type { InternalSessionEntry } from "./types.js";

function withDatabase(run: (db: OpenClawAgentDatabase) => Promise<void>) {
  return withOpenClawTestState({ scenario: "minimal" }, () =>
    run(openOpenClawAgentDatabase({ agentId: "main" })),
  );
}

it("fences a delivery generation during native writes and restores it only on rollback", async () => {
  await withDatabase(async (database) => {
    const options = { agentId: "main", path: database.path };
    const sessionKey = "agent:main:native";
    const original = { sessionId: "native", lifecycleRevision: "original", updatedAt: 1 };
    writeSessionEntry(database, sessionKey, original);
    const originalRow = readRow(database, sessionKey);
    expect(originalRow).toBeDefined();
    const generation = await prepareSessionDeliveryGeneration({
      agentId: options.agentId,
      storePath: database.path,
      sessionKey,
      sessionId: original.sessionId,
      lifecycleRevision: original.lifecycleRevision,
    });
    const rollback = new Error("roll back staged generation");
    const commit = (entry = original, beforeCommit = (_db: OpenClawAgentDatabase) => {}) =>
      runOpenClawAgentWriteTransaction((writer) => {
        writeSessionEntry(writer, sessionKey, entry);
        beforeCommit(writer);
      }, options);
    try {
      generation.assertCurrent();
      expect(() =>
        commit({ ...original, lifecycleRevision: "pending", updatedAt: 2 }, (writer) => {
          expect(writer.db.isTransaction).toBe(true);
          expect(readRow(writer, sessionKey)?.entry.lifecycleRevision).toBe("pending");
          expect(generation.assertCurrent).toThrow(
            expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
          );
          throw rollback;
        }),
      ).toThrow(rollback);
      expect(database.db.isTransaction).toBe(false);
      expect(readRow(database, sessionKey)).toEqual(originalRow);
      generation.assertCurrent();

      commit({ ...original, lifecycleRevision: "replacement", updatedAt: 3 });
      expect(readRow(database, sessionKey)?.entry.lifecycleRevision).toBe("replacement");
      // Restoring the old values cannot restore a generation already replaced at COMMIT.
      commit();
      expect(generation.assertCurrent).toThrow(
        expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_REVOKED" }),
      );
    } finally {
      generation.release();
    }
  });
});

it("classifies prepared lifecycle publications without classifying copied raw events", async () => {
  await withDatabase(async (database) => {
    const key = "agent:main:entry";
    const entry = { sessionId: "entry", lifecycleRevision: "first", updatedAt: 1 };
    const observations: Array<{
      mutation: SessionIdentityMutation;
      sharingChange: ReturnType<typeof readSharingChange>;
      prepared: ReturnType<typeof readPrepared>;
    }> = [];
    const stop = onSessionIdentityMutation((mutation) => {
      const selectedKey = mutation.kind === "delete" ? key : mutation.current.sessionKeys[0];
      observations.push({
        mutation,
        sharingChange: readSharingChange(mutation),
        prepared: selectedKey === undefined ? undefined : readPrepared(mutation, selectedKey),
      });
    });
    const previous = new Map([[key, entry]]);
    const empty = new Map<string, typeof entry>();
    const source = readIdentity(database);
    const transitions = [
      [empty, previous],
      [previous, new Map([[`${key}-moved`, entry]])],
      [previous, new Map([[key, { ...entry, sessionId: "replacement" }]])],
      [previous, new Map([[key, { ...entry, lifecycleRevision: "next" }]])],
      [previous, empty],
    ] as const;
    try {
      for (const [before, current] of transitions) {
        publishIdentity("main", source.identity, before, current, { source, entries: current });
      }
      expect(observations.map(({ mutation }) => mutation.kind)).toEqual([
        "create",
        "move",
        "replace",
        "reset",
        "delete",
      ]);
      const publications = observations.splice(0);
      for (const observation of publications) {
        expect(observation.sharingChange).toBe("changed");
        expect(observation.prepared).toBeDefined();
        emitSessionIdentityMutation({ ...observation.mutation });
      }
      expect(observations).toHaveLength(5);
      expect(observations.map(({ sharingChange, prepared }) => [sharingChange, prepared])).toEqual(
        Array.from({ length: 5 }, () => [undefined, undefined]),
      );
    } finally {
      stop();
    }
  });
});

it.each(["session ID", "lifecycle revision"] as const)(
  "preserves a newer native %s when an earlier worker identity listener replaces a later row",
  async (replacement) => {
    await withDatabase(async (database) => {
      const firstKey = "agent:main:a";
      const laterKey = "agent:main:b";
      const scope = { agentId: "main", storePath: database.path, sessionKey: laterKey };
      const original = {
        sessionId: "later",
        lifecycleRevision: "original",
        updatedAt: 1,
        visibility: "shared" as const,
      };
      replaceEntry({ ...scope, sessionKey: firstKey }, { ...original, sessionId: "first" });
      replaceEntry(scope, original);
      const newer = {
        ...original,
        sessionId: replacement === "session ID" ? "newer" : original.sessionId,
        lifecycleRevision: "native",
        updatedAt: 3,
        visibility: "draft" as const,
        label: "native metadata",
      };
      const expectedEntry: Partial<InternalSessionEntry> = { ...newer };
      if (replacement === "session ID") {
        // Visibility belongs to the replaced session and does not copy into its successor.
        delete expectedEntry.visibility;
      }
      const expectedSharing = {
        sessionId: newer.sessionId,
        lifecycleRevision: newer.lifecycleRevision,
      };
      const expectEntry = (entry: InternalSessionEntry | undefined, expected = expectedEntry) => {
        expect(entry).toMatchObject(expected);
        expect(entry?.visibility).toBe(expectedEntry.visibility);
      };
      const projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
      const query = { agentId: scope.agentId, storePath: scope.storePath, key: laterKey };
      const capture = () => {
        const row = projection.capture(query);
        return [row?.entry, row?.storedEntry, projection.sharingTarget(query)?.entry];
      };
      const expectCapture = (entries: ReturnType<typeof capture>, allowMissing = false) => {
        entries.forEach((entry, index) => {
          if (!allowMissing || entry !== undefined) {
            expectEntry(entry, index === 2 ? expectedSharing : expectedEntry);
          }
        });
      };
      const observed: Array<ReturnType<typeof capture>> = [];
      const workerPublications: Array<ReturnType<typeof readPrepared>> = [];
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
            workerPublications.push(readPrepared(mutation, firstKey));
            nativeReplacementStarted = true;
            nativeCacheWasCold =
              readCommittedSessionEntryCache(requireNativeSqliteDatabase(database.db)) ===
              undefined;
            inNativeReplacement = true;
            try {
              replaceEntry(scope, newer);
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
            workerPublications.push(readPrepared(mutation, laterKey));
            observed.push(structuredClone(capture()));
          }
        });
        await replaceBatch({
          agentId: scope.agentId,
          storePath: scope.storePath,
          sessionKeys: [firstKey, laterKey],
          update: (rows) => ({
            result: undefined,
            replacements: rows.map(({ sessionKey, entry }) => ({
              sessionKey,
              entry: {
                ...entry,
                lifecycleRevision: "worker",
                updatedAt: 2,
                label: "worker metadata",
              },
            })),
          }),
        });
        expect(callbackErrors).toEqual([]);
        expect(workerPublications).toHaveLength(2);
        for (const publication of workerPublications) {
          expect(publication).toMatchObject({
            source: {
              identity: readIdentity(database).identity,
              revision: expect.any(Number),
            },
            entry: { lifecycleRevision: "worker", label: "worker metadata" },
          });
        }
        // Cold native writes carry no revision comparable with the worker's prepared receipt.
        expect(nativeCacheWasCold).toBe(true);
        expect(observed).toHaveLength(1);
        expectCapture(observed[0]!, true);
        expectEntry(readRow(database, laterKey)?.entry);
        await projection.ensureMaterialized();
        expectCapture(capture());
      } finally {
        stop();
        projection.dispose();
      }
    });
  },
);
