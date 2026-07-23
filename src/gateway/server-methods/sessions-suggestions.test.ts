import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionSuggestionHandlers } from "./sessions-suggestions.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({
  appendSessionAudit: vi.fn(async () => undefined),
  handleChatSend: vi.fn(),
  presence: [] as Array<{
    user?: { id: string; name?: string };
    watchedSessions?: string[];
  }>,
}));

vi.mock("./chat-send-handler.js", () => ({ handleChatSend: mocks.handleChatSend }));
vi.mock("./session-audit.js", () => ({ appendSessionAudit: mocks.appendSessionAudit }));
vi.mock("../../infra/system-presence.js", () => ({
  listSystemPresence: () => mocks.presence,
}));

const sessionKey = "agent:main:main";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function client(profileId: string, displayName: string, admin = false): GatewayClient {
  return {
    connId: `conn-${profileId}`,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
        instanceId: `instance-${profileId}`,
      },
      role: "operator",
      scopes: admin ? ["operator.admin"] : ["operator.read", "operator.write"],
    },
    authenticatedUserId: `${profileId}@example.com`,
    authenticatedUserProfile: {
      profileId,
      displayName,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

function context(broadcast = vi.fn()): GatewayRequestContext {
  return {
    getRuntimeConfig: () => ({}),
    broadcast,
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
    logGateway: { warn: vi.fn() },
  } as unknown as GatewayRequestContext;
}

async function call(
  method:
    | "session.suggestions.add"
    | "session.suggestions.list"
    | "session.suggestions.resolve"
    | "session.typing",
  params: Record<string, unknown>,
  requestClient: GatewayClient | null,
  requestContext = context(),
) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionSuggestionHandlers[method]?.({
    req: { type: "req", id: "request-1", method, params },
    params,
    client: requestClient,
    context: requestContext,
    isWebchatConnect: () => true,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  });
  return { responses, context: requestContext };
}

function responseSuggestionId(result: Awaited<ReturnType<typeof call>>): string {
  const payload = result.responses[0]?.[1] as { suggestion?: { id?: string } } | undefined;
  if (!payload?.suggestion?.id) {
    throw new Error("suggestion response id missing");
  }
  return payload.suggestion.id;
}

beforeEach(() => {
  mocks.appendSessionAudit.mockClear();
  mocks.handleChatSend.mockReset();
  mocks.handleChatSend.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
    respond(true, { runId: "suggestion-run", status: "started" });
  });
  mocks.presence = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
});

describe("session suggestion handlers", () => {
  it("lets a suggest viewer add and list only their own suggestion", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-main",
          updatedAt: 1,
          createdActor: { type: "human", id: "owner" },
          visibility: "suggest",
        },
      );
      const alice = client("alice", "Alice");
      const add = await call(
        "session.suggestions.add",
        { sessionKey, text: "Try the focused fix" },
        alice,
      );
      expect(add.responses[0]?.[0]).toBe(true);
      expect(add.responses[0]?.[1]).toMatchObject({
        suggestion: {
          author: { id: "alice", label: "Alice" },
          text: "Try the focused fix",
          state: "pending",
        },
      });
      expect(mocks.appendSessionAudit).not.toHaveBeenCalled();

      await call(
        "session.suggestions.add",
        { sessionKey, text: "Bob's idea" },
        client("bob", "Bob"),
      );
      const listed = await call("session.suggestions.list", { sessionKey }, alice);
      expect(listed.responses[0]?.[1]).toMatchObject({
        role: "viewer",
        suggestions: [{ author: { id: "alice" }, text: "Try the focused fix" }],
      });
    });
  });

  it.each([
    ["send", "steer"],
    ["queue", "followup"],
  ] as const)(
    "dispatches %s through chat.send with suggested-by attribution",
    async (resolution, queueMode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await upsertSessionEntry(
          { agentId: "main", sessionKey },
          {
            sessionId: "session-main",
            updatedAt: 1,
            createdActor: { type: "human", id: "owner" },
            visibility: "suggest",
          },
        );
        const added = await call(
          "session.suggestions.add",
          { sessionKey, text: "Ship the focused change" },
          client("alice", "Alice"),
        );
        const id = responseSuggestionId(added);

        const resolved = await call(
          "session.suggestions.resolve",
          { sessionKey, id, resolution },
          client("owner", "Owner"),
        );
        expect(resolved.responses[0]?.[0]).toBe(true);
        expect(mocks.handleChatSend).toHaveBeenCalledWith(
          expect.objectContaining({
            params: expect.objectContaining({
              message: "Ship the focused change",
              queueMode,
            }),
            client: expect.objectContaining({
              authenticatedUserProfile: expect.objectContaining({
                profileId: "alice",
                displayName: "Suggested by Alice",
              }),
            }),
          }),
        );
      });
    },
  );

  it("allows only owners and admins to resolve suggestions", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-main",
          updatedAt: 1,
          createdActor: { type: "human", id: "owner" },
          visibility: "suggest",
        },
      );
      const added = await call(
        "session.suggestions.add",
        { sessionKey, text: "Edit me" },
        client("alice", "Alice"),
      );
      const id = responseSuggestionId(added);
      const viewer = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "dismiss" },
        client("viewer", "Viewer"),
      );
      expect(viewer.responses[0]?.[0]).toBe(false);

      addSessionMember(
        { agentId: "main", sessionKey },
        { identityId: "member", addedBy: "owner", expectedSessionId: "session-main" },
      );
      const member = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "edit" },
        client("member", "Member"),
      );
      expect(member.responses[0]?.[0]).toBe(false);
      const owner = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "edit" },
        client("owner", "Owner"),
      );
      expect(owner.responses[0]?.[0]).toBe(true);
      expect(mocks.handleChatSend).not.toHaveBeenCalled();
    });
  });

  it("keeps typing dormant for one identity and broadcasts for two live viewers", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      let now = 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-main",
          updatedAt: 1,
          createdActor: { type: "human", id: "owner" },
          visibility: "suggest",
        },
      );
      const broadcast = vi.fn();
      const requestContext = context(broadcast);
      mocks.presence = [{ user: { id: "alice" }, watchedSessions: [sessionKey] }];
      const solo = await call(
        "session.typing",
        { sessionKey, typing: true },
        client("alice", "Alice"),
        requestContext,
      );
      expect(solo.responses[0]?.[1]).toEqual({ ok: true, broadcast: false });
      expect(broadcast).not.toHaveBeenCalled();

      mocks.presence.push({ user: { id: "owner" }, watchedSessions: [sessionKey] });
      const collaborative = await call(
        "session.typing",
        { sessionKey, typing: true },
        client("alice", "Alice"),
        requestContext,
      );
      expect(collaborative.responses[0]?.[1]).toEqual({ ok: true, broadcast: true });
      expect(broadcast).toHaveBeenCalledWith(
        "session.typing",
        expect.objectContaining({ actor: { type: "human", id: "alice", label: "Alice" } }),
        expect.objectContaining({ sessionKeys: [sessionKey], dropIfSlow: true }),
      );

      now = 1_100;
      const earlyStop = await call(
        "session.typing",
        { sessionKey, typing: false },
        client("alice", "Alice"),
        requestContext,
      );
      expect(earlyStop.responses[0]?.[1]).toEqual({ ok: true, broadcast: true });
      now = 1_300;
      const stop = await call(
        "session.typing",
        { sessionKey, typing: false },
        client("alice", "Alice"),
        requestContext,
      );
      expect(stop.responses[0]?.[1]).toEqual({ ok: true, broadcast: false });
      now = 1_400;
      const earlyRestart = await call(
        "session.typing",
        { sessionKey, typing: true },
        client("alice", "Alice"),
        requestContext,
      );
      expect(earlyRestart.responses[0]?.[1]).toEqual({ ok: true, broadcast: false });

      mocks.presence = [
        { user: { id: "owner" }, watchedSessions: [sessionKey] },
        { user: { id: "bob" }, watchedSessions: [sessionKey] },
      ];
      now = 3_000;
      const notViewing = await call(
        "session.typing",
        { sessionKey, typing: true },
        client("mallory", "Mallory"),
        requestContext,
      );
      expect(notViewing.responses[0]?.[1]).toEqual({ ok: true, broadcast: false });

      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-main",
          updatedAt: 2,
          createdActor: { type: "human", id: "owner" },
          visibility: "shared",
        },
      );
      mocks.presence = [
        { user: { id: "shared-alice" }, watchedSessions: [sessionKey] },
        { user: { id: "owner" }, watchedSessions: [sessionKey] },
      ];
      now = 4_000;
      const sharedViewer = await call(
        "session.typing",
        { sessionKey, typing: true },
        client("shared-alice", "Shared Alice"),
        requestContext,
      );
      expect(sharedViewer.responses[0]?.[1]).toEqual({ ok: true, broadcast: true });
    });
  });

  it("returns structured errors for blank text and clientless dispatch", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-main",
          updatedAt: 1,
          createdActor: { type: "human", id: "owner" },
          visibility: "suggest",
        },
      );
      const blank = await call(
        "session.suggestions.add",
        { sessionKey, text: "   " },
        client("alice", "Alice"),
      );
      expect(blank.responses[0]?.[0]).toBe(false);
      expect(blank.responses[0]?.[2]?.message).toMatch(/text is required/);

      const added = await call(
        "session.suggestions.add",
        { sessionKey, text: "send me" },
        client("alice", "Alice"),
      );
      const dispatch = await call(
        "session.suggestions.resolve",
        { sessionKey, id: responseSuggestionId(added), resolution: "send" },
        null,
      );
      expect(dispatch.responses[0]?.[0]).toBe(false);
      expect(dispatch.responses[0]?.[2]?.message).toMatch(/connected client required/);
      const listed = await call(
        "session.suggestions.list",
        { sessionKey },
        client("owner", "Owner"),
      );
      expect(listed.responses[0]?.[1]).toMatchObject({
        suggestions: [{ state: "pending", text: "send me" }],
      });
    });
  });

  it("responds once when a typing target is unknown", async () => {
    const unknown = await call(
      "session.typing",
      { sessionKey: "agent:main:missing", typing: true },
      client("alice", "Alice"),
    );
    expect(unknown.responses).toHaveLength(1);
    expect(unknown.responses[0]?.[0]).toBe(false);
    expect(unknown.responses[0]?.[2]?.message).toMatch(/unknown session/);
    const unknownAdd = await call(
      "session.suggestions.add",
      { sessionKey: "agent:main:missing", text: "hello" },
      null,
    );
    expect(unknownAdd.responses).toHaveLength(1);
    expect(unknownAdd.responses[0]?.[0]).toBe(false);
  });

  it("restores a suggestion when chat dispatch throws", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-main",
          updatedAt: 1,
          createdActor: { type: "human", id: "owner" },
          visibility: "suggest",
        },
      );
      const added = await call(
        "session.suggestions.add",
        { sessionKey, text: "retry me" },
        client("alice", "Alice"),
      );
      mocks.handleChatSend.mockRejectedValueOnce(new Error("dispatch exploded"));
      const resolved = await call(
        "session.suggestions.resolve",
        { sessionKey, id: responseSuggestionId(added), resolution: "send" },
        client("owner", "Owner"),
      );
      expect(resolved.responses[0]?.[0]).toBe(false);
      expect(resolved.responses[0]?.[2]?.message).toBe("dispatch exploded");
      const listed = await call(
        "session.suggestions.list",
        { sessionKey },
        client("owner", "Owner"),
      );
      expect(listed.responses[0]?.[1]).toMatchObject({
        suggestions: [{ state: "pending", text: "retry me" }],
      });
    });
  });

  it("claims a pending suggestion before dispatching it", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-main",
          updatedAt: 1,
          createdActor: { type: "human", id: "owner" },
          visibility: "suggest",
        },
      );
      const added = await call(
        "session.suggestions.add",
        { sessionKey, text: "only once" },
        client("alice", "Alice"),
      );
      const id = responseSuggestionId(added);
      const gate = createDeferred<void>();
      mocks.handleChatSend.mockImplementationOnce(async ({ respond }: { respond: RespondFn }) => {
        await gate.promise;
        respond(true, { runId: "suggestion-run", status: "started" });
      });
      const first = call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "send" },
        client("owner", "Owner"),
      );
      await vi.waitFor(() => expect(mocks.handleChatSend).toHaveBeenCalledTimes(1));
      const duplicate = await call(
        "session.suggestions.resolve",
        { sessionKey, id, resolution: "dismiss" },
        client("owner", "Owner"),
      );
      expect(duplicate.responses[0]?.[0]).toBe(false);
      expect(duplicate.responses[0]?.[2]?.message).toMatch(/already in progress/);
      gate.resolve();
      expect((await first).responses[0]?.[0]).toBe(true);
      expect(mocks.handleChatSend).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps an identity typing until its last active connection stops", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      let now = 10_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-main",
          updatedAt: 1,
          createdActor: { type: "human", id: "owner" },
          visibility: "shared",
        },
      );
      mocks.presence = [
        { user: { id: "multi" }, watchedSessions: [sessionKey] },
        { user: { id: "owner" }, watchedSessions: [sessionKey] },
      ];
      const broadcast = vi.fn();
      const requestContext = context(broadcast);
      const tabOne = { ...client("multi", "Multi"), connId: "multi-tab-1" };
      const tabTwo = { ...client("multi", "Multi"), connId: "multi-tab-2" };

      expect(
        (await call("session.typing", { sessionKey, typing: true }, tabOne, requestContext))
          .responses[0]?.[1],
      ).toEqual({ ok: true, broadcast: true });
      now = 10_100;
      expect(
        (await call("session.typing", { sessionKey, typing: true }, tabTwo, requestContext))
          .responses[0]?.[1],
      ).toEqual({ ok: true, broadcast: false });
      now = 10_400;
      expect(
        (await call("session.typing", { sessionKey, typing: false }, tabOne, requestContext))
          .responses[0]?.[1],
      ).toEqual({ ok: true, broadcast: false });
      now = 10_500;
      expect(
        (await call("session.typing", { sessionKey, typing: false }, tabTwo, requestContext))
          .responses[0]?.[1],
      ).toEqual({ ok: true, broadcast: true });
      expect(broadcast.mock.calls.map((broadcastCall) => broadcastCall[1].typing)).toEqual([
        true,
        false,
      ]);
    });
  });
});
