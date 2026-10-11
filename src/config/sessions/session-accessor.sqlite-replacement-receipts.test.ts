import { DatabaseSync } from "node:sqlite";
import "./session-accessor.sqlite-replacement-publication.test-support.js";
import { expect, it } from "vitest";
import { createSessionMembershipProjection } from "../../gateway/session-membership-projection.js";
import { readSqliteDatabaseWriteTokenForPath } from "../../infra/sqlite-database-admission.js";
import {
  captureSessionRowChanges,
  sessionChanges,
  type SessionRowChange,
} from "../../sessions/session-row-changes.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  retainPreparedSessionEntryPredicate,
  retainPreparedSessionGenerationFacts,
  retainPreparedSessionSharingFacts,
} from "./session-accessor.sqlite-entry-cache-publication-state.js";
import { readPreparedSessionEntryChange } from "./session-accessor.sqlite-entry-cache-publication.js";
import {
  projectSessionSharingEntry,
  type SessionEntryReplacementPublication,
} from "./session-accessor.sqlite-entry-cache.types.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { retainSessionEntryWorkerPublication } from "./session-accessor.sqlite-entry-worker-publication.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import {
  applySessionEntryCanonicalReplacements,
  applySessionEntryExactReplacements,
} from "./session-accessor.sqlite-replacement-projection.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import { readSessionTranscriptWatermarkInDatabase } from "./session-accessor.sqlite-transcript-watermark.js";
import { appendTranscriptEventSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { captureSessionEntryMetadataReceipts } from "./session-entry-metadata-receipt.js";
import { updateSessionGroupCategoriesInWorker } from "./session-group-categories.js";
import { readPreparedSessionParticipants } from "./session-participant-prepared-read.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import { addSessionMember, removeSessionMember } from "./session-sharing-store.native.js";
import type { SessionEntry } from "./types.js";

const { getReplacementPublicationDelivery } =
  await import("./session-accessor.sqlite-replacement-publication.test-support.js");
const delivery = getReplacementPublicationDelivery();

it("sheds aggregate optional snapshots while committing every required receipt row", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const keys = ["agent:main:large-first", "agent:main:large-second"];
    const result = runOpenClawAgentWriteTransaction(
      (current) => {
        const entries = new Map<string, SessionEntry>();
        const captured = captureSessionRowChanges(current.db, () => {
          for (const key of keys) {
            entries.set(
              key,
              writeSessionEntry(current, key, {
                sessionId: key,
                updatedAt: 1,
                label: key,
                skillsSnapshot: { prompt: `${key}:${"x".repeat(5 * 1024 * 1024)}`, skills: [] },
              }),
            );
          }
        });
        return {
          metadata: captureSessionEntryMetadataReceipts(captured.changes),
          replacement: prepareSessionEntryReplacementPublication(
            {
              previous: new Map(),
              current: entries,
              pendingArchiveRecovery: false,
              maintenancePlans: [],
              membershipInvalidatedKeys: [],
            },
            current,
            { captureFullFacts: true },
          ),
        };
      },
      { agentId: "main", path: database.path },
    );
    expect(result.replacement.fullEntries).toBeUndefined();
    expect(result.replacement.source?.writeToken).toBeUndefined();
    expect([...result.replacement.current.keys()]).toEqual(keys);
    expect(result.metadata).toHaveLength(keys.length);
    for (const [index, key] of keys.entries()) {
      expect(readExactSessionEntryRow(database, key, "list")?.entry.label).toBe(key);
      const metadata = result.metadata[index]!;
      const fact = metadata.facts.get(key);
      expect(fact).toMatchObject({ kind: "postimage", value: { entry: { label: key } } });
      if (fact?.kind !== "postimage") {
        throw new Error("Expected committed metadata after optional snapshot shedding");
      }
      expect(fact.value.fullEntry).toBeUndefined();
      expect(metadata.source.writeToken).toBeUndefined();
      expect(result.replacement.current.get(key)).toMatchObject({ label: key });
      expect(result.replacement.current.get(key)?.skillsSnapshot).toBeUndefined();
    }
  });
});

it("withholds metadata certification after a later write in its native transaction", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const sessionKey = "agent:main:metadata-receipt";
    for (const rawWrite of [false, true]) {
      const receipts = runOpenClawAgentWriteTransaction(
        (current) => {
          const captured = captureSessionRowChanges(current.db, () =>
            writeSessionEntry(current, sessionKey, {
              sessionId: "metadata-receipt",
              updatedAt: 1,
              label: "selected",
              skillsSnapshot: { prompt: "Persisted metadata prompt", skills: [] },
            }),
          );
          if (rawWrite) {
            current.db
              .prepare(
                "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', ?) WHERE session_key = ?",
              )
              .run("later raw value", sessionKey);
          }
          return captureSessionEntryMetadataReceipts(captured.changes);
        },
        { agentId: "main", path: database.path },
      );
      const receipt = receipts[0];
      expect(receipt).toBeDefined();
      const fact = receipt!.facts.get(sessionKey);
      expect(fact?.kind).toBe("postimage");
      if (fact?.kind !== "postimage") {
        throw new Error("Expected the native writer's metadata receipt");
      }
      expect(fact.value.entry.skillsSnapshot).toBeUndefined();
      expect(fact.value.fullEntry?.skillsSnapshot?.prompt).toBe("Persisted metadata prompt");
      if (rawWrite) {
        expect(receipt!.source.writeToken).toBeUndefined();
      } else {
        expect(receipt!.source.writeToken).toBeTypeOf("string");
        expect(receipt!.source.writeToken).toBe(readSqliteDatabaseWriteTokenForPath(database.path));
      }
    }
  });
});

it.each([false, true])(
  "seals full replacement facts without retaining prompts in display rows (later raw write=%s)",
  async (rawWrite) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: "agent:main:full-receipt",
      };
      const snapshots = {
        sessionDiffBaseline: {
          version: 1,
          sessionId: "full-receipt",
          root: "/synthetic",
          files: [],
        },
        skillsSnapshot: { prompt: "Persisted skill prompt", skills: [] },
        systemPromptReport: {
          source: "run",
          generatedAt: 1,
          systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
          injectedWorkspaceFiles: [],
          skills: { promptChars: 0, entries: [] },
          tools: { listChars: 0, schemaChars: 0, entries: [] },
        },
      } satisfies Partial<SessionEntry>;
      replaceSessionEntrySync(scope, { sessionId: "full-receipt", updatedAt: 1, ...snapshots });
      let published: ReturnType<typeof readPreparedSessionEntryChange>;
      const stop = sessionChanges.subscribeFacts((change) => {
        if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
          published = readPreparedSessionEntryChange(change, scope.sessionKey) ?? published;
        }
      });
      delivery.afterResult = () => {
        if (rawWrite) {
          database.db
            .prepare(
              "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', ?) WHERE session_key = ?",
            )
            .run("later raw value", scope.sessionKey);
        }
      };
      try {
        await applySessionEntryExactReplacements({
          storePath: database.path,
          sessionKeys: [scope.sessionKey],
          update: ([row]) => ({
            result: undefined,
            replacements: [
              { sessionKey: scope.sessionKey, entry: { ...row!.entry, label: "committed" } },
            ],
          }),
        });
        expect(published?.entry?.label).toBe("committed");
        expect(published?.entry?.skillsSnapshot).toBeUndefined();
        expect(published?.entry?.systemPromptReport).toBeUndefined();
        expect(published?.entry?.sessionDiffBaseline).toBeUndefined();
        expect(published?.fullEntry).toMatchObject({ label: "committed", ...snapshots });
        expect(published?.source.writeToken).toBeTypeOf("string");
        const currentToken = readSqliteDatabaseWriteTokenForPath(database.path);
        expect(published?.source.writeToken === currentToken).toBe(!rawWrite);
        expect(readExactSessionEntryRow(database, scope.sessionKey)?.entry.label).toBe(
          rawWrite ? "later raw value" : "committed",
        );
      } finally {
        delivery.afterResult = undefined;
        stop();
      }
    });
  },
);

it.each(["native", "worker"] as const)(
  "publishes %s category changes to retained authority before observers",
  async (writer) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: "agent:main:category-authority",
      };
      const entry = { sessionId: "category-authority", updatedAt: 1, category: "before" };
      replaceSessionEntrySync(scope, entry);
      const source = readOpenClawAgentDatabaseIdentity(database);
      if (typeof source.identity !== "string") {
        throw new Error("Expected durable category fixture");
      }
      const sharing = retainPreparedSessionSharingFacts({
        databaseIdentity: `file:${source.identity}`,
        sessionKey: scope.sessionKey,
        entry,
        membership: new Set(),
      });
      const read = () => {
        const current = sharing.readCurrent()?.entry;
        return { sessionId: current?.sessionId, category: current?.category };
      };
      const observed: Array<ReturnType<typeof read>> = [];
      const stop = sessionChanges.subscribe((change) => {
        if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
          observed.push(read());
        }
      });
      try {
        if (writer === "native") {
          replaceSessionEntrySync(scope, { ...entry, category: "after" });
        } else {
          expect(await updateSessionGroupCategoriesInWorker({ scope, from: "before" })).toBe(1);
        }
        const expected = writer === "native" ? "after" : undefined;
        expect(readExactSessionEntryRow(database, scope.sessionKey)?.entry.category).toBe(expected);
        expect(read()).toEqual({ sessionId: entry.sessionId, category: expected });
        expect(observed.length).toBeGreaterThan(0);
        for (const snapshot of observed) {
          expect(snapshot).toEqual({ sessionId: entry.sessionId, category: expected });
        }
      } finally {
        stop();
        sharing.release();
      }
    });
  },
);

it("fences every retained reader after a native installer fails, including older pending receipts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const scope = {
      agentId: "main",
      storePath: database.path,
      sessionKey: "agent:main:failed-native",
    };
    replaceSessionEntrySync(scope, { sessionId: "before", updatedAt: 1 });
    const source = readOpenClawAgentDatabaseIdentity(database);
    if (typeof source.identity !== "string") {
      throw new Error("Expected durable native publication fixture");
    }
    const entry = readExactSessionEntryRow(database, scope.sessionKey)!.entry;
    const params = {
      databaseIdentity: `file:${source.identity}`,
      sessionKey: scope.sessionKey,
      entry,
    };
    const failed = retainPreparedSessionEntryPredicate({
      ...params,
      matches() {
        throw new Error("unavailable comparator");
      },
    });
    const sibling = retainPreparedSessionEntryPredicate({
      ...params,
      matches: (before, after) => before?.sessionId === after?.sessionId,
    });
    const generation = retainPreparedSessionGenerationFacts(params);
    const acquiring = retainPreparedSessionSharingFacts({
      databaseIdentity: params.databaseIdentity,
      sessionKey: scope.sessionKey,
      acquiring: true,
    });
    const older = retainSessionEntryWorkerPublication({
      ...scope,
      databaseIdentity: source.identity,
    });
    older.begin([scope.sessionKey], []);
    try {
      replaceSessionEntrySync(scope, { sessionId: "after", updatedAt: 2 });
      expect(readExactSessionEntryRow(database, scope.sessionKey)?.entry.sessionId).toBe("after");
      older.settle(undefined, false);
      expect(failed.isCurrent()).toBe(false);
      expect(sibling.isCurrent()).toBe(false);
      expect(generation.readCurrent()).toBeNull();
      expect(() =>
        acquiring.initialize({ entry: projectSessionSharingEntry(entry), membership: new Set() }),
      ).toThrow("no longer current");
    } finally {
      older.settle(undefined, false);
      failed.release();
      sibling.release();
      generation.release();
      acquiring.release();
    }
  });
});

it.each([
  { boundary: "before settlement", notify: false },
  { boundary: "before settlement", notify: true },
  { boundary: "during facts delivery", notify: true },
] as const)(
  "withholds a watermark receipt after a native append $boundary (notification=$notify)",
  async ({ boundary, notify }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: "agent:main:late-watermark",
        sessionId: "late-watermark",
      };
      replaceSessionEntrySync(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        activitySummary: {
          version: 1,
          text: "Empty transcript",
          updatedAt: 1,
          sessionId: scope.sessionId,
          generation: null,
          maxSeq: null,
          leafEntryId: null,
          coveredMessages: 0,
          totalMessages: 0,
          omittedContent: false,
        },
      });
      const source = readOpenClawAgentDatabaseIdentity(database);
      if (typeof source.identity !== "string") {
        throw new Error("Expected durable sharing fixture");
      }
      const sharing = retainPreparedSessionSharingFacts({
        databaseIdentity: `file:${source.identity}`,
        sessionKey: scope.sessionKey,
        entry: projectSessionSharingEntry(
          readExactSessionEntryRow(database, scope.sessionKey)!.entry,
        ),
        membership: new Set(),
      });
      const acquiring = retainPreparedSessionSharingFacts({
        databaseIdentity: `file:${source.identity}`,
        sessionKey: scope.sessionKey,
        acquiring: true,
      });
      const sharingSnapshot = sharing.readCurrent();
      if (!sharingSnapshot) {
        throw new Error("Expected prepared sharing snapshot");
      }
      let published: ReturnType<typeof readPreparedSessionEntryChange>;
      let appended = false;
      const append = () => {
        appended = true;
        expect(appendTranscriptEventSync(scope, { type: "proof", id: "late-event" }).ok).toBe(true);
        if (notify) {
          emitSessionTranscriptUpdate({ target: scope });
        }
      };
      const stop = sessionChanges.subscribeFacts((change) => {
        if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
          if (
            boundary === "during facts delivery" &&
            !appended &&
            change.facts?.kind === "replacement"
          ) {
            append();
          }
          published = readPreparedSessionEntryChange(change, scope.sessionKey) ?? published;
        }
      });
      delivery.afterResult = (result) => {
        const receipt = (result as { publication: SessionEntryReplacementPublication }).publication;
        expect(receipt.projection?.get(scope.sessionKey)?.activitySummaryWatermark).toEqual({
          generation: null,
          maxSeq: null,
        });
        if (boundary === "before settlement") {
          append();
        }
      };
      try {
        await applySessionEntryExactReplacements({
          storePath: database.path,
          sessionKeys: [scope.sessionKey],
          update: ([row]) => ({
            result: undefined,
            replacements: [
              { sessionKey: scope.sessionKey, entry: { ...row!.entry, label: "committed" } },
            ],
          }),
        });
        expect(appended).toBe(true);
        expect(published?.entry?.label).toBe("committed");
        expect(published?.projection).toBeUndefined();
        expect(sharing.readCurrent()).toMatchObject({
          entry: { sessionId: scope.sessionId },
          membership: new Set(),
        });
        acquiring.initialize(sharingSnapshot);
        expect(acquiring.readCurrent()).toEqual(sharing.readCurrent());
        expect(readSessionTranscriptWatermarkInDatabase(database, scope.sessionId).maxSeq).toBe(0);
      } finally {
        delivery.afterResult = undefined;
        sharing.release();
        acquiring.release();
        stop();
      }
    });
  },
);

it.each(["before preparation", "before settlement", "during facts delivery"] as const)(
  "publishes revocation before observers with a member write %s",
  async (boundary) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: "agent:main:compact-receipt",
      };
      replaceSessionEntrySync(scope, {
        sessionId: "compact-receipt",
        updatedAt: 1,
        category: "before",
      });
      recordSessionParticipant(scope, {
        identity: {
          type: "remote",
          pluginId: "test-channel",
          domain: "workspace",
          idKind: "user",
          id: "before",
        },
        promptedAt: 1,
      });
      addSessionMember(scope, { identityId: "revoked", addedBy: "owner", addedAt: 1 });
      const source = readOpenClawAgentDatabaseIdentity(database);
      if (typeof source.identity !== "string") {
        throw new Error("Expected durable predicate fixture");
      }
      const predicate = retainPreparedSessionEntryPredicate({
        databaseIdentity: `file:${source.identity}`,
        sessionKey: scope.sessionKey,
        entry: readExactSessionEntryRow(database, scope.sessionKey)!.entry,
        matches: (before, after) => before?.category === after?.category,
      });
      const projection = createSessionMembershipProjection();
      projection.updateTargets([{ ...scope, ...source }]);
      let revokedDuringFacts = false;
      const stopFacts = sessionChanges.subscribeFacts((change) => {
        if (
          boundary === "during facts delivery" &&
          !revokedDuringFacts &&
          "sessionKey" in change &&
          change.sessionKey === scope.sessionKey &&
          change.facts?.kind === "replacement"
        ) {
          revokedDuringFacts = true;
          removeSessionMember(scope, "revoked");
        }
        projection.invalidate(change);
      });
      const read = () => ({
        ready: projection.ready(database.path, scope.sessionKey),
        membership: projection.membership(database.path, scope.sessionKey),
        groups: [...projection.groupTargets().keys()],
        participants: projection.withPreparedParticipantRead(() =>
          readPreparedSessionParticipants(database.db, scope.sessionKey),
        ),
      });
      const observed: ReturnType<typeof read>[] = [];
      const stopObserver = sessionChanges.subscribe((change) => {
        if (!("sessionKey" in change) || change.sessionKey !== scope.sessionKey) {
          return;
        }
        observed.push(read());
      });
      try {
        await projection.prepare();
        using foreign = new DatabaseSync(database.path);
        foreign
          .prepare("UPDATE session_participants SET actor_id = ? WHERE session_key = ?")
          .run("after", scope.sessionKey);
        if (boundary === "before preparation") {
          foreign
            .prepare("DELETE FROM session_members WHERE session_key = ?")
            .run(scope.sessionKey);
        } else if (boundary === "before settlement") {
          delivery.afterResult = () => {
            removeSessionMember(scope, "revoked");
          };
        }
        await applySessionEntryExactReplacements({
          storePath: database.path,
          sessionKeys: [scope.sessionKey],
          update: ([row]) => ({
            result: undefined,
            replacements: [
              { sessionKey: scope.sessionKey, entry: { ...row!.entry, category: "after" } },
            ],
          }),
        });
        expect(revokedDuringFacts).toBe(boundary === "during facts delivery");
        expect(observed.length).toBeGreaterThan(0);
        expect(predicate.isCurrent()).toBe(false);
        expect(observed.every(({ membership }) => membership?.length === 0)).toBe(true);
        expect(projection.needsPreparation).toBe(boundary !== "before preparation");
        if (boundary === "before preparation") {
          expect(observed).toEqual([
            expect.objectContaining({
              ready: true,
              groups: ["after"],
              participants: {
                participants: [
                  {
                    identity: {
                      type: "remote",
                      pluginId: "test-channel",
                      domain: "workspace",
                      idKind: "user",
                      id: "after",
                    },
                  },
                ],
                participantCount: 1,
              },
            }),
          ]);
        }
        await projection.prepare();
        expect(read()).toMatchObject({
          ready: true,
          membership: [],
          groups: ["after"],
          participants: { participants: [{ identity: { id: "after" } }], participantCount: 1 },
        });
      } finally {
        delivery.afterResult = undefined;
        stopObserver();
        stopFacts();
        predicate.release();
        projection.dispose();
      }
    });
  },
);

it("keeps a removal receipt bound to its physical store when a listener rebinds the locator", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const rebound = openOpenClawAgentDatabase({
      agentId: "main",
      path: state.statePath("rebound.sqlite"),
    });
    const key = "agent:main:alias-survivor";
    const alias = "agent:main:alias-retired";
    const entry = { sessionId: "alias-generation", updatedAt: 1 };
    for (const sessionKey of [key, alias]) {
      replaceSessionEntrySync({ agentId: "main", storePath: database.path, sessionKey }, entry);
    }
    const reboundScope = { agentId: "main", storePath: rebound.path, sessionKey: alias };
    replaceSessionEntrySync(reboundScope, { sessionId: "rebound-generation", updatedAt: 1 });
    addSessionMember(reboundScope, {
      identityId: "rebound-member",
      addedBy: "owner",
      addedAt: 1,
    });
    const projection = createSessionMembershipProjection();
    const reboundTarget = {
      agentId: "main",
      storePath: rebound.path,
      ...readOpenClawAgentDatabaseIdentity(rebound),
    };
    projection.updateTargets([
      { agentId: "main", storePath: database.path, ...readOpenClawAgentDatabaseIdentity(database) },
      reboundTarget,
    ]);
    let reboundDuringFacts = false;
    const stopRebind = sessionChanges.subscribeFacts((change) => {
      if (
        "sessionKey" in change &&
        change.sessionKey === alias &&
        change.facts?.kind === "removed"
      ) {
        reboundDuringFacts = true;
        projection.updateTargets([{ ...reboundTarget, storePath: database.path }]);
      }
    });
    const stopFacts = sessionChanges.subscribeFacts((change) => projection.invalidate(change));
    const observed: Array<readonly string[] | undefined> = [];
    const stopObserver = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === alias) {
        observed.push(projection.membership(database.path, alias));
      }
    });
    try {
      await projection.prepare();
      expect(projection.membership(rebound.path, alias)).toEqual(["rebound-member"]);
      await applySessionEntryCanonicalReplacements({
        storePath: database.path,
        sessionKeys: [key, alias],
        update: () => ({
          result: undefined,
          replacements: [{ sessionKey: key, previousSessionKeys: [alias], entry }],
        }),
      });
      expect(reboundDuringFacts).toBe(true);
      expect(observed).toEqual([["rebound-member"]]);
      expect(projection.ready(database.path, alias)).toBe(true);
      expect(readExactSessionEntryRow(database, alias)).toBeUndefined();
      expect(readExactSessionEntryRow(rebound, alias)?.entry.sessionId).toBe("rebound-generation");
      expect(
        listSessionMembersInDatabase(rebound, alias).map(({ identityId }) => identityId),
      ).toEqual(["rebound-member"]);
    } finally {
      stopObserver();
      stopFacts();
      stopRebind();
      projection.dispose();
    }
  });
});

it.each(["facts", "projection"] as const)(
  "preserves a native commit and fences a failed %s installation before notification",
  async (phase) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: "agent:main:failed-install",
      };
      replaceSessionEntrySync(scope, {
        sessionId: "failed-install",
        updatedAt: 1,
        category: "before",
      });
      const source = readOpenClawAgentDatabaseIdentity(database);
      const projection = createSessionMembershipProjection();
      projection.updateTargets([{ ...scope, ...source }]);
      const stopFacts = sessionChanges.subscribeFacts((change) => projection.invalidate(change));
      let fail = true;
      const failInstallation = (change: SessionRowChange) => {
        if (
          fail &&
          "sessionKey" in change &&
          change.sessionKey === scope.sessionKey &&
          !change.factsInvalidated
        ) {
          fail = false;
          throw new Error("injected installation failure");
        }
      };
      const stopFailure =
        phase === "facts"
          ? sessionChanges.subscribeFacts(failInstallation)
          : sessionChanges.subscribeProjection(failInstallation);
      const observed: boolean[] = [];
      const stopObserver = sessionChanges.subscribe((change) => {
        if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
          observed.push(projection.ready(database.path, scope.sessionKey));
        }
      });
      try {
        await projection.prepare();
        replaceSessionEntrySync(scope, {
          sessionId: "failed-install",
          updatedAt: 2,
          category: "after",
        });
        expect(readExactSessionEntryRow(database, scope.sessionKey)?.entry.category).toBe("after");
        expect(fail).toBe(false);
        expect(observed.length).toBeGreaterThan(0);
        expect(observed.every((ready) => !ready)).toBe(true);
        await projection.prepare();
        expect([...projection.groupTargets().keys()]).toEqual(["after"]);
      } finally {
        stopObserver();
        stopFailure();
        stopFacts();
        projection.dispose();
      }
    });
  },
);
