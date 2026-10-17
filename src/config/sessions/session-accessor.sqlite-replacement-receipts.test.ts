import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import "./session-accessor.sqlite-replacement-publication.test-support.js";
import { expect, it } from "vitest";
import { createSessionMembershipProjection } from "../../gateway/session-membership-projection.js";
import { readSqliteDatabaseWriteTokenForPath as writeToken } from "../../infra/sqlite-database-admission.js";
import {
  captureSessionRowChanges,
  sessionChanges,
  type SessionRowChange,
} from "../../sessions/session-row-changes.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction as transaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  retainPreparedSessionEntryPredicate as retainPredicate,
  retainPreparedSessionGenerationFacts as retainGeneration,
  retainPreparedSessionSharingFacts as retainSharing,
} from "./session-accessor.sqlite-entry-cache-publication-state.js";
import { readPreparedSessionEntryChange as readChange } from "./session-accessor.sqlite-entry-cache-publication.js";
import { projectSessionSharingEntry } from "./session-accessor.sqlite-entry-cache.types.js";
import { readExactSessionEntryRow as readEntry } from "./session-accessor.sqlite-entry-read.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { retainSessionEntryWorkerPublication as retainPublication } from "./session-accessor.sqlite-entry-worker-publication.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "./session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import {
  applySessionEntryCanonicalReplacements as replaceCanonical,
  applySessionEntryExactReplacements,
} from "./session-accessor.sqlite-replacement-projection.js";
import { prepareSessionEntryReplacementPublication as prepareReplacement } from "./session-accessor.sqlite-replacement-state.js";
import { captureSessionEntryMetadataReceipts as captureMetadata } from "./session-entry-metadata-receipt.js";
import { updateSessionGroupCategoriesInWorker as updateCategories } from "./session-group-categories.js";
import { readPreparedSessionParticipants } from "./session-participant-prepared-read.js";
import { recordSessionParticipantInWorker as recordParticipant } from "./session-sharing-store.async.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import { addSessionMember, removeSessionMember } from "./session-sharing-store.native.js";
import type { SessionEntry } from "./types.js";

const { getReplacementPublicationDelivery } =
  await import("./session-accessor.sqlite-replacement-publication.test-support.js");
const delivery = getReplacementPublicationDelivery();

function onKey(
  key: string,
  listener: (change: SessionRowChange) => void,
  phase: "subscribe" | "subscribeFacts" = "subscribe",
) {
  return sessionChanges[phase]((change) => {
    if ("sessionKey" in change && change.sessionKey === key) {
      listener(change);
    }
  });
}

function captureEntry(key: string, retainLast = true) {
  let latest: ReturnType<typeof readChange>;
  const stop = onKey(
    key,
    (change) => {
      latest = readChange(change, key) ?? (retainLast ? latest : undefined);
    },
    "subscribeFacts",
  );
  return { published: () => latest, stop };
}

function seed(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  id: string,
  fields: Partial<SessionEntry> = {},
) {
  const scope = { agentId: "main", storePath: database.path, sessionKey: `agent:main:${id}` };
  const entry = { sessionId: id, updatedAt: 1, ...fields };
  replaceSessionEntrySync(scope, entry);
  return { scope, entry };
}

function durableIdentity(database: ReturnType<typeof openOpenClawAgentDatabase>) {
  const identity = readOpenClawAgentDatabaseIdentity(database).identity;
  assert(typeof identity === "string", "Expected durable receipt fixture");
  return identity;
}

function rawLabel(database: ReturnType<typeof openOpenClawAgentDatabase>, key: string) {
  database.db
    .prepare(
      "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', ?) WHERE session_key = ?",
    )
    .run("later raw value", key);
}

function replaceFields(
  scope: { storePath: string; sessionKey: string },
  fields: Partial<SessionEntry>,
) {
  return applySessionEntryExactReplacements({
    storePath: scope.storePath,
    sessionKeys: [scope.sessionKey],
    update: ([row]) => ({
      result: undefined,
      replacements: [{ sessionKey: scope.sessionKey, entry: { ...row!.entry, ...fields } }],
    }),
  });
}

it("sheds aggregate optional snapshots while committing every required receipt row", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const keys = ["agent:main:large-first", "agent:main:large-second"];
    const result = transaction(
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
          metadata: captureMetadata(captured.changes),
          replacement: prepareReplacement(
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
      expect(readEntry(database, key, "list")?.entry.label).toBe(key);
      const metadata = result.metadata[index]!;
      const fact = metadata.facts.get(key);
      expect(fact).toMatchObject({ kind: "postimage", value: { entry: { label: key } } });
      assert(fact?.kind === "postimage", "Expected committed metadata after snapshot shedding");
      expect(fact.value.fullEntry).toBeUndefined();
      expect(metadata.source.writeToken).toBeUndefined();
      expect(result.replacement.current.get(key)).toMatchObject({ label: key });
      expect(result.replacement.current.get(key)?.skillsSnapshot).toBeUndefined();
    }
  });
});

it.each(["autocommit", "transaction"] as const)(
  "seals native metadata before observers for %s",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { env } = state;

      setRuntimeConfigSnapshot({});
      const sessionKey = "agent:main:native-metadata-seal";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, env },
        { sessionId: "native-metadata-seal", updatedAt: 1, verboseLevel: "off" },
      );
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      const { published, stop } = captureEntry(sessionKey, false);
      const write = () => {
        writeSessionEntry(database, sessionKey, {
          sessionId: "native-metadata-seal",
          updatedAt: 1,
          verboseLevel: "full",
        });
      };
      try {
        if (mode === "autocommit") {
          write();
        } else {
          transaction(write, { agentId: "main", path: database.path });
        }
        expect(published()?.entry?.verboseLevel).toBe("full");
        expect(published()?.source.writeToken).toBeTypeOf("string");
        expect(published()?.source.writeToken).toBe(writeToken(database.path));
      } finally {
        stop();
      }
    });
  },
);

it("withholds metadata certification after a later write in its native transaction", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const sessionKey = "agent:main:metadata-receipt";
    for (const rawWrite of [false, true]) {
      const receipts = transaction(
        (current) => {
          const captured = captureSessionRowChanges(current.db, () =>
            writeSessionEntry(current, sessionKey, {
              sessionId: "metadata-receipt",
              updatedAt: 1,
              label: `selected-${rawWrite}`,
              skillsSnapshot: { prompt: "Persisted metadata prompt", skills: [] },
            }),
          );
          if (rawWrite) {
            rawLabel(current, sessionKey);
          }
          return captureMetadata(captured.changes);
        },
        { agentId: "main", path: database.path },
      );
      const receipt = receipts[0];
      assert(receipt, "Expected metadata receipt");
      const fact = receipt.facts.get(sessionKey);
      assert(fact?.kind === "postimage", "Expected the native writer's metadata receipt");
      expect(fact.value.entry.skillsSnapshot).toBeUndefined();
      expect(fact.value.fullEntry?.skillsSnapshot?.prompt).toBe("Persisted metadata prompt");
      if (rawWrite) {
        expect(receipt.source.writeToken).toBeUndefined();
      } else {
        expect(receipt.source.writeToken).toBeTypeOf("string");
        expect(receipt.source.writeToken).toBe(writeToken(database.path));
      }
    }
  });
});

it.each([false, true])(
  "seals full replacement facts without retaining prompts in display rows (later raw write=%s)",
  async (rawWrite) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
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
      const { scope } = seed(database, "full-receipt", snapshots);
      const { published, stop } = captureEntry(scope.sessionKey);
      delivery.afterResult = () => {
        if (rawWrite) {
          rawLabel(database, scope.sessionKey);
        }
      };
      try {
        await replaceFields(scope, { label: "committed" });
        expect(published()?.entry?.label).toBe("committed");
        expect(published()?.entry?.skillsSnapshot).toBeUndefined();
        expect(published()?.entry?.systemPromptReport).toBeUndefined();
        expect(published()?.entry?.sessionDiffBaseline).toBeUndefined();
        expect(published()?.fullEntry).toMatchObject({ label: "committed", ...snapshots });
        expect(published()?.source.writeToken).toBeTypeOf("string");
        const currentToken = writeToken(database.path);
        expect(published()?.source.writeToken === currentToken).toBe(!rawWrite);
        expect(readEntry(database, scope.sessionKey)?.entry.label).toBe(
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
      const { scope, entry } = seed(database, "category-authority", { category: "before" });
      const sharing = retainSharing({
        databaseIdentity: `file:${durableIdentity(database)}`,
        sessionKey: scope.sessionKey,
        entry,
        membership: new Set(),
      });
      const read = () => {
        const current = sharing.readCurrent()?.entry;
        return { sessionId: current?.sessionId, category: current?.category };
      };
      const observed: Array<ReturnType<typeof read>> = [];
      const stop = onKey(scope.sessionKey, () => observed.push(read()));
      try {
        if (writer === "native") {
          replaceSessionEntrySync(scope, { ...entry, category: "after" });
        } else {
          expect(await updateCategories({ scope, from: "before" })).toBe(1);
        }
        const expected = writer === "native" ? "after" : undefined;
        expect(readEntry(database, scope.sessionKey)?.entry.category).toBe(expected);
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

it("keeps unrelated predicates current through participant publication", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const { scope, entry } = seed(database, "participant-authority", { sandboxMode: "off" });
    const identity = durableIdentity(database);
    const retained = { databaseIdentity: `file:${identity}`, sessionKey: scope.sessionKey, entry };
    const policy = retainPredicate({
      ...retained,
      matches: (before, after) =>
        before?.sessionId === after?.sessionId && before?.sandboxMode === after?.sandboxMode,
    });
    const participants = retainPredicate({
      ...retained,
      matches: (before, after) => before?.participantCount === after?.participantCount,
    });
    const publication = retainPublication({
      ...scope,
      databaseIdentity: identity,
    });
    publication.beginChanges(
      [scope.sessionKey],
      new Map(),
      [scope.sessionKey],
      new Map([
        [
          scope.sessionKey,
          { participants: [{ identity: { type: "agent", id: "other" } }], participantCount: 1 },
        ],
      ]),
    );
    const observations: boolean[] = [];
    const stop = onKey(scope.sessionKey, () =>
      observations.push(policy.isCurrent() && !participants.isCurrent()),
    );
    try {
      expect(policy.isCurrent()).toBe(true);
      expect(participants.isCurrent()).toBe(false);
      expect(
        await recordParticipant(scope, {
          identity: { type: "agent", id: "other" },
          promptedAt: 1,
        }),
      ).toBe("inserted");
      expect(policy.isCurrent()).toBe(true);
      expect(participants.canRefresh()).toBe(false);
      expect(observations.length).toBeGreaterThan(0);
      expect(observations.every(Boolean)).toBe(true);
      expect(readEntry(database, scope.sessionKey)?.entry.participantCount).toBe(1);
    } finally {
      stop();
      publication.settle(undefined, false);
      policy.release();
      participants.release();
    }
  });
});

it.each([
  { successor: "metadata", authorityChanged: false, acquiring: false },
  { successor: "metadata", authorityChanged: true, acquiring: false },
  { successor: "member", authorityChanged: true, acquiring: false },
  { successor: "metadata", authorityChanged: false, acquiring: true },
  { successor: "metadata", authorityChanged: true, acquiring: true },
  { successor: "member", authorityChanged: true, acquiring: true },
] as const)(
  "keeps newer $successor facts when an older replacement settles (authority changed=$authorityChanged, acquiring=$acquiring)",
  async ({ successor, authorityChanged, acquiring }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const { scope } = seed(database, "late-replacement", {
        category: "shared",
        sandboxMode: "off",
      });
      addSessionMember(scope, { identityId: "member", addedBy: "owner", addedAt: 1 });
      const identity = durableIdentity(database);
      const entry = readEntry(database, scope.sessionKey)!.entry;
      const retained = {
        databaseIdentity: `file:${identity}`,
        sessionKey: scope.sessionKey,
        entry,
      };
      const predicate = retainPredicate({
        ...retained,
        acquiring,
        matches: (before, after) =>
          before?.sessionId === after?.sessionId && before?.sandboxMode === after?.sandboxMode,
      });
      const revision = predicate.captureRevision();
      const generation = retainGeneration(retained);
      const sharing = retainSharing({
        ...retained,
        membership: new Set(["member"]),
      });
      delivery.afterResult = () => {
        if (successor === "member") {
          addSessionMember(scope, { identityId: "later-member", addedBy: "owner", addedAt: 2 });
        } else {
          replaceSessionEntrySync(scope, {
            ...readEntry(database, scope.sessionKey)!.entry,
            label: "newer commit",
            sandboxMode: authorityChanged ? undefined : "off",
          });
        }
      };
      try {
        await replaceFields(scope, {
          label: "older commit",
          sandboxMode: successor === "member" ? undefined : "off",
        });
        expect(readEntry(database, scope.sessionKey)?.entry.label).toBe(
          successor === "member" ? "older commit" : "newer commit",
        );
        if (!authorityChanged) {
          expect(predicate.readRetainedEntry()?.label).toBe("newer commit");
        }
        if (acquiring) {
          expect(predicate.acknowledge(entry, revision)).toBe(!authorityChanged);
        }
        expect(predicate.isCurrent()).toBe(!authorityChanged);
        expect(generation.readCurrent()).toMatchObject({ sessionId: entry.sessionId });
        expect(sharing.readCurrent()).toMatchObject({
          entry: { sessionId: entry.sessionId, category: "shared" },
          membership: new Set(successor === "member" ? ["member", "later-member"] : ["member"]),
        });
      } finally {
        delivery.afterResult = undefined;
        predicate.release();
        generation.release();
        sharing.release();
      }
    });
  },
);

it("fences every retained reader after a native installer fails, including older pending receipts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const { scope } = seed(database, "failed-native", { sessionId: "before" });
    const identity = durableIdentity(database);
    const entry = readEntry(database, scope.sessionKey)!.entry;
    const params = {
      databaseIdentity: `file:${identity}`,
      sessionKey: scope.sessionKey,
      entry,
    };
    const failed = retainPredicate({
      ...params,
      matches() {
        throw new Error("unavailable comparator");
      },
    });
    const sibling = retainPredicate({
      ...params,
      matches: (before, after) => before?.sessionId === after?.sessionId,
    });
    const generation = retainGeneration(params);
    const acquiring = retainSharing({
      databaseIdentity: params.databaseIdentity,
      sessionKey: scope.sessionKey,
      acquiring: true,
    });
    const older = retainPublication({
      ...scope,
      databaseIdentity: identity,
    });
    older.begin([scope.sessionKey], []);
    try {
      replaceSessionEntrySync(scope, { sessionId: "after", updatedAt: 2 });
      expect(readEntry(database, scope.sessionKey)?.entry.sessionId).toBe("after");
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

it("preserves a replacement receipt across another session's transcript notification", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const { scope: access } = seed(database, "late-watermark", {
      activitySummary: {
        version: 1,
        text: "Empty transcript",
        updatedAt: 1,
        sessionId: "late-watermark",
        generation: null,
        maxSeq: null,
        leafEntryId: null,
        coveredMessages: 0,
        totalMessages: 0,
        omittedContent: false,
      },
    });
    const scope = { ...access, sessionId: "late-watermark" };
    const { published, stop } = captureEntry(scope.sessionKey);
    delivery.afterResult = () => {
      emitSessionTranscriptUpdate({
        target: {
          ...scope,
          sessionKey: "agent:main:another-transcript",
          sessionId: "another-transcript",
        },
      });
    };
    try {
      await replaceFields(scope, { label: "committed" });
      expect(published()?.entry?.label).toBe("committed");
      expect(published()?.projection).toMatchObject({
        hasBoard: false,
        activitySummaryWatermark: { generation: null, maxSeq: null },
      });
    } finally {
      delivery.afterResult = undefined;
      stop();
    }
  });
});

it.each(["before preparation", "before settlement", "during facts delivery"] as const)(
  "publishes revocation before observers with a member write %s",
  async (boundary) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const { scope } = seed(database, "compact-receipt", { category: "before" });
      const identity = {
        type: "remote",
        pluginId: "test-channel",
        domain: "workspace",
        idKind: "user",
        id: "before",
      } as const;
      recordSessionParticipant(scope, {
        identity,
        promptedAt: 1,
      });
      addSessionMember(scope, { identityId: "revoked", addedBy: "owner", addedAt: 1 });
      const source = readOpenClawAgentDatabaseIdentity(database);
      assert(typeof source.identity === "string", "Expected durable predicate fixture");
      const predicate = retainPredicate({
        databaseIdentity: `file:${source.identity}`,
        sessionKey: scope.sessionKey,
        entry: readEntry(database, scope.sessionKey)!.entry,
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
      const stopObserver = onKey(scope.sessionKey, () => observed.push(read()));
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
        await replaceFields(scope, { category: "after" });
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
                participants: [{ identity: { ...identity, id: "after" } }],
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
    const stopRebind = onKey(
      alias,
      (change) => {
        if (change.facts?.kind === "removed") {
          reboundDuringFacts = true;
          projection.updateTargets([{ ...reboundTarget, storePath: database.path }]);
        }
      },
      "subscribeFacts",
    );
    const stopFacts = sessionChanges.subscribeFacts((change) => projection.invalidate(change));
    const observed: Array<readonly string[] | undefined> = [];
    const stopObserver = onKey(alias, () =>
      observed.push(projection.membership(database.path, alias)),
    );
    try {
      await projection.prepare();
      expect(projection.membership(rebound.path, alias)).toEqual(["rebound-member"]);
      await replaceCanonical({
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
      expect(readEntry(database, alias)).toBeUndefined();
      expect(readEntry(rebound, alias)?.entry.sessionId).toBe("rebound-generation");
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
      const { scope } = seed(database, "failed-install", { category: "before" });
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
      const stopObserver = onKey(scope.sessionKey, () =>
        observed.push(projection.ready(database.path, scope.sessionKey)),
      );
      try {
        await projection.prepare();
        replaceSessionEntrySync(scope, {
          sessionId: "failed-install",
          updatedAt: 2,
          category: "after",
        });
        expect(readEntry(database, scope.sessionKey)?.entry.category).toBe("after");
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
