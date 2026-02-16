import type { ButtonInteraction, ComponentData, StringSelectMenuInteraction } from "@buape/carbon";
import type { Client } from "@buape/carbon";
import type { GatewayPresenceUpdate } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { DiscordChannelConfigResolved } from "./allow-list.js";
import { buildAgentSessionKey } from "../../routing/resolve-route.js";
import { createAgentComponentButton, createAgentSelectMenu } from "./agent-components.js";
import {
  resolveDiscordMemberAllowed,
  resolveDiscordOwnerAllowFrom,
  resolveDiscordRoleAllowed,
} from "./allow-list.js";
import {
  clearGateways,
  getGateway,
  registerGateway,
  unregisterGateway,
} from "./gateway-registry.js";
import { clearPresences, getPresence, presenceCacheSize, setPresence } from "./presence-cache.js";
import { resolveDiscordPresenceUpdate } from "./presence.js";
import {
  maybeCreateDiscordAutoThread,
  resolveDiscordAutoThreadContext,
  resolveDiscordAutoThreadReplyPlan,
  resolveDiscordReplyDeliveryPlan,
} from "./threading.js";

const readAllowFromStoreMock = vi.hoisted(() => vi.fn());
const upsertPairingRequestMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventMock = vi.hoisted(() => vi.fn());

vi.mock("../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
}));

vi.mock("../../infra/system-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/system-events.js")>();
  return {
    ...actual,
    enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
  };
});

describe("agent components", () => {
  const createCfg = (): OpenClawConfig => ({}) as OpenClawConfig;

  const createDmButtonInteraction = (overrides: Partial<ButtonInteraction> = {}) => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const defer = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      rawData: { channel_id: "dm-channel" },
      user: { id: "123456789", username: "Alice", discriminator: "1234" },
      defer,
      reply,
      ...overrides,
    } as unknown as ButtonInteraction;
    return { interaction, defer, reply };
  };

  const createDmSelectInteraction = (overrides: Partial<StringSelectMenuInteraction> = {}) => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const defer = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      rawData: { channel_id: "dm-channel" },
      user: { id: "123456789", username: "Alice", discriminator: "1234" },
      values: ["alpha"],
      defer,
      reply,
      ...overrides,
    } as unknown as StringSelectMenuInteraction;
    return { interaction, defer, reply };
  };

  beforeEach(() => {
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
    enqueueSystemEventMock.mockReset();
  });

  it("sends pairing reply when DM sender is not allowlisted", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "pairing",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).toHaveBeenCalledWith({ ephemeral: true });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]?.content).toContain("Pairing code: PAIRCODE");
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("allows DM interactions when pairing store allowlist matches", async () => {
    readAllowFromStoreMock.mockResolvedValue(["123456789"]);
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).toHaveBeenCalledWith({ ephemeral: true });
    expect(reply).toHaveBeenCalledWith({ content: "✓" });
    expect(enqueueSystemEventMock).toHaveBeenCalled();
  });

  it("matches tag-based allowlist entries for DM select menus", async () => {
    const select = createAgentSelectMenu({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["Alice#1234"],
    });
    const { interaction, defer, reply } = createDmSelectInteraction();

    await select.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).toHaveBeenCalledWith({ ephemeral: true });
    expect(reply).toHaveBeenCalledWith({ content: "✓" });
    expect(enqueueSystemEventMock).toHaveBeenCalled();
  });
});

describe("resolveDiscordOwnerAllowFrom", () => {
  it("returns undefined when no allowlist is configured", () => {
    const result = resolveDiscordOwnerAllowFrom({
      channelConfig: { allowed: true } as DiscordChannelConfigResolved,
      sender: { id: "123" },
    });

    expect(result).toBeUndefined();
  });

  it("skips wildcard matches for owner allowFrom", () => {
    const result = resolveDiscordOwnerAllowFrom({
      channelConfig: { allowed: true, users: ["*"] } as DiscordChannelConfigResolved,
      sender: { id: "123" },
    });

    expect(result).toBeUndefined();
  });

  it("returns a matching user id entry", () => {
    const result = resolveDiscordOwnerAllowFrom({
      channelConfig: { allowed: true, users: ["123"] } as DiscordChannelConfigResolved,
      sender: { id: "123" },
    });

    expect(result).toEqual(["123"]);
  });

  it("returns the normalized name slug for name matches", () => {
    const result = resolveDiscordOwnerAllowFrom({
      channelConfig: { allowed: true, users: ["Some User"] } as DiscordChannelConfigResolved,
      sender: { id: "999", name: "Some User" },
    });

    expect(result).toEqual(["some-user"]);
  });
});

describe("resolveDiscordRoleAllowed", () => {
  it("allows when no role allowlist is configured", () => {
    const allowed = resolveDiscordRoleAllowed({
      allowList: undefined,
      memberRoleIds: ["role-1"],
    });

    expect(allowed).toBe(true);
  });

  it("matches role IDs only", () => {
    const allowed = resolveDiscordRoleAllowed({
      allowList: ["123"],
      memberRoleIds: ["123", "456"],
    });

    expect(allowed).toBe(true);
  });

  it("does not match non-ID role entries", () => {
    const allowed = resolveDiscordRoleAllowed({
      allowList: ["Admin"],
      memberRoleIds: ["Admin"],
    });

    expect(allowed).toBe(false);
  });

  it("returns false when no matching role IDs", () => {
    const allowed = resolveDiscordRoleAllowed({
      allowList: ["456"],
      memberRoleIds: ["123"],
    });

    expect(allowed).toBe(false);
  });
});

describe("resolveDiscordMemberAllowed", () => {
  it("allows when no user or role allowlists are configured", () => {
    const allowed = resolveDiscordMemberAllowed({
      userAllowList: undefined,
      roleAllowList: undefined,
      memberRoleIds: [],
      userId: "u1",
    });

    expect(allowed).toBe(true);
  });

  it("allows when user allowlist matches", () => {
    const allowed = resolveDiscordMemberAllowed({
      userAllowList: ["123"],
      roleAllowList: ["456"],
      memberRoleIds: ["999"],
      userId: "123",
    });

    expect(allowed).toBe(true);
  });

  it("allows when role allowlist matches", () => {
    const allowed = resolveDiscordMemberAllowed({
      userAllowList: ["999"],
      roleAllowList: ["456"],
      memberRoleIds: ["456"],
      userId: "123",
    });

    expect(allowed).toBe(true);
  });

  it("denies when user and role allowlists do not match", () => {
    const allowed = resolveDiscordMemberAllowed({
      userAllowList: ["u2"],
      roleAllowList: ["role-2"],
      memberRoleIds: ["role-1"],
      userId: "u1",
    });

    expect(allowed).toBe(false);
  });
});

describe("gateway-registry", () => {
  type GatewayPlugin = { isConnected: boolean };

  function fakeGateway(props: Partial<GatewayPlugin> = {}): GatewayPlugin {
    return { isConnected: true, ...props };
  }

  beforeEach(() => {
    clearGateways();
  });

  it("stores and retrieves a gateway by account", () => {
    const gateway = fakeGateway();
    registerGateway("account-a", gateway as never);
    expect(getGateway("account-a")).toBe(gateway);
    expect(getGateway("account-b")).toBeUndefined();
  });

  it("uses collision-safe key when accountId is undefined", () => {
    const gateway = fakeGateway();
    registerGateway(undefined, gateway as never);
    expect(getGateway(undefined)).toBe(gateway);
    expect(getGateway("default")).toBeUndefined();
  });

  it("unregisters a gateway", () => {
    const gateway = fakeGateway();
    registerGateway("account-a", gateway as never);
    unregisterGateway("account-a");
    expect(getGateway("account-a")).toBeUndefined();
  });

  it("clears all gateways", () => {
    registerGateway("a", fakeGateway() as never);
    registerGateway("b", fakeGateway() as never);
    clearGateways();
    expect(getGateway("a")).toBeUndefined();
    expect(getGateway("b")).toBeUndefined();
  });

  it("overwrites existing entry for same account", () => {
    const gateway1 = fakeGateway({ isConnected: true });
    const gateway2 = fakeGateway({ isConnected: false });
    registerGateway("account-a", gateway1 as never);
    registerGateway("account-a", gateway2 as never);
    expect(getGateway("account-a")).toBe(gateway2);
  });
});

describe("presence-cache", () => {
  beforeEach(() => {
    clearPresences();
  });

  it("scopes presence entries by account", () => {
    const presenceA = { status: "online" } as GatewayPresenceUpdate;
    const presenceB = { status: "idle" } as GatewayPresenceUpdate;

    setPresence("account-a", "user-1", presenceA);
    setPresence("account-b", "user-1", presenceB);

    expect(getPresence("account-a", "user-1")).toBe(presenceA);
    expect(getPresence("account-b", "user-1")).toBe(presenceB);
    expect(getPresence("account-a", "user-2")).toBeUndefined();
  });

  it("clears presence per account", () => {
    const presence = { status: "dnd" } as GatewayPresenceUpdate;

    setPresence("account-a", "user-1", presence);
    setPresence("account-b", "user-2", presence);

    clearPresences("account-a");

    expect(getPresence("account-a", "user-1")).toBeUndefined();
    expect(getPresence("account-b", "user-2")).toBe(presence);
    expect(presenceCacheSize()).toBe(1);
  });
});

describe("resolveDiscordPresenceUpdate", () => {
  it("returns null when no presence config provided", () => {
    expect(resolveDiscordPresenceUpdate({})).toBeNull();
  });

  it("returns status-only presence when activity is omitted", () => {
    const presence = resolveDiscordPresenceUpdate({ status: "dnd" });
    expect(presence).not.toBeNull();
    expect(presence?.status).toBe("dnd");
    expect(presence?.activities).toEqual([]);
  });

  it("defaults to custom activity type when activity is set without type", () => {
    const presence = resolveDiscordPresenceUpdate({ activity: "Focus time" });
    expect(presence).not.toBeNull();
    expect(presence?.status).toBe("online");
    expect(presence?.activities).toHaveLength(1);
    expect(presence?.activities[0]).toMatchObject({
      type: 4,
      name: "Custom Status",
      state: "Focus time",
    });
  });

  it("includes streaming url when activityType is streaming", () => {
    const presence = resolveDiscordPresenceUpdate({
      activity: "Live",
      activityType: 1,
      activityUrl: "https://twitch.tv/openclaw",
    });
    expect(presence).not.toBeNull();
    expect(presence?.activities).toHaveLength(1);
    expect(presence?.activities[0]).toMatchObject({
      type: 1,
      name: "Live",
      url: "https://twitch.tv/openclaw",
    });
  });
});

describe("resolveDiscordAutoThreadContext", () => {
  it("returns null when no createdThreadId", () => {
    expect(
      resolveDiscordAutoThreadContext({
        agentId: "agent",
        channel: "discord",
        messageChannelId: "parent",
        createdThreadId: undefined,
      }),
    ).toBeNull();
  });

  it("re-keys session context to the created thread", () => {
    const context = resolveDiscordAutoThreadContext({
      agentId: "agent",
      channel: "discord",
      messageChannelId: "parent",
      createdThreadId: "thread",
    });
    expect(context).not.toBeNull();
    expect(context?.To).toBe("channel:thread");
    expect(context?.From).toBe("discord:channel:thread");
    expect(context?.OriginatingTo).toBe("channel:thread");
    expect(context?.SessionKey).toBe(
      buildAgentSessionKey({
        agentId: "agent",
        channel: "discord",
        peer: { kind: "channel", id: "thread" },
      }),
    );
    expect(context?.ParentSessionKey).toBe(
      buildAgentSessionKey({
        agentId: "agent",
        channel: "discord",
        peer: { kind: "channel", id: "parent" },
      }),
    );
  });
});

describe("resolveDiscordReplyDeliveryPlan", () => {
  it("uses reply references when posting to the original target", () => {
    const plan = resolveDiscordReplyDeliveryPlan({
      replyTarget: "channel:parent",
      replyToMode: "all",
      messageId: "m1",
      threadChannel: null,
      createdThreadId: null,
    });
    expect(plan.deliverTarget).toBe("channel:parent");
    expect(plan.replyTarget).toBe("channel:parent");
    expect(plan.replyReference.use()).toBe("m1");
  });

  it("disables reply references when autoThread creates a new thread", () => {
    const plan = resolveDiscordReplyDeliveryPlan({
      replyTarget: "channel:parent",
      replyToMode: "all",
      messageId: "m1",
      threadChannel: null,
      createdThreadId: "thread",
    });
    expect(plan.deliverTarget).toBe("channel:thread");
    expect(plan.replyTarget).toBe("channel:thread");
    expect(plan.replyReference.use()).toBeUndefined();
  });

  it("respects replyToMode off even inside a thread", () => {
    const plan = resolveDiscordReplyDeliveryPlan({
      replyTarget: "channel:thread",
      replyToMode: "off",
      messageId: "m1",
      threadChannel: { id: "thread" },
      createdThreadId: null,
    });
    expect(plan.replyReference.use()).toBeUndefined();
  });

  it("uses existingId when inside a thread with replyToMode all", () => {
    const plan = resolveDiscordReplyDeliveryPlan({
      replyTarget: "channel:thread",
      replyToMode: "all",
      messageId: "m1",
      threadChannel: { id: "thread" },
      createdThreadId: null,
    });
    expect(plan.replyReference.use()).toBe("m1");
    expect(plan.replyReference.use()).toBe("m1");
  });

  it("uses existingId only on first call with replyToMode first inside a thread", () => {
    const plan = resolveDiscordReplyDeliveryPlan({
      replyTarget: "channel:thread",
      replyToMode: "first",
      messageId: "m1",
      threadChannel: { id: "thread" },
      createdThreadId: null,
    });
    expect(plan.replyReference.use()).toBe("m1");
    expect(plan.replyReference.use()).toBeUndefined();
  });
});

describe("maybeCreateDiscordAutoThread", () => {
  it("returns existing thread ID when creation fails due to race condition", async () => {
    const client = {
      rest: {
        post: async () => {
          throw new Error("A thread has already been created on this message");
        },
        get: async () => ({ thread: { id: "existing-thread" } }),
      },
    } as unknown as Client;

    const result = await maybeCreateDiscordAutoThread({
      client,
      message: {
        id: "m1",
        channelId: "parent",
      } as unknown as import("./listeners.js").DiscordMessageEvent["message"],
      isGuildMessage: true,
      channelConfig: {
        autoThread: true,
      } as unknown as DiscordChannelConfigResolved,
      threadChannel: null,
      baseText: "hello",
      combinedBody: "hello",
    });

    expect(result).toBe("existing-thread");
  });

  it("returns undefined when creation fails and no existing thread found", async () => {
    const client = {
      rest: {
        post: async () => {
          throw new Error("Some other error");
        },
        get: async () => ({ thread: null }),
      },
    } as unknown as Client;

    const result = await maybeCreateDiscordAutoThread({
      client,
      message: {
        id: "m1",
        channelId: "parent",
      } as unknown as import("./listeners.js").DiscordMessageEvent["message"],
      isGuildMessage: true,
      channelConfig: {
        autoThread: true,
      } as unknown as DiscordChannelConfigResolved,
      threadChannel: null,
      baseText: "hello",
      combinedBody: "hello",
    });

    expect(result).toBeUndefined();
  });
});

describe("resolveDiscordAutoThreadReplyPlan", () => {
  it("switches delivery + session context to the created thread", async () => {
    const client = {
      rest: { post: async () => ({ id: "thread" }) },
    } as unknown as Client;
    const plan = await resolveDiscordAutoThreadReplyPlan({
      client,
      message: {
        id: "m1",
        channelId: "parent",
      } as unknown as import("./listeners.js").DiscordMessageEvent["message"],
      isGuildMessage: true,
      channelConfig: {
        autoThread: true,
      } as unknown as DiscordChannelConfigResolved,
      threadChannel: null,
      baseText: "hello",
      combinedBody: "hello",
      replyToMode: "all",
      agentId: "agent",
      channel: "discord",
    });
    expect(plan.deliverTarget).toBe("channel:thread");
    expect(plan.replyReference.use()).toBeUndefined();
    expect(plan.autoThreadContext?.SessionKey).toBe(
      buildAgentSessionKey({
        agentId: "agent",
        channel: "discord",
        peer: { kind: "channel", id: "thread" },
      }),
    );
  });

  it("routes replies to an existing thread channel", async () => {
    const client = { rest: { post: async () => ({ id: "thread" }) } } as unknown as Client;
    const plan = await resolveDiscordAutoThreadReplyPlan({
      client,
      message: {
        id: "m1",
        channelId: "parent",
      } as unknown as import("./listeners.js").DiscordMessageEvent["message"],
      isGuildMessage: true,
      channelConfig: {
        autoThread: true,
      } as unknown as DiscordChannelConfigResolved,
      threadChannel: { id: "thread" },
      baseText: "hello",
      combinedBody: "hello",
      replyToMode: "all",
      agentId: "agent",
      channel: "discord",
    });
    expect(plan.deliverTarget).toBe("channel:thread");
    expect(plan.replyTarget).toBe("channel:thread");
    expect(plan.replyReference.use()).toBe("m1");
    expect(plan.autoThreadContext).toBeNull();
  });

  it("does nothing when autoThread is disabled", async () => {
    const client = { rest: { post: async () => ({ id: "thread" }) } } as unknown as Client;
    const plan = await resolveDiscordAutoThreadReplyPlan({
      client,
      message: {
        id: "m1",
        channelId: "parent",
      } as unknown as import("./listeners.js").DiscordMessageEvent["message"],
      isGuildMessage: true,
      channelConfig: {
        autoThread: false,
      } as unknown as DiscordChannelConfigResolved,
      threadChannel: null,
      baseText: "hello",
      combinedBody: "hello",
      replyToMode: "all",
      agentId: "agent",
      channel: "discord",
    });
    expect(plan.deliverTarget).toBe("channel:parent");
    expect(plan.autoThreadContext).toBeNull();
  });
});
