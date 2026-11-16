import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PresenceEntry } from "../../../packages/gateway-protocol/src/schema/snapshot.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { dispatchAuthorizationRequest } from "../server-methods.authorization.test-support.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { clearSessionTypingState } from "./session-typing-state.js";
import {
  identifiedClient,
  initializeSessionReadContext,
} from "./sessions-read-cache.test-support.js";
import { sessionSuggestionHandlers } from "./sessions-suggestions.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({
  presence: [] as Array<Pick<PresenceEntry, "user" | "watchedSessions">>,
}));

function profileUser(id: string): NonNullable<PresenceEntry["user"]> {
  return { id, identity: { type: "profile", id } };
}

function client(profileId: string, connId: string): GatewayClient {
  const result = identifiedClient(profileId);
  result.connId = connId;
  result.connect.client.instanceId = connId;
  result.authenticatedUserId = `${profileId}@example.com`;
  return result;
}

function context(broadcast = vi.fn(), cfg: OpenClawConfig = {}): GatewayRequestContext {
  return {
    getRuntimeConfig: () => cfg,
    getPresenceSnapshot: () => mocks.presence,
    broadcast,
    broadcastToConnIds: vi.fn(),
    logGateway: { warn: vi.fn() },
  } as unknown as GatewayRequestContext;
}

async function callTyping(params: {
  sessionKey: string;
  sessionId: string;
  typing: boolean;
  preview?: string;
  cursor?: number;
  agentId?: string;
  client: GatewayClient;
  context: GatewayRequestContext;
  hasCurrentClientAuthority?: () => boolean;
}) {
  await initializeSessionReadContext(params.context);
  const responses: Parameters<RespondFn>[] = [];
  const requestParams = {
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    typing: params.typing,
    ...(params.preview !== undefined ? { preview: params.preview } : {}),
    ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
  };
  await sessionSuggestionHandlers["session.typing"]?.({
    req: { type: "req", id: "typing-request", method: "session.typing", params: requestParams },
    params: requestParams,
    client: params.client,
    context: params.context,
    hasCurrentClientAuthority: params.hasCurrentClientAuthority,
    isWebchatConnect: () => true,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  });
  return responses[0]?.[1];
}

async function sharedTypingSession(sessionKey: string, sessionId: string) {
  setRuntimeConfigSnapshot({});
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    {
      sessionId,
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: "owner" },
      visibility: "shared",
    },
  );
  mocks.presence = ["alice", "owner"].map((id) => ({
    user: profileUser(id),
    watchedSessions: [sessionKey],
  }));
  const broadcast = vi.fn();
  return { broadcast, params: { sessionKey, sessionId, context: context(broadcast) } };
}

beforeEach(() => {
  clearSessionTypingState();
  mocks.presence = [];
});

afterEach(() => {
  clearSessionTypingState();
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
});

describe("session typing handler", () => {
  it("admits session-only typing for its creator without granting foreign-session writes", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg = rolePolicyConfig();
      setRuntimeConfigSnapshot(cfg);
      const owner = roleClient("view", "typing-scoped-owner");
      const other = roleClient("write", "typing-scoped-other");
      owner.connect.scopes = ["operator.sessions.write"];
      other.connect.scopes = ["operator.sessions.write"];
      const sessionKey = "agent:main:typing-scoped";
      const sessionId = "typing-scoped";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId,
          updatedAt: 1,
          createdActor: {
            type: "human",
            source: "profile",
            id: owner.authenticatedUserProfile!.profileId,
          },
          visibility: "shared",
        },
      );
      mocks.presence = [owner, other].map((requestClient) => ({
        user: profileUser(requestClient.authenticatedUserProfile!.profileId),
        watchedSessions: [sessionKey],
      }));
      const broadcast = vi.fn();
      const requestContext = context(broadcast, cfg);
      await initializeSessionReadContext(requestContext);
      const request = (requestClient: GatewayClient, overrides: Record<string, unknown> = {}) =>
        dispatchAuthorizationRequest(
          "session.typing",
          {
            sessionKey,
            sessionId,
            typing: true,
            preview: "Owned guest draft",
            ...overrides,
          },
          {
            client: requestClient,
            context: requestContext,
            extraHandlers: sessionSuggestionHandlers,
          },
        );
      expect((await request(owner)).mock.calls[0]).toMatchObject([
        true,
        { ok: true, broadcast: true },
      ]);
      expect(broadcast.mock.lastCall?.[1]).toMatchObject({
        sessionKey,
        sessionId,
        preview: "Owned guest draft",
      });
      broadcast.mockClear();
      expect((await request(other)).mock.calls[0]).toMatchObject([
        true,
        { ok: true, broadcast: false },
      ]);
      owner.connect.scopes = ["operator.sessions.read"];
      expect((await request(owner)).mock.calls[0]).toMatchObject([
        false,
        undefined,
        { code: "FORBIDDEN" },
      ]);
      owner.connect.scopes = ["operator.sessions.write"];
      expect((await request(owner, { sessionId: "stale-session" })).mock.calls[0]).toMatchObject([
        true,
        { broadcast: false },
      ]);
      expect(broadcast).not.toHaveBeenCalled();
      const hidden = roleClient("none", "typing-scoped-hidden");
      hidden.connect.scopes = ["operator.sessions.write"];
      expect((await request(hidden)).mock.calls[0]).toMatchObject([
        false,
        undefined,
        { code: "INVALID_REQUEST", message: `Session "${sessionKey}" was not found.` },
      ]);
      expect(
        (await request(owner, { sessionKey: "agent:main:dashboard:incognito-typing" })).mock
          .calls[0],
      ).toMatchObject([
        false,
        undefined,
        {
          code: "INVALID_REQUEST",
          message: 'Incognito session "agent:main:dashboard:incognito-typing" was not found.',
        },
      ]);
      clearSessionTypingState();
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(30_000);
      await request(owner);
      await request(owner, { preview: "Pending draft must not escape revocation" });
      owner.connect.scopes = ["operator.sessions.read"];
      await vi.advanceTimersByTimeAsync(250);
      expect(broadcast).toHaveBeenCalledTimes(1);
    });
  });
  it.each([
    {
      name: "counts a same-id raw viewer separately from the profile actor",
      presence: [{ user: profileUser("shared") }, { user: { id: "shared" } }],
      expected: true,
    },
    {
      name: "does not let a raw viewer establish profile actor membership",
      presence: [{ user: { id: "shared" } }, { user: profileUser("other") }],
      expected: false,
    },
    {
      name: "counts multiple tabs of the profile actor once",
      presence: [{ user: profileUser("shared") }, { user: profileUser("shared") }],
      expected: false,
    },
  ])("$name", async ({ name, presence, expected }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const sessionKey = `agent:main:typing-namespace-${name.replaceAll(" ", "-")}`;
      const sessionId = "typing-namespace";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId,
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: "shared" },
          visibility: "shared",
        },
      );
      mocks.presence = presence.map((entry) => ({ ...entry, watchedSessions: [sessionKey] }));
      const broadcast = vi.fn();
      expect(
        await callTyping({
          sessionKey,
          sessionId,
          typing: true,
          preview: "draft preview",
          client: client("shared", "typing-namespace-actor"),
          context: context(broadcast),
        }),
      ).toEqual({ ok: true, broadcast: expected });
      if (expected) {
        expect(broadcast).toHaveBeenCalledExactlyOnceWith(
          "session.typing",
          expect.objectContaining({ actor: { type: "human", id: "shared", label: "shared" } }),
          expect.objectContaining({ sessionKeys: [sessionKey] }),
        );
      } else {
        expect(broadcast).not.toHaveBeenCalled();
      }
    });
  });

  it("broadcasts bounded draft previews and never includes previews after typing stops", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(30_000);
      const fixture = await sharedTypingSession("agent:main:preview", "session-preview");
      const { broadcast } = fixture;
      const params = { ...fixture.params, client: client("alice", "alice-preview") };

      expect(
        await callTyping({ ...params, typing: true, preview: "  first draft  ", cursor: 4 }),
      ).toEqual({
        ok: true,
        broadcast: true,
      });
      expect(broadcast.mock.calls[0]?.[1]).toMatchObject({
        typing: true,
        preview: "  first draft  ",
        cursor: 4,
      });

      await vi.advanceTimersByTimeAsync(50);
      await callTyping({ ...params, typing: true, preview: "superseded draft" });
      await vi.advanceTimersByTimeAsync(50);
      await callTyping({ ...params, typing: true, preview: "latest draft" });
      await vi.advanceTimersByTimeAsync(150);
      expect(broadcast.mock.calls.map((call) => call[1].preview)).toEqual([
        "  first draft  ",
        "latest draft",
      ]);
      await vi.advanceTimersByTimeAsync(50);
      await callTyping({ ...params, typing: true, preview: "after trailing edge" });
      expect(broadcast).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(200);
      expect(broadcast.mock.lastCall?.[1].preview).toBe("after trailing edge");

      const oversizedPreview = "😀".repeat(405);
      await vi.advanceTimersByTimeAsync(250);
      expect(
        await callTyping({ ...params, typing: true, preview: oversizedPreview, cursor: 800 }),
      ).toEqual({
        ok: true,
        broadcast: true,
      });
      expect(broadcast.mock.lastCall?.[1]).toMatchObject({
        preview: "😀".repeat(400),
        cursor: 800,
      });

      await callTyping({ ...params, typing: true, preview: oversizedPreview, cursor: 2 });
      await vi.advanceTimersByTimeAsync(250);
      expect(broadcast.mock.lastCall?.[1]).toMatchObject({ preview: "😀".repeat(400), cursor: 2 });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(await callTyping({ ...params, typing: false, preview: "must not leak" })).toEqual({
        ok: true,
        broadcast: true,
      });
      expect(broadcast.mock.lastCall?.[1]).toMatchObject({ typing: false });
      expect(broadcast.mock.lastCall?.[1]).not.toHaveProperty("preview");
      expect(broadcast.mock.lastCall?.[1]).not.toHaveProperty("cursor");
    });
  });

  it.each([undefined, "still drafting"])(
    "keeps per-connection drafts and activity until an identity's last connection stops (preview=%s)",
    async (preview) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        vi.useFakeTimers();
        vi.setSystemTime(40_000);
        const { broadcast, params } = await sharedTypingSession(
          "agent:main:shared-preview",
          "session-shared-preview",
        );
        const recordClientActivity = vi.fn();
        params.context.recordClientActivity = recordClientActivity;
        const previewTab = client("alice", "alice-preview-tab");
        const presenceTab = client("alice", "alice-presence-tab");
        expect(await callTyping({ ...params, typing: true, preview, client: previewTab })).toEqual({
          ok: true,
          broadcast: true,
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(await callTyping({ ...params, typing: true, client: presenceTab })).toEqual({
          ok: true,
          broadcast: false,
        });
        await vi.advanceTimersByTimeAsync(900);
        expect(broadcast.mock.lastCall?.[1]).toMatchObject({ typing: true });
        expect(broadcast.mock.lastCall?.[1].preview).toBe(preview);
        await vi.advanceTimersByTimeAsync(100);
        expect(await callTyping({ ...params, typing: false, client: previewTab })).toEqual({
          ok: true,
          broadcast: false,
        });
        await vi.advanceTimersByTimeAsync(900);
        expect(broadcast.mock.lastCall?.[1]).toMatchObject({ typing: true });
        expect(broadcast.mock.lastCall?.[1]).not.toHaveProperty("preview");
        await vi.advanceTimersByTimeAsync(100);
        expect(await callTyping({ ...params, typing: false, client: presenceTab })).toEqual({
          ok: true,
          broadcast: false,
        });
        await vi.advanceTimersByTimeAsync(900);
        expect(broadcast.mock.calls.map((call) => call[1].typing)).toEqual([
          true,
          true,
          true,
          false,
        ]);
        expect(recordClientActivity.mock.calls).toEqual([[previewTab], [presenceTab]]);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(recordClientActivity).toHaveBeenCalledTimes(2);
      });
    },
  );

  it.each([
    { state: "queued", delayMs: 100 },
    { state: "published", delayMs: 250 },
  ])(
    "replaces a stopped connection's $state preview with the live draft",
    async ({ state, delayMs }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        vi.useFakeTimers();
        vi.setSystemTime(50_000);
        const { broadcast, params } = await sharedTypingSession(
          `agent:main:stopped-${state}-preview`,
          `session-stopped-${state}-preview`,
        );
        const liveTab = client("alice", "live-tab");
        const stoppedTab = client("alice", "stopped-tab");
        await callTyping({ ...params, typing: true, preview: "live draft", client: liveTab });
        await vi.advanceTimersByTimeAsync(delayMs);
        await callTyping({ ...params, typing: true, preview: "stopped draft", client: stoppedTab });
        await vi.advanceTimersByTimeAsync(50);
        await callTyping({ ...params, typing: false, client: stoppedTab });
        const callsBeforeFlush = broadcast.mock.calls.length;
        await vi.advanceTimersByTimeAsync(250);

        expect(broadcast.mock.lastCall?.[1]).toMatchObject({ typing: true, preview: "live draft" });
        expect(
          broadcast.mock.calls.slice(callsBeforeFlush).map((call) => call[1].preview),
        ).not.toContain("stopped draft");
      });
    },
  );

  it.each([
    { agentId: "main", expected: ["agent:main:global"] },
    { agentId: "work", expected: ["agent:work:global"] },
  ])("uses the canonical global subscription keys for $agentId", async ({ agentId, expected }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = {
        agents: { entries: { main: {}, work: {} } },
      } satisfies OpenClawConfig;
      setRuntimeConfigSnapshot(cfg);
      await upsertSessionEntryCore(
        { agentId, sessionKey: "global" },
        {
          sessionId: `session-${agentId}`,
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: "owner" },
          visibility: "shared",
        },
      );
      mocks.presence = [
        { user: profileUser("alice"), watchedSessions: ["global"] },
        { user: profileUser("owner"), watchedSessions: ["global"] },
      ];
      const broadcast = vi.fn();

      expect(
        await callTyping({
          sessionKey: "global",
          sessionId: `session-${agentId}`,
          agentId,
          typing: true,
          client: client("alice", `alice-${agentId}`),
          context: context(broadcast, cfg),
        }),
      ).toEqual({ ok: true, broadcast: true });
      expect(broadcast).toHaveBeenCalledWith(
        "session.typing",
        expect.objectContaining({ agentId, sessionKey: "global" }),
        expect.objectContaining({ agentId, sessionKeys: expected }),
      );
    });
  });

  it("does not carry active connections across a session replacement", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      vi.useFakeTimers();
      vi.setSystemTime(15_000);
      const sessionKey = "agent:main:typing-instance";
      const writeSession = (sessionId: string, updatedAt: number) =>
        upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId,
            updatedAt,
            createdActor: { type: "human" as const, source: "profile" as const, id: "owner" },
            visibility: "shared" as const,
          },
        );
      await writeSession("session-before-reset", 1);
      mocks.presence = [
        { user: profileUser("alice"), watchedSessions: [sessionKey] },
        { user: profileUser("owner"), watchedSessions: [sessionKey] },
      ];
      const broadcast = vi.fn();
      const requestContext = context(broadcast);
      const oldTab = client("alice", "old-tab");
      const newTab = client("alice", "new-tab");

      expect(
        await callTyping({
          sessionKey,
          sessionId: "session-before-reset",
          typing: true,
          client: oldTab,
          context: requestContext,
        }),
      ).toEqual({ ok: true, broadcast: true });
      await writeSession("session-after-reset", 2);
      expect(
        await callTyping({
          sessionKey,
          sessionId: "session-before-reset",
          typing: true,
          client: oldTab,
          context: requestContext,
        }),
      ).toEqual({ ok: true, broadcast: false });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(
        await callTyping({
          sessionKey,
          sessionId: "session-after-reset",
          typing: true,
          client: newTab,
          context: requestContext,
        }),
      ).toEqual({ ok: true, broadcast: true });
      expect(broadcast.mock.calls[1]?.[1]).toMatchObject({
        sessionId: "session-after-reset",
        typing: true,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(
        await callTyping({
          sessionKey,
          sessionId: "session-after-reset",
          typing: false,
          client: newTab,
          context: requestContext,
        }),
      ).toEqual({ ok: true, broadcast: false });
      await vi.advanceTimersByTimeAsync(900);
      expect(broadcast.mock.calls.map((call) => call[1].typing)).toEqual([true, true, false]);
    });
  });

  it.each(["disconnected", "invalidated", "authority revoked", "sharing withdrawn", "replaced"])(
    "drops a delayed refresh after its connection or session is %s",
    async (change) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        vi.useFakeTimers();
        vi.setSystemTime(20_000);
        const fixture = await sharedTypingSession(
          "agent:main:typing-reset",
          "session-before-reset",
        );
        const { broadcast } = fixture;
        const scope = { agentId: "main", sessionKey: fixture.params.sessionKey };
        const connection = new AbortController();
        let currentAuthority = true;
        const requestClient = client("alice", "alice-tab");
        requestClient.connectionSignal = connection.signal;
        const params = {
          ...fixture.params,
          client: requestClient,
          hasCurrentClientAuthority: () => currentAuthority,
        };
        const recordClientActivity = vi.fn();
        params.context.recordClientActivity = recordClientActivity;

        expect(await callTyping({ ...params, typing: true })).toEqual({
          ok: true,
          broadcast: true,
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(await callTyping({ ...params, typing: true })).toEqual({
          ok: true,
          broadcast: false,
        });
        switch (change) {
          case "disconnected":
            connection.abort();
            break;
          case "invalidated":
            params.client.invalidated = true;
            break;
          case "authority revoked":
            currentAuthority = false;
            break;
          case "sharing withdrawn":
          case "replaced":
            await upsertSessionEntryCore(scope, {
              sessionId: change === "replaced" ? "session-after-reset" : "session-before-reset",
              updatedAt: 2,
              createdActor: { type: "human", source: "profile", id: "owner" },
              visibility: change === "sharing withdrawn" ? "draft" : "shared",
            });
            break;
        }
        await vi.advanceTimersByTimeAsync(900);
        expect(broadcast).toHaveBeenCalledTimes(1);
        expect(recordClientActivity).toHaveBeenCalledTimes(2);
        await callTyping({ ...params, typing: true });
        expect(recordClientActivity).toHaveBeenCalledTimes(2);
      });
    },
  );

  it("does not record malformed, hidden, or unauthorized typing", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const sessionKey = "agent:main:typing-activity-authorization";
      const scope = { agentId: "main", sessionKey };
      const entry = {
        sessionId: "typing-activity",
        updatedAt: 1,
        createdActor: { type: "human" as const, source: "profile" as const, id: "owner" },
      };
      await upsertSessionEntryCore(scope, { ...entry, visibility: "draft" });
      const requestContext = context();
      const recordClientActivity = vi.fn();
      requestContext.recordClientActivity = recordClientActivity;
      const params = {
        sessionKey,
        sessionId: entry.sessionId,
        typing: true,
        client: client("viewer", "typing-viewer"),
        context: requestContext,
      };
      await callTyping({ ...params, sessionKey: "" });
      await callTyping(params);
      expect(recordClientActivity).not.toHaveBeenCalled();
      await upsertSessionEntryCore(scope, { ...entry, visibility: "shared" });
      await callTyping(params);
      expect(recordClientActivity).toHaveBeenCalledExactlyOnceWith(params.client);
      await upsertSessionEntryCore(scope, { ...entry, visibility: "shared", incognito: true });
      await callTyping(params);
      expect(recordClientActivity).toHaveBeenCalledExactlyOnceWith(params.client);
    });
  });
});
