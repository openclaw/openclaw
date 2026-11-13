import { beforeEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSessionMessageSubscriberRegistry } from "../server-chat-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";
import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";
import type { RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({ linked: true, onHistory: () => {}, profileId: "" }));
vi.mock("../../state/user-channel-identity-operations.js", async (original) => ({
  ...(await original<typeof import("../../state/user-channel-identity-operations.js")>()),
  prepareUserProfileRoleAuthority: async (profileId: string) => ({
    profileId,
    isCurrent: () => true,
  }),
  listCanonicalUserChannelIdentities: async (profileId: string) =>
    profileId === mocks.profileId
      ? [{ profileId, identity: { channelId: "telegram", accountId: "default", senderId: "123" } }]
      : [],
  prepareUserChannelIdentityAuthority: async () => ({
    linked: { profileId: mocks.profileId },
    isCurrent: () => mocks.linked,
  }),
}));
vi.mock("../session-channel-membership.js", () => ({
  prepareTelegramGroupMemberships: async () =>
    new Map([[JSON.stringify(["default", "-123"]), { isCurrent: () => mocks.linked }]]),
}));
vi.mock("./chat-history-handler.js", () => ({
  handleChatHistoryRequest: async ({ respond }: { respond: RespondFn }) => {
    mocks.onHistory();
    respond(true, { messages: [] }, undefined);
  },
}));

const key = "agent:main:telegram:group:-123";
function row(access?: SessionEntry["access"]): SessionEntry {
  return {
    sessionId: "synthetic-group",
    updatedAt: 1,
    createdVia: "channel",
    access,
    createdActor: { type: "human", source: "channel", id: "123" },
    delivery: {
      kind: "external",
      context: {},
      route: { channel: "telegram", accountId: "default", target: { to: "telegram:-123" } },
      origin: { provider: "telegram", chatType: "group", nativeChannelId: "-123" },
    },
  };
}
async function subscribe(
  access?: SessionEntry["access"],
  options: {
    direct?: boolean;
    grant?: boolean;
    account?: string;
    incognito?: boolean;
    thread?: number;
  } = {},
) {
  return await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
      const cfg: OpenClawConfig = {
        ...rolePolicyConfig(),
        agents: { ownership: "explicit", entries: { main: {} } },
      };
      const controller = new AbortController();
      const client = roleClient("none", "ldap-subscription-staff");
      mocks.profileId = client.authenticatedUserProfile!.profileId;
      if (options.direct) {
        cfg.agents = { ownership: "explicit", entries: { editor123: {} } };
        cfg.session = {
          sharing: {
            legacyDirectAccess:
              options.grant === false
                ? []
                : [
                    {
                      channel: "telegram",
                      accountId: "default",
                      agentId: "editor123",
                      peerId: "123",
                      profileIds: [mocks.profileId],
                    },
                  ],
          },
        };
      }
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      Object.assign(client, { connId: "staff-browser", connectionSignal: controller.signal });
      const sessionKey = options.direct
        ? `agent:editor123:telegram:direct:123${options.thread === undefined ? "" : `:thread:123:${options.thread}`}`
        : key;
      const entry = row(access);
      if (options.incognito) entry.incognito = true;
      if (options.direct) {
        entry.delivery = {
          kind: "external",
          context: {},
          route: {
            channel: "telegram",
            accountId: options.account ?? "default",
            target: { to: "telegram:123" },
            ...(options.thread === undefined ? {} : { thread: { id: options.thread } }),
          },
          origin: {
            provider: "telegram",
            chatType: "direct",
            accountId: options.account ?? "default",
          },
        };
      }
      replaceSessionEntrySync(
        { agentId: options.direct ? "editor123" : "main", sessionKey },
        entry,
      );
      const subscribers = createSessionMessageSubscriberRegistry();
      const context = await createHistoryReadContext({
        getRuntimeConfig: () => cfg,
        subscribeSessionMessageEvents: subscribers.subscribe,
        unsubscribeSessionMessageEvents: subscribers.unsubscribe,
      });
      const respond = vi.fn<RespondFn>();
      const params = {
        key: sessionKey,
        subscriptionId: "gui",
        initialHistory: { limit: 80, maxBytes: 262144, toolResultMaxChars: 2000 },
      };
      try {
        // Fresh connection: the first session RPC is the exact GUI subscription.
        await handleGatewayRequest({
          req: { type: "req", id: "gui", method: "sessions.messages.subscribe", params },
          client,
          context,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: sessionSubscriptionHandlers,
        });
        return { calls: respond.mock.calls, observers: subscribers.get(sessionKey).size };
      } finally {
        controller.abort();
        subscribers.unsubscribeAll("staff-browser");
        await disposeSessionReadContexts();
      }
    },
  );
}
beforeEach(() => {
  mocks.linked = true;
  mocks.onHistory = () => {};
});

it("opens a linked group from a fresh staff GUI subscription with initial history", async () => {
  const result = await subscribe();
  expect(result.calls).toEqual([
    [
      true,
      expect.objectContaining({
        subscribed: true,
        key,
        agentId: "main",
        initialHistory: { ok: true, payload: { messages: [] } },
      }),
      undefined,
    ],
  ]);
  expect(result.observers).toBe(1);
});

it("denies private ACL and revocation while preparing initial history", async () => {
  const privateResult = await subscribe({ mode: "creator" });
  expect(privateResult.calls[0]?.[0]).toBe(false);
  mocks.onHistory = () => {
    mocks.linked = false;
  };
  const revoked = await subscribe();
  expect(revoked.calls[0]?.[0]).toBe(false);
  expect(revoked.observers).toBe(0);
});

it("denies an incognito group despite current channel membership", async () => {
  const result = await subscribe(undefined, { incognito: true });
  expect(result.calls[0]?.[0]).toBe(false);
  expect(result.observers).toBe(0);
});

it.each([undefined, 42])(
  "opens an explicitly granted linked legacy DM (thread %s)",
  async (thread) => {
    const result = await subscribe(undefined, { direct: true, thread });
    expect(result.calls[0]?.[0]).toBe(true);
    expect(result.observers).toBe(1);
  },
);

it("denies a DM without its exact grant or with the wrong account", async () => {
  for (const options of [
    { direct: true, grant: false },
    { direct: true, account: "other" },
  ]) {
    const result = await subscribe(undefined, options);
    expect(result.calls[0]?.[0]).toBe(false);
    expect(result.observers).toBe(0);
  }
});

it("rolls back DM subscription if identity is unlinked during initial history", async () => {
  mocks.onHistory = () => {
    mocks.linked = false;
  };
  const result = await subscribe(undefined, { direct: true });
  expect(result.calls[0]?.[0]).toBe(false);
  expect(result.observers).toBe(0);
});
