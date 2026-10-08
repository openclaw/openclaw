import "./session-accessor.sqlite-replacement-publication.test-support.js";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createSessionMembershipProjection } from "../../gateway/session-membership-projection.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  retainPreparedSessionEntryPredicate,
  retainPreparedSessionSharingFacts,
} from "./session-accessor.sqlite-entry-cache-publication-state.js";
import {
  readPreparedSessionEntryChange,
  retainSessionEntryWorkerPublication,
} from "./session-accessor.sqlite-entry-cache-publication.js";
import {
  projectSessionSharingEntry,
  type SessionEntryReplacementPublication,
} from "./session-accessor.sqlite-entry-cache.types.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { applySessionEntryExactReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import { readSessionTranscriptWatermarkInDatabase } from "./session-accessor.sqlite-transcript-watermark.js";
import { appendTranscriptEventSync } from "./session-accessor.sqlite-transcript-write.js";
import { readPreparedSessionParticipants } from "./session-participant-prepared-read.js";
import { addSessionMember, removeSessionMember } from "./session-sharing-store.native.js";

const { getReplacementPublicationDelivery } =
  await import("./session-accessor.sqlite-replacement-publication.test-support.js");
const delivery = getReplacementPublicationDelivery();

it("withholds a watermark receipt after a synchronous transcript append publishes", async () => {
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
    let published: ReturnType<typeof readPreparedSessionEntryChange>;
    const stop = sessionChanges.subscribeFacts((change) => {
      if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
        published = readPreparedSessionEntryChange(change, scope.sessionKey) ?? published;
      }
    });
    delivery.afterResult = (result) => {
      const receipt = (result as { publication: SessionEntryReplacementPublication }).publication;
      expect(receipt.projection?.get(scope.sessionKey)?.activitySummaryWatermark).toEqual({
        generation: null,
        maxSeq: null,
      });
      expect(appendTranscriptEventSync(scope, { type: "proof", id: "late-event" }).ok).toBe(true);
      emitSessionTranscriptUpdate({ target: scope });
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
      expect(published?.projection).toBeUndefined();
      expect(sharing.readCurrent()).toMatchObject({
        entry: { sessionId: scope.sessionId },
        membership: new Set(),
      });
      expect(readSessionTranscriptWatermarkInDatabase(database, scope.sessionId).maxSeq).toBe(0);
    } finally {
      delivery.afterResult = undefined;
      sharing.release();
      stop();
    }
  });
});

it.each(["before preparation", "before settlement"] as const)(
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
      const stopFacts = sessionChanges.subscribeFacts((change) => projection.invalidate(change));
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
        } else {
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
        expect(observed.length).toBeGreaterThan(0);
        expect(predicate.isCurrent()).toBe(false);
        expect(observed.every(({ membership }) => membership?.length === 0)).toBe(true);
        expect(projection.needsPreparation).toBe(boundary === "before settlement");
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

it.each(["lower revision", "retired incarnation", "partial", "unknown", "newer unknown"] as const)(
  "keeps replacement receipt coverage and ordering through %s delivery",
  async (boundary) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: "agent:main:ordered-receipt",
      };
      replaceSessionEntrySync(scope, {
        sessionId: "ordered-receipt",
        updatedAt: 1,
        category: "initial",
      });
      const source = readOpenClawAgentDatabaseIdentity(database);
      if (typeof source.identity !== "string") {
        throw new Error("Expected durable receipt fixture");
      }
      addSessionMember(scope, { identityId: "retained", addedBy: "owner", addedAt: 1 });
      const sharing = retainPreparedSessionSharingFacts({
        databaseIdentity: `file:${source.identity}`,
        sessionKey: scope.sessionKey,
        entry: projectSessionSharingEntry(
          readExactSessionEntryRow(database, scope.sessionKey)!.entry,
        ),
        membership: new Set(["retained"]),
      });
      const projection = createSessionMembershipProjection();
      projection.updateTargets([{ ...scope, ...source }]);
      let olderChange: SessionRowChange | undefined;
      let receipt: SessionEntryReplacementPublication | undefined;
      const stop = sessionChanges.subscribeFacts((change) => {
        projection.invalidate(change);
        if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
          olderChange ??= change;
        }
      });
      const delayed = retainSessionEntryWorkerPublication({
        ...scope,
        databaseIdentity: source.identity,
      });
      const replace = (category: string) =>
        applySessionEntryExactReplacements({
          storePath: database.path,
          sessionKeys: [scope.sessionKey],
          update: ([row]) => ({
            result: undefined,
            replacements: [{ sessionKey: scope.sessionKey, entry: { ...row!.entry, category } }],
          }),
        });
      try {
        await projection.prepare();
        delivery.afterResult = (result) => {
          // This callback receives the actual acknowledged replacement command result.
          receipt = (result as { publication: SessionEntryReplacementPublication }).publication;
        };
        await replace("older");
        delivery.afterResult = undefined;
        expect(receipt).toBeDefined();
        delayed.begin([scope.sessionKey], []);
        if (boundary === "newer unknown") {
          const newer = retainSessionEntryWorkerPublication({
            ...scope,
            databaseIdentity: source.identity,
          });
          newer.begin([scope.sessionKey], []);
          newer.settle(undefined, true);
          delayed.settle(receipt, false);
          expect(projection.ready(database.path, scope.sessionKey)).toBe(false);
          expect(projection.membership(database.path, scope.sessionKey)).toEqual([]);
          expect(sharing.readCurrent()).toBeUndefined();
          await projection.prepare();
          expect(projection.ready(database.path, scope.sessionKey)).toBe(true);
          return;
        }
        if (boundary === "partial" || boundary === "unknown") {
          delayed.settle(
            boundary === "partial" ? { ...receipt!, projection: undefined } : receipt,
            boundary === "unknown",
          );
          expect(projection.ready(database.path, scope.sessionKey)).toBe(false);
          expect(projection.membership(database.path, scope.sessionKey)).toEqual([]);
          expect(sharing.readCurrent()).toBeUndefined();
          await projection.prepare();
          expect([...projection.groupTargets().keys()]).toEqual(["older"]);
        } else {
          if (boundary === "retired incarnation") {
            await closeOpenClawAgentDatabaseByPathAsync(database.path);
          }
          await replace("newer");
          if (boundary === "lower revision") {
            expect(olderChange).toBeDefined();
            projection.invalidate(olderChange!);
          }
          delayed.settle(receipt, false);
          expect(projection.ready(database.path, scope.sessionKey)).toBe(true);
          expect([...projection.groupTargets().keys()]).toEqual(["newer"]);
        }
      } finally {
        delivery.afterResult = undefined;
        delayed.settle(undefined, false);
        stop();
        sharing.release();
        projection.dispose();
      }
    });
  },
);
