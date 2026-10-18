import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTypingParams } from "../../../packages/gateway-protocol/src/schema/sessions-suggestions.js";
import type { PresenceEntry } from "../../../packages/gateway-protocol/src/schema/snapshot.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
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

vi.mock("../../infra/system-presence.js", () => ({
  listSystemPresence: () => mocks.presence,
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
    broadcast,
    broadcastToConnIds: vi.fn(),
    logGateway: { warn: vi.fn() },
  } as unknown as GatewayRequestContext;
}

async function writeSession(
  sessionKey: string,
  sessionId: string,
  {
    owner = "owner",
    agentId = "main",
    ...entry
  }: Partial<SessionEntry> & { owner?: string; agentId?: string } = {},
) {
  await upsertSessionEntryCore(
    { agentId, sessionKey },
    {
      sessionId,
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: owner },
      visibility: "shared",
      ...entry,
    },
  );
}

async function typingSession(name: string, now: number, actor = "alice", id?: string) {
  const sessionKey = `agent:main:${name}`;
  const sessionId = id ?? `session-${name}`;
  setRuntimeConfigSnapshot({});
  vi.useFakeTimers();
  vi.setSystemTime(now);
  await writeSession(sessionKey, sessionId);
  mocks.presence = [actor, "owner"].map((profileId) => ({
    user: profileUser(profileId),
    watchedSessions: [sessionKey],
  }));
  const broadcast = vi.fn();
  return { broadcast, params: { sessionKey, sessionId, context: context(broadcast) } };
}

async function callTyping({
  client: requestClient,
  context: requestContext,
  hasCurrentClientAuthority,
  ...params
}: SessionTypingParams & {
  client: GatewayClient;
  context: GatewayRequestContext;
  hasCurrentClientAuthority?: () => boolean;
}) {
  await initializeSessionReadContext(requestContext);
  const responses: Parameters<RespondFn>[] = [];
  await sessionSuggestionHandlers["session.typing"]?.({
    req: { type: "req", id: "typing-request", method: "session.typing", params },
    params,
    client: requestClient,
    context: requestContext,
    hasCurrentClientAuthority,
    isWebchatConnect: () => true,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  });
  return responses[0]?.[1];
}

async function expectTyping(params: Parameters<typeof callTyping>[0], broadcast: boolean) {
  expect(await callTyping(params)).toEqual({ ok: true, broadcast });
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
      await writeSession(sessionKey, sessionId, { owner: "shared" });
      mocks.presence = presence.map((entry) => ({ ...entry, watchedSessions: [sessionKey] }));
      const broadcast = vi.fn();
      await expectTyping(
        {
          sessionKey,
          sessionId,
          typing: true,
          preview: "draft preview",
          client: client("shared", "typing-namespace-actor"),
          context: context(broadcast),
        },
        expected,
      );
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
      const { broadcast, params: base } = await typingSession("preview", 30_000);
      const params = { ...base, client: client("alice", "alice-preview") };

      await expectTyping({ ...params, typing: true, preview: "  first draft  ", cursor: 4 }, true);
      expect(broadcast.mock.calls[0]?.[1]).toMatchObject({
        typing: true,
        preview: "  first draft  ",
        cursor: 4,
      });

      const oversizedPreview = "😀".repeat(405);
      await vi.advanceTimersByTimeAsync(250);
      await expectTyping({ ...params, typing: true, preview: oversizedPreview, cursor: 800 }, true);
      expect(broadcast.mock.calls[1]?.[1]).toMatchObject({
        preview: "😀".repeat(400),
        cursor: 800,
      });

      await callTyping({ ...params, typing: true, preview: oversizedPreview, cursor: 2 });
      await vi.advanceTimersByTimeAsync(250);
      expect(broadcast.mock.lastCall?.[1]).toMatchObject({ preview: "😀".repeat(400), cursor: 2 });

      await vi.advanceTimersByTimeAsync(1_000);
      await expectTyping({ ...params, typing: false, preview: "must not leak" }, true);
      expect(broadcast.mock.lastCall?.[1]).toMatchObject({ typing: false });
      expect(broadcast.mock.lastCall?.[1]).not.toHaveProperty("preview");
      expect(broadcast.mock.lastCall?.[1]).not.toHaveProperty("cursor");
    });
  });

  it("keeps a draft beside boolean-only typing until its connection stops", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { broadcast, params } = await typingSession("shared-preview", 40_000);

      await expectTyping(
        {
          ...params,
          typing: true,
          preview: "still drafting",
          client: client("alice", "alice-preview-tab"),
        },
        true,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await expectTyping(
        {
          ...params,
          typing: true,
          client: client("alice", "alice-presence-tab"),
        },
        true,
      );

      expect(broadcast.mock.calls[1]?.[1]).toMatchObject({
        typing: true,
        preview: "still drafting",
      });

      await vi.advanceTimersByTimeAsync(100);
      await callTyping({
        ...params,
        typing: false,
        client: client("alice", "alice-preview-tab"),
      });
      await vi.advanceTimersByTimeAsync(900);
      expect(broadcast.mock.lastCall?.[1]).toMatchObject({ typing: true });
      expect(broadcast.mock.lastCall?.[1]).not.toHaveProperty("preview");
    });
  });

  it.each([
    { state: "queued", delayMs: 100 },
    { state: "published", delayMs: 250 },
  ])(
    "replaces a stopped connection's $state preview with the live draft",
    async ({ state, delayMs }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const { broadcast, params } = await typingSession(`stopped-${state}-preview`, 50_000);
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
      await writeSession("global", `session-${agentId}`, { agentId });
      mocks.presence = [
        { user: profileUser("alice"), watchedSessions: ["global"] },
        { user: profileUser("owner"), watchedSessions: ["global"] },
      ];
      const broadcast = vi.fn();

      await expectTyping(
        {
          sessionKey: "global",
          sessionId: `session-${agentId}`,
          agentId,
          typing: true,
          client: client("alice", `alice-${agentId}`),
          context: context(broadcast, cfg),
        },
        true,
      );
      expect(broadcast).toHaveBeenCalledWith(
        "session.typing",
        expect.objectContaining({ agentId, sessionKey: "global" }),
        expect.objectContaining({ agentId, sessionKeys: expected }),
      );
    });
  });

  it("keeps an identity typing until its last active connection stops", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { broadcast, params } = await typingSession("main", 10_000, "multi");
      const recordClientActivity = vi.fn();
      params.context.recordClientActivity = recordClientActivity;
      const tabOne = client("multi", "multi-tab-1");
      const tabTwo = client("multi", "multi-tab-2");

      await expectTyping({ ...params, typing: true, client: tabOne }, true);
      await vi.advanceTimersByTimeAsync(100);
      await expectTyping({ ...params, typing: true, client: tabTwo }, false);
      await vi.advanceTimersByTimeAsync(300);
      await expectTyping({ ...params, typing: false, client: tabOne }, false);
      await vi.advanceTimersByTimeAsync(100);
      await expectTyping({ ...params, typing: false, client: tabTwo }, false);
      await vi.advanceTimersByTimeAsync(500);
      expect(broadcast.mock.calls.map((call) => call[1].typing)).toEqual([true, false]);
      expect(recordClientActivity.mock.calls).toEqual([[tabOne], [tabTwo]]);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(recordClientActivity).toHaveBeenCalledTimes(2);
    });
  });

  it("does not carry active connections across a session replacement", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { broadcast, params } = await typingSession(
        "typing-instance",
        15_000,
        "alice",
        "session-before-reset",
      );
      const oldTab = client("alice", "old-tab");
      const newTab = client("alice", "new-tab");
      const oldTyping = { ...params, typing: true, client: oldTab };
      const newTyping = {
        ...params,
        sessionId: "session-after-reset",
        typing: true,
        client: newTab,
      };

      await expectTyping(oldTyping, true);
      await writeSession(params.sessionKey, "session-after-reset", { updatedAt: 2 });
      await expectTyping(oldTyping, false);
      await vi.advanceTimersByTimeAsync(1_000);
      await expectTyping(newTyping, true);
      expect(broadcast.mock.calls[1]?.[1]).toMatchObject({
        sessionId: "session-after-reset",
        typing: true,
      });
      await vi.advanceTimersByTimeAsync(100);
      await expectTyping({ ...newTyping, typing: false }, false);
      await vi.advanceTimersByTimeAsync(900);
      expect(broadcast.mock.calls.map((call) => call[1].typing)).toEqual([true, true, false]);
    });
  });

  it.each(["disconnected", "invalidated", "authority revoked", "sharing withdrawn", "replaced"])(
    "drops a delayed refresh after its connection or session is %s",
    async (change) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const { broadcast, params: base } = await typingSession(
          "typing-reset",
          20_000,
          "alice",
          "session-before-reset",
        );
        const connection = new AbortController();
        let currentAuthority = true;
        const requestClient = client("alice", "alice-tab");
        requestClient.connectionSignal = connection.signal;
        const params = {
          ...base,
          client: requestClient,
          hasCurrentClientAuthority: () => currentAuthority,
        };
        const recordClientActivity = vi.fn();
        params.context.recordClientActivity = recordClientActivity;

        await expectTyping({ ...params, typing: true }, true);
        await vi.advanceTimersByTimeAsync(100);
        await expectTyping({ ...params, typing: true }, false);
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
            await writeSession(
              params.sessionKey,
              change === "replaced" ? "session-after-reset" : "session-before-reset",
              {
                updatedAt: 2,
                visibility: change === "sharing withdrawn" ? "draft" : "shared",
              },
            );
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
      await writeSession(sessionKey, "typing-activity", { visibility: "draft" });
      const requestContext = context();
      const recordClientActivity = vi.fn();
      requestContext.recordClientActivity = recordClientActivity;
      const params = {
        sessionKey,
        sessionId: "typing-activity",
        typing: true,
        client: client("viewer", "typing-viewer"),
        context: requestContext,
      };
      await callTyping({ ...params, sessionKey: "" });
      await callTyping(params);
      expect(recordClientActivity).not.toHaveBeenCalled();
      await writeSession(sessionKey, "typing-activity");
      await callTyping(params);
      expect(recordClientActivity).toHaveBeenCalledExactlyOnceWith(params.client);
      await writeSession(sessionKey, "typing-activity", { incognito: true });
      await callTyping(params);
      expect(recordClientActivity).toHaveBeenCalledExactlyOnceWith(params.client);
    });
  });
});
