import { describe, expect, it, vi } from "vitest";
import {
  readSessionTranscriptMessageEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.native.js";
import { addSessionSuggestion } from "../../config/sessions/session-suggestion-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { getSessionSuggestionTestMocks } from "./sessions-suggestions.test-mocks.js";
import {
  call,
  client,
  context,
  registerSessionSuggestionTestLifecycle,
  sessionKey,
  upsertDefaultSuggestionSession,
} from "./sessions-suggestions.test-support.js";

const mocks = getSessionSuggestionTestMocks();
registerSessionSuggestionTestLifecycle(mocks);
// Register shared mocks before the handlers capture their presence dependency.
const { sessionSuggestionHandlers } = await import("./sessions-suggestions.js");

describe("session suggestion visibility and role ceilings", () => {
  it("retains committed suggestion visibility through a tentative role relaxation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const owner = ensureProfileForEmail("policy-suggestion-owner@example.test");
      const reader = ensureProfileForEmail("policy-suggestion-reader@example.test");
      const requestClient = client(reader.id, "Reader");
      requestClient.connect.scopes = ["operator.sessions.read"];
      prepareGatewayRecipientProfile(requestClient);
      const policy = (others: "view" | "write"): OpenClawConfig => ({
        gateway: {
          roles: {
            default: "reader",
            definitions: {
              reader: { scopes: ["operator.sessions.read"], agents: "*", sessions: { others } },
            },
          },
        },
      });
      const runtime = policy("write");
      let committed = policy("view");
      await state.writeConfig(runtime);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "policy-suggestions",
          updatedAt: 1,
          visibility: "suggest",
          createdActor: { type: "human", source: "profile", id: owner.id },
        },
      );
      for (const [id, authorId] of [
        ["own-idea", reader.id],
        ["other-idea", owner.id],
      ] as const) {
        addSessionSuggestion(
          { agentId: "main", sessionKey },
          {
            id,
            authorId,
            text: id,
            expectedSessionId: "policy-suggestions",
          },
        );
      }
      const requestContext = createDirectChatContext({
        getRuntimeConfig: () => runtime,
        getCommittedRuntimeConfig: () => committed,
      });
      for (const phase of ["tentative", "committed"] as const) {
        if (phase === "committed") {
          committed = runtime;
        }
        const respond = vi.fn();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: phase,
            method: "session.suggestions.list",
            params: { sessionKey },
          },
          client: requestClient,
          context: requestContext,
          respond,
          isWebchatConnect: () => true,
          extraHandlers: sessionSuggestionHandlers,
        });
        expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
          role: phase === "tentative" ? "viewer" : "member",
          suggestions:
            phase === "tentative"
              ? [expect.objectContaining({ id: "own-idea" })]
              : expect.arrayContaining([
                  expect.objectContaining({ id: "own-idea" }),
                  expect.objectContaining({ id: "other-idea" }),
                ]),
        });
      }
    });
  });

  it("lets a suggest viewer add and list only their own suggestion", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertDefaultSuggestionSession();
      const alice = client("alice", "Alice");
      const add = await call(
        "session.suggestions.add",
        { sessionKey: "main", text: "  Try the focused fix\n" },
        alice,
      );
      expect(add.responses[0]?.[0]).toBe(true);
      expect(add.responses[0]?.[1]).toMatchObject({
        suggestion: {
          author: { id: "alice", label: "Alice" },
          text: "  Try the focused fix\n",
          state: "pending",
        },
      });
      expect(add.context.broadcast).toHaveBeenCalledWith(
        "session.suggestion",
        expect.objectContaining({ action: "added" }),
        expect.objectContaining({ sessionKeys: [sessionKey, "main"] }),
      );
      expect(
        readSessionTranscriptMessageEvents({ agentId: "main", sessionId: "session-main" }),
      ).toEqual([]);

      await call(
        "session.suggestions.add",
        { sessionKey, text: "Bob's idea" },
        client("bob", "Bob"),
      );
      const listed = await call("session.suggestions.list", { sessionKey }, alice);
      expect(listed.responses[0]?.[1]).toMatchObject({
        role: "viewer",
        suggestions: [{ author: { id: "alice" }, text: "  Try the focused fix\n" }],
      });
    });
  });

  it("enforces view, suggest, and hidden role ceilings while honoring explicit membership", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const ownerProfile = ensureProfileForEmail("suggestion-owner@example.test");
      const guestProfile = ensureProfileForEmail("suggestion-guest@example.test");
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-main",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: ownerProfile.id },
          visibility: "suggest",
        },
      );
      const guest = client(guestProfile.id, "Guest");
      const roleConfig = (others: "none" | "view" | "suggest"): OpenClawConfig => ({
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              guest: {
                sessions: { others },
                agents: "*",
                scopes: ["operator.read", "operator.write"],
              },
            },
          },
        },
      });

      const denied = await call(
        "session.suggestions.add",
        { sessionKey, text: "view-only suggestion" },
        guest,
        context(vi.fn(), roleConfig("view")),
      );
      expect(denied.responses[0]?.[2]).toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining("viewing sessions only"),
      });

      const hidden = await call(
        "session.suggestions.list",
        { sessionKey },
        guest,
        context(vi.fn(), roleConfig("none")),
      );
      expect(hidden.responses[0]?.[2]).toMatchObject({
        code: "INVALID_REQUEST",
        message: `unknown session: ${sessionKey}`,
      });

      const suggested = await call(
        "session.suggestions.add",
        { sessionKey, text: "permitted suggestion" },
        guest,
        context(vi.fn(), roleConfig("suggest")),
      );
      expect(suggested.responses[0]?.[0]).toBe(true);

      addSessionMember(
        { agentId: "main", sessionKey },
        {
          identityId: guestProfile.id,
          addedBy: ownerProfile.id,
          expectedSessionId: "session-main",
        },
      );
      const invited = await call(
        "session.suggestions.add",
        { sessionKey, text: "explicitly invited member" },
        guest,
        context(vi.fn(), roleConfig("view")),
      );
      expect(invited.responses[0]?.[0]).toBe(true);
    });
  });

  it("hides draft suggestions from members while owner and admin can list", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const draftKey = "agent:main:draft-suggestions";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: draftKey },
        {
          sessionId: "session-draft",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: "owner" },
          visibility: "draft",
        },
      );
      addSessionMember(
        { agentId: "main", sessionKey: draftKey },
        { identityId: "member", addedBy: "owner", expectedSessionId: "session-draft" },
      );
      addSessionSuggestion(
        { agentId: "main", sessionKey: draftKey },
        {
          id: "draft-suggestion",
          authorId: "member",
          text: "private draft suggestion",
          expectedSessionId: "session-draft",
        },
      );

      const member = client("member", "Member");
      const expectHiddenDraft = (result: Awaited<ReturnType<typeof call>>) => {
        expect(result.responses[0]?.[0]).toBe(false);
        expect(result.responses[0]?.[1]).toBeUndefined();
        expect(result.responses[0]?.[2]).toMatchObject({
          message: "session is draft for this connection",
          details: {
            code: "SESSION_PARTICIPATION_REQUIRED",
            sessionKey: draftKey,
            visibility: "draft",
          },
        });
      };

      expectHiddenDraft(await call("session.suggestions.list", { sessionKey: draftKey }, member));
      expectHiddenDraft(
        await call("session.suggestions.add", { sessionKey: draftKey, text: "leak draft" }, member),
      );
      expectHiddenDraft(
        await call(
          "session.suggestions.resolve",
          { sessionKey: draftKey, id: "draft-suggestion", resolution: "dismiss" },
          member,
        ),
      );
      expect(
        (
          await call(
            "session.typing",
            { sessionKey: draftKey, sessionId: "session-draft", typing: true },
            member,
          )
        ).responses[0]?.[1],
      ).toEqual({ ok: true, broadcast: false });

      const ownerList = await call(
        "session.suggestions.list",
        { sessionKey: draftKey },
        client("owner", "Owner"),
      );
      expect(ownerList.responses[0]?.[1]).toMatchObject({
        role: "owner",
        suggestions: [{ id: "draft-suggestion", text: "private draft suggestion" }],
      });
      const adminList = await call(
        "session.suggestions.list",
        { sessionKey: draftKey },
        client("admin", "Admin", true),
      );
      expect(adminList.responses[0]?.[1]).toMatchObject({
        role: "admin",
        suggestions: [{ id: "draft-suggestion", text: "private draft suggestion" }],
      });
    });
  });

  it("keeps incognito suggestion and typing surfaces admin-only", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.useFakeTimers();
      const incognitoKey = "agent:main:dashboard:incognito-suggestions";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: incognitoKey },
        {
          sessionId: "session-incognito",
          updatedAt: 1,
          incognito: true,
          createdActor: { type: "human", source: "profile", id: "owner" },
          visibility: "suggest",
        },
      );
      addSessionSuggestion(
        { agentId: "main", sessionKey: incognitoKey },
        {
          id: "incognito-suggestion",
          authorId: "owner",
          text: "private suggestion",
          expectedSessionId: "session-incognito",
        },
      );
      const owner = client("owner", "Owner");
      const expectHidden = (result: Awaited<ReturnType<typeof call>>) => {
        expect(result.responses[0]?.[0]).toBe(false);
        expect(result.responses[0]?.[1]).toBeUndefined();
        expect(result.responses[0]?.[2]?.message).toBe(
          `Incognito session "${incognitoKey}" was not found.`,
        );
      };

      expectHidden(await call("session.suggestions.list", { sessionKey: incognitoKey }, owner));
      expectHidden(
        await call("session.suggestions.add", { sessionKey: incognitoKey, text: "probe" }, owner),
      );
      expectHidden(
        await call(
          "session.suggestions.resolve",
          { sessionKey: incognitoKey, id: "incognito-suggestion", resolution: "dismiss" },
          owner,
        ),
      );
      expectHidden(
        await call(
          "session.typing",
          { sessionKey: incognitoKey, sessionId: "wrong-session", typing: true },
          owner,
        ),
      );
      expectHidden(
        await call(
          "session.typing",
          { sessionKey: incognitoKey, sessionId: "session-incognito", typing: true },
          owner,
        ),
      );

      const adminList = await call(
        "session.suggestions.list",
        { sessionKey: incognitoKey },
        client("admin", "Admin", true),
      );
      expect(adminList.responses[0]?.[1]).toMatchObject({
        role: "admin",
        suggestions: [{ id: "incognito-suggestion", text: "private suggestion" }],
      });

      mocks.presence = ["admin", "other-admin"].map((id) => ({
        user: { id, identity: { type: "profile", id } },
        watchedSessions: [incognitoKey],
      }));
      const broadcast = vi.fn();
      const typingContext = context(broadcast);
      const admin = client("admin", "Admin", true);
      const typeDraft = (preview: string) =>
        call(
          "session.typing",
          { sessionKey: incognitoKey, sessionId: "session-incognito", typing: true, preview },
          admin,
          typingContext,
        );
      expect((await typeDraft("first private draft")).responses[0]?.[1]).toEqual({
        ok: true,
        broadcast: true,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect((await typeDraft("latest private draft")).responses[0]?.[1]).toEqual({
        ok: true,
        broadcast: false,
      });
      await vi.advanceTimersByTimeAsync(150);
      expect(broadcast).toHaveBeenCalledTimes(2);
      expect(broadcast.mock.lastCall?.[1]).toMatchObject({
        sessionKey: incognitoKey,
        sessionId: "session-incognito",
        preview: "latest private draft",
      });
    });
  });
});
