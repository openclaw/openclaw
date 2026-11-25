import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import type { SessionMentionInvitation } from "./session-sharing-authority.types.js";
import { readSessionMembersInWorker, removeSessionMember } from "./session-sharing-store.js";

function fixture() {
  setRuntimeConfigSnapshot({});
  const scope = { agentId: "main", sessionKey: "agent:main:invitations", sessionId: "invitations" };
  const entry = {
    sessionId: scope.sessionId,
    updatedAt: 1,
    createdActor: { type: "human", source: "profile", id: "alice" } as const,
  };
  const message = (profileId: string) => ({
    role: "user" as const,
    content: `@${profileId} please review`,
    timestamp: 1,
    idempotencyKey: `mention:${profileId}`,
    __openclaw: { humanMentions: [{ profileId, start: 0, end: profileId.length + 1 }] },
  });
  const invitation = (profileId: string): SessionMentionInvitation => ({
    addedBy: "alice",
    expectedEntry: {
      sessionId: scope.sessionId,
      createdActor: entry.createdActor,
      visibility: undefined,
      incognito: undefined,
    },
    profiles: [{ profileId, aliases: [profileId], tokens: [`@${profileId}`] }],
  });
  const members = async () => (await readSessionMembersInWorker(scope)).members;
  return { scope, entry, message, invitation, members };
}

it.each([false, true])(
  "commits a tag and its invitation together before any Inbox work, without regranting on reopen (first: %s)",
  async (first) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      if (!first) {
        replaceSessionEntrySync(f.scope, f.entry);
      }
      const prepare = vi.fn(() => ({ invitation: f.invitation("bob"), assertCurrent() {} }));
      const post = (initialize = first) =>
        persistSessionTranscriptTurn(f.scope, {
          expectedSessionId: f.scope.sessionId,
          ...(initialize ? { initialSessionEntry: f.entry } : {}),
          messages: [
            { message: f.message("bob"), workerPreparation: { prepareMentionInvitation: prepare } },
          ],
          updateMode: "none",
        });
      const committed = await post();
      expect(committed.messages).toMatchObject([{ appended: true }]);
      expect(await f.members()).toEqual([
        expect.objectContaining({ identityId: "bob", addedBy: "alice" }),
      ]);
      const anchor = committed.messages[0]!.anchor!;
      expect(loadSessionEntry(f.scope)?.profileInvolvement?.profiles.bob?.lastMention).toEqual({
        generation: anchor.generation,
        sequence: anchor.rawSeq,
        timestamp: 1,
      });
      await removeSessionMember(f.scope, "bob", undefined, f.scope.sessionId);
      await closeOpenClawAgentDatabasesAsync();
      prepare.mockImplementation(() => {
        throw new Error("Old recipient is no longer eligible");
      });
      expect((await post(false)).messages).toMatchObject([{ appended: false }]);
      expect(await f.members()).toEqual([]);
      expect(
        (await loadTranscriptEvents(f.scope)).filter(
          (event) => isRecord(event) && event.type === "message",
        ),
      ).toHaveLength(1);
    });
  },
);

it.each([false, true])(
  "rolls back the tag, grant and watermark when commit authority changes (first: %s)",
  async (first) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      if (!first) {
        replaceSessionEntrySync(f.scope, f.entry);
      }
      const failure = new Error("Invitation authority changed");
      let current = true;
      const observe = probe.admission(admission, (request, grant, callback) => {
        if (request.stage === "commit") {
          current = false;
        }
        callback(request, grant);
      });
      try {
        await expect(
          persistSessionTranscriptTurn(f.scope, {
            expectedSessionId: f.scope.sessionId,
            ...(first ? { initialSessionEntry: f.entry } : {}),
            messages: [
              {
                message: f.message("bob"),
                workerPreparation: {
                  prepareMentionInvitation: () => ({
                    invitation: f.invitation("bob"),
                    assertCurrent() {
                      if (!current) {
                        throw failure;
                      }
                    },
                  }),
                },
              },
            ],
            updateMode: "none",
          }),
        ).rejects.toBe(failure);
      } finally {
        observe.mockRestore();
      }
      expect(current).toBe(false);
      expect(await f.members()).toEqual([]);
      expect(await loadTranscriptEvents(f.scope)).toEqual([]);
      expect(loadSessionEntry(f.scope)?.profileInvolvement).toBeUndefined();
      if (first) {
        expect(loadSessionEntry(f.scope)).toBeUndefined();
      }
    });
  },
);

it("keeps each first-session message's own watermark when invitations are deferred until session creation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const recipients = ["bob", "carol"];
    const committed = await persistSessionTranscriptTurn(f.scope, {
      expectedSessionId: f.scope.sessionId,
      initialSessionEntry: f.entry,
      messages: recipients.map((id) => ({
        message: f.message(id),
        workerPreparation: {
          prepareMentionInvitation: () => ({ invitation: f.invitation(id), assertCurrent() {} }),
        },
      })),
      updateMode: "none",
    });
    expect(committed.messages).toMatchObject([{ appended: true }, { appended: true }]);
    expect((await f.members()).map((member) => member.identityId).toSorted()).toEqual(recipients);
    const profiles = loadSessionEntry(f.scope)!.profileInvolvement!.profiles;
    for (const [index, id] of recipients.entries()) {
      expect(profiles[id]!.lastMention!.sequence).toBe(committed.messages[index]!.anchor!.rawSeq);
    }
    expect(profiles.bob!.lastMention!.sequence).toBeLessThan(profiles.carol!.lastMention!.sequence);
  });
});

it("does not grant access when a message hook removes the selected token", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    replaceSessionEntrySync(f.scope, f.entry);
    const committed = await persistSessionTranscriptTurn(f.scope, {
      expectedSessionId: f.scope.sessionId,
      messages: [
        {
          message: f.message("bob"),
          workerPreparation: {
            prepareMessageAfterIdempotencyCheck: () => ({
              ...f.message("bob"),
              content: "[redacted]",
            }),
            prepareMentionInvitation: () => ({
              invitation: f.invitation("bob"),
              assertCurrent() {},
            }),
          },
        },
      ],
      updateMode: "none",
    });
    expect(committed.messages).toMatchObject([{ appended: true }]);
    expect(await f.members()).toEqual([]);
    expect(loadSessionEntry(f.scope)?.profileInvolvement).toBeUndefined();
  });
});

it.each(["commit", "rollback"] as const)(
  "releases invitation callbacks and closes admissions after %s",
  async (outcome) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      replaceSessionEntrySync(f.scope, f.entry);
      const create = admission.createSqliteWorkerOperationAdmission;
      const owners: ReturnType<typeof create>[] = [];
      const transactionOwners = new Set<ReturnType<typeof create>>();
      let current = true;
      let prepared = 0;
      const failure = new Error("Invitation authority changed");
      // Observe real admissions without replacing their grant or settlement decisions.
      const observe = vi
        .spyOn(admission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit, attachment, prepare) => {
          const owner = create(
            (request, grant) => {
              if (request.stage === "transaction" || request.stage === "commit") {
                transactionOwners.add(owner);
              }
              if (request.stage === "commit" && outcome === "rollback") {
                current = false;
              }
              admit(request, grant);
            },
            attachment,
            prepare,
          );
          owners.push(owner);
          return owner;
        });
      async function settle() {
        const captured = { sentinel: "synthetic invitation callback" };
        const reference = new WeakRef(captured);
        const write = persistSessionTranscriptTurn(f.scope, {
          expectedSessionId: f.scope.sessionId,
          messages: [
            {
              message: f.message("bob"),
              workerPreparation: {
                prepareMentionInvitation: () => {
                  prepared++;
                  return {
                    invitation: f.invitation("bob"),
                    assertCurrent() {
                      expect(captured.sentinel).toBe("synthetic invitation callback");
                      if (!current) {
                        throw failure;
                      }
                    },
                  };
                },
              },
            },
          ],
          updateMode: "none",
        });
        if (outcome === "rollback") {
          await expect(write).rejects.toBe(failure);
        } else {
          await write;
        }
        return reference;
      }
      let reference: WeakRef<object>;
      try {
        reference = await settle();
      } finally {
        observe.mockRestore();
      }
      expect(prepared).toBe(1);
      expect(owners.length).toBeGreaterThan(0);
      for (const owner of owners) {
        expect(() => owner.observeRequests(() => {})).toThrow("closed");
      }
      // File-admission relays close without native work; only transaction owners publish settlement.
      expect(transactionOwners.size).toBeGreaterThan(0);
      for (const owner of transactionOwners) {
        expect(owner.settlement?.kind).toBe("completed");
      }
      const control = new WeakRef({});
      await nextTurn();
      queryObjects(WeakRef);
      expect(control.deref()).toBeUndefined();
      expect(reference.deref()).toBeUndefined();
      expect(
        (await loadTranscriptEvents(f.scope)).filter(
          (event) => isRecord(event) && event.type === "message",
        ),
      ).toHaveLength(outcome === "commit" ? 1 : 0);
      expect((await f.members()).map((member) => member.identityId)).toEqual(
        outcome === "commit" ? ["bob"] : [],
      );
      if (outcome === "rollback") {
        expect(loadSessionEntry(f.scope)?.profileInvolvement).toBeUndefined();
      }
    });
  },
);
