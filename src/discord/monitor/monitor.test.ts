import type {
  ButtonInteraction,
  ComponentData,
  ModalInteraction,
  StringSelectMenuInteraction,
} from "@buape/carbon";
import type { Client } from "@buape/carbon";
import type { GatewayPresenceUpdate } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { DiscordAccountConfig } from "../../config/types.discord.js";
import { buildAgentSessionKey } from "../../routing/resolve-route.js";
import {
  clearDiscordComponentEntries,
  registerDiscordComponentEntries,
  resolveDiscordComponentEntry,
  resolveDiscordModalEntry,
} from "../components-registry.js";
import type { DiscordComponentEntry, DiscordModalEntry } from "../components.js";
import {
  createAgentComponentButton,
  createAgentSelectMenu,
  createDiscordComponentButton,
  createDiscordComponentModal,
} from "./agent-components.js";
import type { DiscordChannelConfigResolved } from "./allow-list.js";
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
const dispatchReplyMock = vi.hoisted(() => vi.fn());
const deliverDiscordReplyMock = vi.hoisted(() => vi.fn());
const recordInboundSessionMock = vi.hoisted(() => vi.fn());
const readSessionUpdatedAtMock = vi.hoisted(() => vi.fn());
const resolveStorePathMock = vi.hoisted(() => vi.fn());
let lastDispatchCtx: Record<string, unknown> | undefined;

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

vi.mock("../../auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher: (...args: unknown[]) => dispatchReplyMock(...args),
}));

vi.mock("./reply-delivery.js", () => ({
  deliverDiscordReply: (...args: unknown[]) => deliverDiscordReplyMock(...args),
}));

vi.mock("../../channels/session.js", () => ({
  recordInboundSession: (...args: unknown[]) => recordInboundSessionMock(...args),
}));

vi.mock("../../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions.js")>();
  return {
    ...actual,
    readSessionUpdatedAt: (...args: unknown[]) => readSessionUpdatedAtMock(...args),
    resolveStorePath: (...args: unknown[]) => resolveStorePathMock(...args),
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

describe("discord component interactions", () => {
  const createCfg = (): OpenClawConfig =>
    ({
      channels: {
        discord: {
          replyToMode: "first",
        },
      },
    }) as OpenClawConfig;

  const createDiscordConfig = (overrides?: Partial<DiscordAccountConfig>): DiscordAccountConfig =>
    ({
      replyToMode: "first",
      ...overrides,
    }) as DiscordAccountConfig;

  type DispatchParams = {
    ctx: Record<string, unknown>;
    dispatcherOptions: {
      deliver: (payload: { text?: string }) => Promise<void> | void;
    };
  };

  const createComponentContext = (
    overrides?: Partial<Parameters<typeof createDiscordComponentButton>[0]>,
  ) =>
    ({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["123456789"],
      discordConfig: createDiscordConfig(),
      token: "token",
      ...overrides,
    }) as Parameters<typeof createDiscordComponentButton>[0];

  const createComponentButtonInteraction = (overrides: Partial<ButtonInteraction> = {}) => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const defer = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      rawData: { channel_id: "dm-channel", id: "interaction-1" },
      user: { id: "123456789", username: "AgentUser", discriminator: "0001" },
      customId: "occomp:cid=btn_1",
      message: { id: "msg-1" },
      client: { rest: {} },
      defer,
      reply,
      ...overrides,
    } as unknown as ButtonInteraction;
    return { interaction, defer, reply };
  };

  const createModalInteraction = (overrides: Partial<ModalInteraction> = {}) => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    const fields = {
      getText: (key: string) => (key === "fld_1" ? "Casey" : undefined),
      getStringSelect: (_key: string) => undefined,
      getRoleSelect: (_key: string) => [],
      getUserSelect: (_key: string) => [],
    };
    const interaction = {
      rawData: { channel_id: "dm-channel", id: "interaction-2" },
      user: { id: "123456789", username: "AgentUser", discriminator: "0001" },
      customId: "ocmodal:mid=mdl_1",
      fields,
      acknowledge,
      reply,
      client: { rest: {} },
      ...overrides,
    } as unknown as ModalInteraction;
    return { interaction, acknowledge, reply };
  };

  const createButtonEntry = (
    overrides: Partial<DiscordComponentEntry> = {},
  ): DiscordComponentEntry => ({
    id: "btn_1",
    kind: "button",
    label: "Approve",
    messageId: "msg-1",
    sessionKey: "session-1",
    agentId: "agent-1",
    accountId: "default",
    ...overrides,
  });

  const createModalEntry = (overrides: Partial<DiscordModalEntry> = {}): DiscordModalEntry => ({
    id: "mdl_1",
    title: "Details",
    messageId: "msg-2",
    sessionKey: "session-2",
    agentId: "agent-2",
    accountId: "default",
    fields: [
      {
        id: "fld_1",
        name: "name",
        label: "Name",
        type: "text",
      },
    ],
    ...overrides,
  });

  beforeEach(() => {
    clearDiscordComponentEntries();
    lastDispatchCtx = undefined;
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
    enqueueSystemEventMock.mockReset();
    dispatchReplyMock.mockReset().mockImplementation(async (params: DispatchParams) => {
      lastDispatchCtx = params.ctx;
      await params.dispatcherOptions.deliver({ text: "ok" });
    });
    deliverDiscordReplyMock.mockReset();
    recordInboundSessionMock.mockReset().mockResolvedValue(undefined);
    readSessionUpdatedAtMock.mockReset().mockReturnValue(undefined);
    resolveStorePathMock.mockReset().mockReturnValue("/tmp/openclaw-sessions-test.json");
  });

  it("routes button clicks with reply references", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry()],
      modals: [],
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction, reply } = createComponentButtonInteraction();

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({ content: "✓" });
    expect(lastDispatchCtx?.BodyForAgent).toBe('Clicked "Approve".');
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReplyMock).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReplyMock.mock.calls[0]?.[0]?.replyToId).toBe("msg-1");
    expect(resolveDiscordComponentEntry({ id: "btn_1" })).toBeNull();
  });

  it("keeps reusable buttons active after use", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ reusable: true })],
      modals: [],
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction } = createComponentButtonInteraction();
    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    const { interaction: secondInteraction } = createComponentButtonInteraction({
      rawData: {
        channel_id: "dm-channel",
        id: "interaction-2",
      } as unknown as ButtonInteraction["rawData"],
    });
    await button.run(secondInteraction, { cid: "btn_1" } as ComponentData);

    expect(dispatchReplyMock).toHaveBeenCalledTimes(2);
    expect(resolveDiscordComponentEntry({ id: "btn_1", consume: false })).not.toBeNull();
  });

  it("blocks buttons when allowedUsers does not match", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ allowedUsers: ["999"] })],
      modals: [],
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction, reply } = createComponentButtonInteraction();

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({ content: "You are not authorized to use this button." });
    expect(dispatchReplyMock).not.toHaveBeenCalled();
    expect(resolveDiscordComponentEntry({ id: "btn_1", consume: false })).not.toBeNull();
  });

  async function runModalSubmission(params?: { reusable?: boolean }) {
    registerDiscordComponentEntries({
      entries: [],
      modals: [createModalEntry({ reusable: params?.reusable ?? false })],
    });

    const modal = createDiscordComponentModal(
      createComponentContext({
        discordConfig: createDiscordConfig({ replyToMode: "all" }),
      }),
    );
    const { interaction, acknowledge } = createModalInteraction();

    await modal.run(interaction, { mid: "mdl_1" } as ComponentData);
    return { acknowledge };
  }

  it("routes modal submissions with field values", async () => {
    const { acknowledge } = await runModalSubmission();

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(lastDispatchCtx?.BodyForAgent).toContain('Form "Details" submitted.');
    expect(lastDispatchCtx?.BodyForAgent).toContain("- Name: Casey");
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReplyMock).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReplyMock.mock.calls[0]?.[0]?.replyToId).toBe("msg-2");
    expect(resolveDiscordModalEntry({ id: "mdl_1" })).toBeNull();
  });

  it("keeps reusable modal entries active after submission", async () => {
    const { acknowledge } = await runModalSubmission({ reusable: true });

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(resolveDiscordModalEntry({ id: "mdl_1", consume: false })).not.toBeNull();
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
  function createAutoThreadParams(client: Client) {
    return {
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
    };
  }

  it("returns existing thread ID when creation fails due to race condition", async () => {
    const client = {
      rest: {
        post: async () => {
          throw new Error("A thread has already been created on this message");
        },
        get: async () => ({ thread: { id: "existing-thread" } }),
      },
    } as unknown as Client;

    const result = await maybeCreateDiscordAutoThread(createAutoThreadParams(client));

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

    const result = await maybeCreateDiscordAutoThread(createAutoThreadParams(client));

    expect(result).toBeUndefined();
  });
});

describe("resolveDiscordAutoThreadReplyPlan", () => {
  function createAutoThreadPlanParams(overrides?: {
    client?: Client;
    channelConfig?: DiscordChannelConfigResolved;
    threadChannel?: { id: string } | null;
  }) {
    return {
      client:
        overrides?.client ??
        ({ rest: { post: async () => ({ id: "thread" }) } } as unknown as Client),
      message: {
        id: "m1",
        channelId: "parent",
      } as unknown as import("./listeners.js").DiscordMessageEvent["message"],
      isGuildMessage: true,
      channelConfig:
        overrides?.channelConfig ??
        ({ autoThread: true } as unknown as DiscordChannelConfigResolved),
      threadChannel: overrides?.threadChannel ?? null,
      baseText: "hello",
      combinedBody: "hello",
      replyToMode: "all" as const,
      agentId: "agent",
      channel: "discord" as const,
    };
  }

  it("switches delivery + session context to the created thread", async () => {
    const plan = await resolveDiscordAutoThreadReplyPlan(createAutoThreadPlanParams());
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
    const plan = await resolveDiscordAutoThreadReplyPlan(
      createAutoThreadPlanParams({
        threadChannel: { id: "thread" },
      }),
    );
    expect(plan.deliverTarget).toBe("channel:thread");
    expect(plan.replyTarget).toBe("channel:thread");
    expect(plan.replyReference.use()).toBe("m1");
    expect(plan.autoThreadContext).toBeNull();
  });

  it("does nothing when autoThread is disabled", async () => {
    const plan = await resolveDiscordAutoThreadReplyPlan(
      createAutoThreadPlanParams({
        channelConfig: { autoThread: false } as unknown as DiscordChannelConfigResolved,
      }),
    );
    expect(plan.deliverTarget).toBe("channel:parent");
    expect(plan.autoThreadContext).toBeNull();
  });
});
