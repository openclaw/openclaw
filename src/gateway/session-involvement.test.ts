// Complete cold handler transforms during collection, before timed visibility RPCs.
import "./server-methods/sessions-mutations.js";
import { describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { projectPublicSessionEntry } from "../config/sessions/session-entry-projection.js";
import * as involvementStore from "../config/sessions/session-involvement-store.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { linkEmail } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { readMentionStoreSnapshot } from "./mention-inbox-store.worker.js";
import {
  SESSION_KEY,
  SESSION_ID,
  withMentionInbox as withInbox,
  readMentionInbox as read,
  dismissMentionInbox as dismiss,
} from "./mention-inbox.test-support.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import { listSessionFixture } from "./session-list.test-support.js";

describe("personal session involvement", () => {
  it("includes a mentioned recipient without recording an authored contribution", async () => {
    await withInbox(async (f) => {
      const scope = { agentId: "main", sessionKey: SESSION_KEY };
      const list = async (profileId = f.bob.id, involving = true) => {
        const entry = loadSessionEntry(scope)!;
        expect(projectPublicSessionEntry(entry)).not.toHaveProperty("profileInvolvement");
        expect(entry.participants).toBeUndefined();
        return await listSessionFixture({
          cfg: { agents: { entries: { main: {} } } },
          storePath: "",
          store: { [SESSION_KEY]: entry },
          // Inbox expiry is independent of the session archive-age policy.
          opts: { archived: "all" },
          ...(involving ? { involvingActorId: profileId } : { ownerFirstActorId: profileId }),
        });
      };
      expect((await list()).sessions).toEqual([]);
      await f.post();
      expect((await list()).sessions.map((row) => row.key)).toEqual([SESSION_KEY]);
      const items = (await read(f.inbox, f.bobClient)).items;
      await dismiss(
        f.inbox,
        f.bobClient,
        items.map((item) => item.id),
      );
      expect((await list()).sessions.map((row) => row.key)).toEqual([SESSION_KEY]);
      const setHidden = async (hidden: boolean) => {
        const sql = observeHostDataSql();
        try {
          const result = await f.call("sessions.setInvolvement", {
            key: SESSION_KEY,
            expectedSessionId: SESSION_ID,
            hidden,
          });
          expect(
            sql.queries.filter((query) =>
              /\b(?:insert\s+into|update|delete\s+from)\s+["`]?session_nodes\b/i.test(query),
            ),
          ).toEqual([]);
          return result;
        } finally {
          sql.restore();
        }
      };
      expect((await setHidden(true)).ok).toBe(true);
      expect((await list()).sessions).toEqual([]);
      expect((await list(f.bob.id, false)).sessions[0]?.hiddenFromInvolvingMe).toBe(true);
      expect((await list(f.alice.id)).sessions).toHaveLength(1);
      await f.post();
      expect((await list()).sessions).toEqual([]);
      // A stale generic metadata replacement must not erase the personal choice.
      replaceSessionEntrySync(scope, {
        sessionId: SESSION_ID,
        updatedAt: Date.now(),
        displayName: "Renamed",
      });
      expect((await list()).sessions).toEqual([]);
      await f.clock.advanceBy(8 * 24 * 60 * 60_000);
      expect(readMentionStoreSnapshot(-1, openOpenClawStateDatabase().db)?.sources).toHaveLength(0);
      await f.inbox.dispose();
      const restarted = f.openInbox("after-retention");
      await f.post("source-one", {}, restarted);
      expect((await list()).sessions).toEqual([]);
      await f.post("fresh-mention", {}, restarted);
      expect((await list()).sessions.map((row) => row.key)).toEqual([SESSION_KEY]);
      expect((await setHidden(true)).ok).toBe(true);
      expect((await setHidden(false)).ok).toBe(true);
      expect((await list()).sessions).toHaveLength(1);
      // Reset retains the logical node; a fork must not inherit anyone's list choices.
      const previous = loadSessionEntry(scope)!;
      replaceSessionEntrySync(scope, { ...previous, sessionId: "reset-generation" });
      expect((await list()).sessions).toHaveLength(1);
      const forkScope = { ...scope, sessionKey: "agent:main:fork" };
      replaceSessionEntrySync(forkScope, { ...previous, sessionId: "fork-generation" });
      expect(loadSessionEntry(forkScope)).not.toHaveProperty("profileInvolvement");
    });
  });

  it("preserves existing metadata, personal choices and replay watermarks across cold reopen", async () => {
    await withInbox(async (f) => {
      const hiddenScope = { agentId: "main", sessionKey: SESSION_KEY };
      const shownScope = { agentId: "main", sessionKey: `${SESSION_KEY}-shown` };
      const untouchedScope = { agentId: "main", sessionKey: `${SESSION_KEY}-untouched` };
      const scopes = [hiddenScope, shownScope, untouchedScope];
      for (const [index, scope] of scopes.entries()) {
        await f.setSession(
          {
            sessionId: `${SESSION_ID}-${index}`,
            displayName: "Existing session",
            label: "keep-label",
            pinnedAt: 12345,
          },
          scope.sessionKey,
        );
      }
      const entries = () => scopes.map((scope) => loadSessionEntry(scope)!);
      const existing = entries();
      expect(existing.every((entry) => entry.profileInvolvement === undefined)).toBe(true);
      let inbox = f.inbox;
      const reopen = async () => {
        // One cold store cycle covers independent choices without repeating worker startup per row.
        await inbox.dispose();
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawAgentDatabasesForTest();
        await closeStateDatabaseForTest();
        inbox = f.openInbox("cold-reopen");
      };
      const post = (sourceId: string, index: number) =>
        f.post(
          sourceId,
          {
            sessionKey: scopes[index]!.sessionKey,
            sessionId: existing[index]!.sessionId,
          },
          inbox,
        );
      const setHidden = async (index: number, hidden: boolean) => {
        expect(
          (
            await f.call("sessions.setInvolvement", {
              key: scopes[index]!.sessionKey,
              expectedSessionId: existing[index]!.sessionId,
              hidden,
            })
          ).ok,
        ).toBe(true);
      };
      await post("before-restart", 0);
      await setHidden(0, true);
      await post("explicitly-shown", 1);
      await setHidden(1, true);
      await setHidden(1, false);
      const beforeClose = entries();
      await reopen();
      expect(entries()).toEqual(beforeClose);
      expect(entries()[0]!.profileInvolvement?.profiles[f.bob.id]?.hidden).toBe(true);
      expect(entries()[1]!.profileInvolvement?.profiles[f.bob.id]?.hidden).toBe(false);
      expect(entries()[2]).toEqual(existing[2]);
      await post("before-restart", 0);
      expect(entries()).toEqual(beforeClose);
      await post("after-restart", 0);
      const fresh = entries();
      expect(fresh[0]).toMatchObject(existing[0]!);
      expect(fresh[0]!.profileInvolvement?.profiles[f.bob.id]).toMatchObject({
        hidden: false,
        lastMention: {
          generation:
            beforeClose[0]!.profileInvolvement!.profiles[f.bob.id]!.lastMention!.generation,
          sequence: 3,
        },
      });
      expect(fresh.slice(1)).toEqual(beforeClose.slice(1));
      await reopen();
      expect(entries()).toEqual(fresh);
    });
  });

  it("withholds a fresh Inbox alert when the involvement writer refuses a changed entry", async () => {
    await withInbox(async (f) => {
      const scope = { agentId: "main", sessionKey: SESSION_KEY };
      await f.post("existing");
      await involvementStore.updateSessionProfileInvolvementAsync(scope, {
        expectedSessionId: SESSION_ID,
        profileIds: [f.bob.id],
        change: { kind: "visibility", hidden: true },
      });
      const before = loadSessionEntry(scope)?.profileInvolvement;
      f.push.mockClear();
      const record = involvementStore.updateSessionProfileInvolvementAsync;
      let accepted: boolean | undefined;
      const changed = vi
        .spyOn(involvementStore, "updateSessionProfileInvolvementAsync")
        .mockImplementationOnce(async (...args) => {
          // Both shapes remain shared, but the captured raw entry no longer matches.
          await f.setSession({ visibility: undefined });
          accepted = await record(...args);
          return accepted;
        });
      try {
        await f.post("refused");
        expect(accepted).toBe(false);
        expect(loadSessionEntry(scope)?.profileInvolvement).toEqual(before);
        expect((await read(f.inbox, f.bobClient)).items.map((item) => item.messageId)).toEqual([
          "message-existing",
        ]);
        expect(f.push).not.toHaveBeenCalled();
      } finally {
        changed.mockRestore();
      }
    });
  });

  it("rejects personal hide requests for another identity or stale/inaccessible sessions", async () => {
    await withInbox(async (f) => {
      const params = { key: SESSION_KEY, expectedSessionId: SESSION_ID, hidden: true };
      expect(
        (await f.call("sessions.setInvolvement", { ...params, profileId: f.alice.id })).ok,
      ).toBe(false);
      expect(
        (await f.call("sessions.setInvolvement", { ...params, expectedSessionId: "stale" })).ok,
      ).toBe(false);
      expect(
        (
          await f.call("sessions.setInvolvement", params, {
            ...f.bobClient,
            internal: { syntheticClient: true },
          })
        ).ok,
      ).toBe(false);
      await f.setSession({ visibility: "draft" });
      expect((await f.call("sessions.setInvolvement", params)).ok).toBe(false);
      await f.setSession({ incognito: true });
      expect((await f.call("sessions.setInvolvement", params)).ok).toBe(false);
      expect(loadSessionEntry({ agentId: "main", sessionKey: SESSION_KEY })).not.toHaveProperty(
        "profileInvolvement",
      );
    });
  });

  it("does not let a personal show choice change another viewer's involvement query", async () => {
    await withInbox(async (f) => {
      const list = async (personal: boolean) =>
        listSessionFixture({
          cfg: { agents: { entries: { main: {} } } },
          storePath: "",
          store: { [SESSION_KEY]: loadSessionEntry({ agentId: "main", sessionKey: SESSION_KEY })! },
          opts: personal
            ? {}
            : { profileRelation: { profileId: f.bob.id, relationship: "involving" } },
          ...(personal ? { involvingActorId: f.bob.id } : { ownerFirstActorId: f.alice.id }),
        });
      for (const hidden of [true, false, true]) {
        expect(
          (
            await f.call("sessions.setInvolvement", {
              key: SESSION_KEY,
              expectedSessionId: SESSION_ID,
              hidden,
            })
          ).ok,
        ).toBe(true);
        expect((await list(true)).sessions).toHaveLength(hidden ? 0 : 1);
        expect((await list(false)).sessions).toEqual([]);
      }
    });
  });

  it.each([true, false])(
    "keeps merged visibility separate from mention evidence (both mentioned: %s)",
    async (bothMentioned) => {
      await withInbox(async (f) => {
        const old = ensureProfileForEmail("previous@mentions.example.test");
        const oldClient = { ...identifiedClient(old.id, "Previous"), connId: "previous" };
        await f.post("old-mention", { recipientProfileIds: [old.id] });
        if (bothMentioned) {
          await f.post("existing-current-profile-mention");
        }
        expect(
          (
            await f.call(
              "sessions.setInvolvement",
              { key: SESSION_KEY, expectedSessionId: SESSION_ID, hidden: true },
              bothMentioned ? oldClient : f.bobClient,
            )
          ).ok,
        ).toBe(true);
        linkEmail("previous@mentions.example.test", f.bob.id);
        const list = async (personal = true) =>
          listSessionFixture({
            cfg: { agents: { entries: { main: {} } } },
            storePath: "",
            store: {
              [SESSION_KEY]: loadSessionEntry({ agentId: "main", sessionKey: SESSION_KEY })!,
            },
            opts: personal
              ? {}
              : { profileRelation: { profileId: f.bob.id, relationship: "involving" } },
            ...(personal ? { involvingActorId: f.bob.id } : { ownerFirstActorId: f.alice.id }),
          });
        expect((await list()).sessions).toEqual([]);
        expect((await list(false)).sessions).toHaveLength(1);
        if (bothMentioned) {
          await f.post("existing-current-profile-mention");
        }
        expect((await list()).sessions).toEqual([]);
        await f.post("new-mention");
        expect((await list()).sessions).toHaveLength(1);
      });
    },
  );
});
