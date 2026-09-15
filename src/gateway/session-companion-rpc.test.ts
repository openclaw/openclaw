import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayErrorDetailCodes } from "../../packages/gateway-protocol/src/index.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { SessionCompanionAskError } from "./session-companion-ask.js";
import { defaultSessionCompanionContextReader } from "./session-companion-context.js";
import { sessionCompanionHandlers } from "./session-companion-rpc.js";
import { createSessionCompanion } from "./session-companion.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

async function invoke(
  method: keyof typeof sessionCompanionHandlers,
  params: unknown,
  companion: {
    ask?: ReturnType<typeof vi.fn>;
    state?: ReturnType<typeof vi.fn>;
    reset?: ReturnType<typeof vi.fn>;
  },
  client: { connId?: string } = { connId: "conn-1" },
  signal?: AbortSignal,
  config: Record<string, unknown> = { agents: { list: [{ id: "main" }] } },
  isConnectionActive?: (connId: string) => boolean,
) {
  const respond = vi.fn();
  await sessionCompanionHandlers[method]?.({
    params,
    client,
    context: {
      sessionCompanion: companion,
      getRuntimeConfig: () => config,
      ...(isConnectionActive ? { isConnectionActive } : {}),
    },
    respond,
    signal,
  } as never);
  return respond;
}

describe("session companion RPC", () => {
  it("dispatches a valid ask and returns its timestamp", async () => {
    const ask = vi.fn(async () => ({ answer: "It is checking the fix.", ts: 123 }));
    const respond = await invoke(
      "sessions.companion.ask",
      { sessionKey: "agent:main:main", question: "What is happening?" },
      { ask },
    );

    expect(ask).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:main",
      question: "What is happening?",
      connId: "conn-1",
      authorize: expect.any(Function),
    });
    expect(respond).toHaveBeenCalledWith(true, {
      answer: "It is checking the fix.",
      ts: 123,
    });
  });

  it("forwards the authenticated request lifetime and emits one final response", async () => {
    const controller = new AbortController();
    const ask = vi.fn(async () => ({ answer: "Bound to this connection.", ts: 124 }));
    const respond = await invoke(
      "sessions.companion.ask",
      { sessionKey: "agent:main:main", question: "Who owns this ask?" },
      { ask },
      { connId: "conn-1" },
      controller.signal,
    );

    expect(ask).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:main",
      question: "Who owns this ask?",
      connId: "conn-1",
      authorize: expect.any(Function),
      signal: controller.signal,
    });
    expect(respond.mock.calls).toEqual([[true, { answer: "Bound to this connection.", ts: 124 }]]);
  });

  it("revokes the live authorization predicate after the requesting connection closes", async () => {
    let connectionActive = true;
    const ask = vi.fn(
      async (params: { authorize?: () => boolean }): Promise<{ answer: string; ts: number }> => {
        connectionActive = false;
        if (params.authorize?.() === false) {
          throw new SessionCompanionAskError("session-missing", "Side chat is unavailable.");
        }
        return { answer: "Must not be returned.", ts: 125 };
      },
    );
    const respond = await invoke(
      "sessions.companion.ask",
      { sessionKey: "agent:main:main", question: "Is the requester still connected?" },
      { ask },
      { connId: "conn-1" },
      undefined,
      { agents: { list: [{ id: "main" }] } },
      () => connectionActive,
    );

    expect(ask).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        details: expect.objectContaining({ reason: "session-missing" }),
      }),
    );
  });

  it.each([
    {},
    { sessionKey: "", question: "why" },
    { sessionKey: "agent:main:main", question: "" },
    { sessionKey: "agent:main:main", question: "why", extra: true },
  ])("rejects invalid ask params %#", async (params) => {
    const ask = vi.fn();
    const respond = await invoke("sessions.companion.ask", params, { ask });
    expect(ask).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("requires a connected client for asks", async () => {
    const ask = vi.fn();
    const respond = await invoke(
      "sessions.companion.ask",
      { sessionKey: "agent:main:main", question: "Why?" },
      { ask },
      {},
    );
    expect(ask).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });

  it("returns the typed retryable busy detail", async () => {
    const ask = vi.fn(async () => {
      throw new SessionCompanionAskError("busy", "Already answering.");
    });
    const respond = await invoke(
      "sessions.companion.ask",
      { sessionKey: "agent:main:main", question: "Why?" },
      { ask },
    );
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: true,
        details: { code: GatewayErrorDetailCodes.SESSION_COMPANION_BUSY },
      }),
    );
  });

  it("returns a retryable typed context-read failure", async () => {
    const ask = vi.fn(async () => {
      throw new SessionCompanionAskError(
        "context-unavailable",
        "The selected session history could not be loaded.",
      );
    });
    const respond = await invoke(
      "sessions.companion.ask",
      { sessionKey: "agent:main:main", question: "Why?" },
      { ask },
    );
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: true,
        details: { reason: "context-unavailable" },
      }),
    );
  });

  it("returns and validates per-session state", async () => {
    const state = vi.fn(() => ({
      exchanges: [{ question: "Why?", answer: "Because.", ts: 10 }],
    }));
    const respond = await invoke(
      "sessions.companion.state",
      { sessionKey: "agent:main:main" },
      { state },
    );
    expect(state).toHaveBeenCalledWith({ agentId: "main", sessionKey: "agent:main:main" });
    expect(respond).toHaveBeenCalledWith(true, {
      exchanges: [{ question: "Why?", answer: "Because.", ts: 10 }],
    });

    const invalid = await invoke("sessions.companion.state", {}, { state });
    expect(invalid).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it.each(["sessions.companion.ask", "sessions.companion.state"] as const)(
    "hides a foreign draft before dispatching %s",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const cfg = rolePolicyConfig();
        const owner = ensureProfileForEmail("owner@example.test");
        const viewer = roleClient("view", "foreign-viewer");
        viewer.connId = "foreign-viewer-connection";
        await upsertSessionEntryCore(
          {
            agentId: "main",
            sessionKey: "agent:main:owner-private",
          },
          {
            sessionId: "owner-private-session",
            updatedAt: 1,
            visibility: "draft",
            createdActor: { type: "human", source: "profile", id: owner.id },
          },
        );
        const ask = vi.fn(async () => ({ answer: "private", ts: 1 }));
        const state = vi.fn(() => ({ exchanges: [] }));
        const respond = await invoke(
          method,
          {
            sessionKey: "agent:main:owner-private",
            ...(method === "sessions.companion.ask" ? { question: "What is private?" } : {}),
          },
          { ask, state },
          viewer,
          undefined,
          cfg,
        );

        expect(ask).not.toHaveBeenCalled();
        expect(state).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
      });
    },
  );

  it("fails closed for an unresolved session under a roles boundary", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = rolePolicyConfig();
      const viewer = roleClient("view", "viewer");
      viewer.connId = "viewer-connection";
      const ask = vi.fn(async () => ({ answer: "missing", ts: 1 }));
      const respond = await invoke(
        "sessions.companion.ask",
        { sessionKey: "agent:main:missing", question: "What is here?" },
        { ask },
        viewer,
        undefined,
        cfg,
      );

      expect(ask).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    });
  });

  it.each([
    { visibility: "shared" as const, caller: "viewer" as const },
    { visibility: "draft" as const, caller: "owner" as const },
  ])("allows $caller companion reads for a $visibility session", async ({ visibility, caller }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = rolePolicyConfig();
      const owner = ensureProfileForEmail("owner@example.test");
      const viewer = roleClient("view", "foreign-viewer");
      const client = caller === "owner" ? roleClient("view", "owner") : viewer;
      client.connId = `${caller}-connection`;
      const scope = {
        agentId: "main",
        sessionId: `${visibility}-session`,
        sessionKey: `agent:main:${visibility}-session`,
      };
      await upsertSessionEntryCore(scope, {
        sessionId: `${visibility}-session`,
        updatedAt: 1,
        visibility,
        createdActor: { type: "human", source: "profile", id: owner.id },
      });
      await persistSessionTranscriptTurn(scope, {
        messages: [
          {
            eventId: `${visibility}-context`,
            parentId: null,
            message: { role: "user", content: "VISIBLE_CONTEXT=blue-orchid", timestamp: 1 },
          },
        ],
        touchSessionEntry: true,
      });
      const run = vi.fn(
        async (_params: { messages: Array<{ content: string }> }) => "Authorized answer.",
      );
      const service = createSessionCompanion({
        getConfig: () => cfg,
        contextReader: defaultSessionCompanionContextReader,
        sessionObserver: { getCompanionSnapshot: () => ({ agentId: "main", notes: [] }) },
        resolveUtilityModelRef: () => "test-provider/test-model",
        run,
        now: () => 100,
      });
      const ask = vi.fn(service.ask);
      try {
        const respond = await invoke(
          "sessions.companion.ask",
          { sessionKey: scope.sessionKey, question: "What is visible?" },
          { ask },
          client,
          undefined,
          cfg,
        );

        expect(ask).toHaveBeenCalledOnce();
        expect(run).toHaveBeenCalledOnce();
        expect(run.mock.calls[0]?.[0].messages[0]?.content).toContain(
          "VISIBLE_CONTEXT=blue-orchid",
        );
        expect(respond).toHaveBeenCalledWith(true, { answer: "Authorized answer.", ts: 100 });
      } finally {
        service.dispose();
      }
    });
  });

  it("withholds the answer after persisted visibility is revoked at the model boundary", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = rolePolicyConfig();
      const owner = ensureProfileForEmail("owner@example.test");
      const viewer = roleClient("view", "foreign-viewer");
      viewer.connId = "viewer-connection";
      const scope = {
        agentId: "main",
        sessionId: "revoked-session",
        sessionKey: "agent:main:revoked-session",
      };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: owner.id },
      });
      await persistSessionTranscriptTurn(scope, {
        messages: [
          {
            eventId: "revoked-context",
            parentId: null,
            message: { role: "user", content: "REVOCATION_CONTEXT=redacted", timestamp: 1 },
          },
        ],
        touchSessionEntry: true,
      });
      const run = vi.fn(async (params: { authorize?: () => boolean }) => {
        await upsertSessionEntryCore(scope, {
          sessionId: scope.sessionId,
          updatedAt: 2,
          visibility: "draft",
          createdActor: { type: "human", source: "profile", id: owner.id },
        });
        expect(params.authorize?.()).toBe(false);
        return "Must not be returned.";
      });
      const service = createSessionCompanion({
        getConfig: () => cfg,
        contextReader: defaultSessionCompanionContextReader,
        sessionObserver: { getCompanionSnapshot: () => ({ agentId: "main", notes: [] }) },
        resolveUtilityModelRef: () => "test-provider/test-model",
        run,
        now: () => 100,
      });
      try {
        const respond = await invoke(
          "sessions.companion.ask",
          { sessionKey: scope.sessionKey, question: "What is visible?" },
          { ask: vi.fn(service.ask) },
          viewer,
          undefined,
          cfg,
        );

        expect(run).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "UNAVAILABLE",
            details: expect.objectContaining({ reason: "session-missing" }),
          }),
        );
        expect(service.state(scope)).toEqual({ exchanges: [] });
      } finally {
        service.dispose();
      }
    });
  });

  it("resets and validates one session thread", async () => {
    const reset = vi.fn();
    const respond = await invoke(
      "sessions.companion.reset",
      { sessionKey: "agent:main:main" },
      { reset },
    );
    expect(reset).toHaveBeenCalledWith({ agentId: "main", sessionKey: "agent:main:main" });
    expect(respond).toHaveBeenCalledWith(true, { ok: true });

    const invalid = await invoke(
      "sessions.companion.reset",
      { sessionKey: "agent:main:main", extra: true },
      { reset },
    );
    expect(invalid).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("threads an explicit owner for a bare key and returns typed selection errors", async () => {
    const config = { agents: { ownership: "explicit", list: [{ id: "main" }, { id: "work" }] } };
    const state = vi.fn(() => ({ exchanges: [] }));
    const selected = await invoke(
      "sessions.companion.state",
      { sessionKey: "global", agentId: "work" },
      { state },
      undefined,
      undefined,
      config,
    );
    expect(state).toHaveBeenCalledWith({ agentId: "work", sessionKey: "global" });
    expect(selected).toHaveBeenCalledWith(true, { exchanges: [] });

    state.mockClear();
    const ambiguous = await invoke(
      "sessions.companion.state",
      { sessionKey: "global" },
      { state },
      undefined,
      undefined,
      config,
    );
    expect(state).not.toHaveBeenCalled();
    expect(ambiguous).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
