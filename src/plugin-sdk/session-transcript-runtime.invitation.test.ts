import { expect, it } from "vitest";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { readSessionMembersInWorker } from "../config/sessions/session-sharing-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { SessionManager } from "./agent-sessions.js";
import {
  appendSessionTranscriptMessageByIdentity,
  appendSessionTranscriptMessageByIdentityStrict,
  appendSessionTranscriptMessagesByIdentity,
  readSessionTranscriptEvents,
  withSessionTranscriptWrite,
  withSessionTranscriptWriteLock,
} from "./session-transcript-runtime.js";

it.each([
  "single",
  "strict",
  "batch",
  "sequence",
  "lock",
  "manager sync",
  "manager worker",
  "manager persist",
] as const)(
  "%s SDK appends cannot supply invitation authority through extra options",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "sdk-invitation",
        sessionKey: "agent:main:sdk-invitation",
        storePath: state.statePath("sessions.sqlite"),
      };
      const createdActor = { type: "human", source: "profile", id: "alice" } as const;
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        createdActor,
      });
      const message = {
        role: "user" as const,
        content: "@bob please review",
        timestamp: 2,
        __openclaw: { humanMentions: [{ profileId: "bob", start: 0, end: 4 }] },
      };
      const mentionInvitation = {
        addedBy: "alice",
        expectedEntry: { sessionId: scope.sessionId, createdActor },
        profiles: [{ profileId: "bob", aliases: ["bob"], tokens: ["@bob"] }],
      };
      const prepareMentionInvitation = () => ({
        invitation: mentionInvitation,
        assertCurrent: () => {},
      });
      // JavaScript callers can pass private-looking fields despite the public types.
      const options = {
        message,
        idempotencyLookup: "scan" as const,
        mentionInvitation,
        prepareMentionInvitation,
        workerPreparation: { prepareMentionInvitation },
      };
      if (mode === "single") {
        await appendSessionTranscriptMessageByIdentity({ ...scope, ...options });
      } else if (mode === "strict") {
        await appendSessionTranscriptMessageByIdentityStrict({ ...scope, ...options });
      } else if (mode === "batch") {
        await appendSessionTranscriptMessagesByIdentity({ ...scope, messages: [options] });
      } else if (mode === "manager sync") {
        const manager = SessionManager.open(scope, state.workspaceDir);
        manager.appendMessage(message, options);
      } else if (mode === "manager worker" || mode === "manager persist") {
        const manager = await SessionManager.openAsync(scope, state.workspaceDir);
        if (mode === "manager worker") {
          await manager.appendMessageAsync(message, options);
        } else {
          await manager.persistAsync(
            {
              type: "message",
              id: "sdk-user",
              parentId: null,
              timestamp: new Date(message.timestamp).toISOString(),
              message,
            },
            options,
          );
        }
      } else {
        const write = mode === "lock" ? withSessionTranscriptWriteLock : withSessionTranscriptWrite;
        await write(scope, (locked) => locked.appendMessage(options));
      }
      expect(await readSessionTranscriptEvents(scope)).toContainEqual(
        expect.objectContaining({ type: "message", message }),
      );
      expect((await readSessionMembersInWorker(scope)).members).toEqual([]);
      expect(loadSessionEntry(scope)?.profileInvolvement).toBeUndefined();
    });
  },
);
