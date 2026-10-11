import "./session-accessor.sqlite-replacement-publication.test-support.js";
import { expect, it } from "vitest";
import { createSessionRowProjection } from "../../gateway/session-row-projection.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readPreparedSessionEntryChange } from "./session-accessor.sqlite-entry-cache-publication.js";
import {
  projectSessionSharingEntry,
  retainPreparedSessionSharingFacts,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { applySessionEntryCanonicalReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import { addSessionMember } from "./session-sharing-store.native.js";

const { getReplacementPublicationDelivery } =
  await import("./session-accessor.sqlite-replacement-publication.test-support.js");
const delivery = getReplacementPublicationDelivery();

it.each([false, true])(
  "publishes rehomed membership while preserving newer native metadata (%s)",
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
        recordSessionParticipant(
          { agentId: "main", storePath: database.path, sessionKey: key },
          {
            identity: {
              type: "remote",
              pluginId: "test-channel",
              domain: "workspace",
              idKind: "user",
              id: identityId,
            },
            promptedAt: key === sessionKey ? 1 : 2,
          },
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
      let published: ReturnType<typeof readPreparedSessionEntryChange>;
      const stop = sessionChanges.subscribeFacts((change) => {
        if ("sessionKey" in change && change.sessionKey === sessionKey) {
          published = readPreparedSessionEntryChange(change, sessionKey);
        }
      });
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
        expect(sharing.readCurrent()).toEqual(
          newerNative
            ? undefined
            : {
                entry: projectSessionSharingEntry(entry),
                membership: new Set(["alias-member", "target-member"]),
              },
        );
        if (!newerNative) {
          expect(published?.entry).toMatchObject({
            participants: ["target-member", "alias-member"].map((id) => ({
              identity: {
                type: "remote",
                pluginId: "test-channel",
                domain: "workspace",
                idKind: "user",
                id,
              },
            })),
            participantCount: 2,
          });
        }
      } finally {
        delivery.afterResult = undefined;
        stop();
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
          expect(seen[0]).toEqual({
            native: true,
            sessionId: "newer-alias-generation",
            sharingId: "newer-alias-generation",
          });
          for (const observation of seen) {
            expect([undefined, "newer-alias-generation"]).toContain(observation.sessionId);
            expect([undefined, "newer-alias-generation"]).toContain(observation.sharingId);
          }
        } else {
          expect(seen).toEqual([{ native: false, sessionId: undefined, sharingId: undefined }]);
        }
        await projection.ensureMaterialized();
        const expected = recreated ? "newer-alias-generation" : undefined;
        expect(projection.capture(query)?.storedEntry?.sessionId).toBe(expected);
        expect(projection.sharingTarget(query)?.entry.sessionId).toBe(expected);
        expect(readExactSessionEntryRow(database, alias)?.entry.sessionId).toBe(expected);
      } finally {
        stop();
        projection.dispose();
      }
    });
  },
);
