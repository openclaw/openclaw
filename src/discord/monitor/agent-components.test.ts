import type {
  ButtonInteraction,
  ComponentData,
  ModalInteraction,
  StringSelectMenuInteraction,
} from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { DiscordAccountConfig } from "../../config/types.discord.js";
import {
  clearDiscordComponentEntries,
  registerDiscordComponentEntries,
  resolveDiscordComponentEntry,
  resolveDiscordModalEntry,
} from "../components-registry.js";
import {
  createAgentComponentButton,
  createAgentSelectMenu,
  createDiscordComponentButton,
  createDiscordComponentModal,
} from "./agent-components.js";

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

describe("agent components", () => {
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
  it("routes button clicks with reply references", async () => {
    registerDiscordComponentEntries({
      entries: [
        {
          id: "btn_1",
          kind: "button",
          label: "Approve",
          messageId: "msg-1",
          sessionKey: "session-1",
          agentId: "agent-1",
          accountId: "default",
        },
      ],
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

  it("routes modal submissions with field values", async () => {
    registerDiscordComponentEntries({
      entries: [],
      modals: [
        {
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
        },
      ],
    });

    const modal = createDiscordComponentModal(
      createComponentContext({
        discordConfig: createDiscordConfig({ replyToMode: "all" }),
      }),
    );
    const { interaction, acknowledge } = createModalInteraction();

    await modal.run(interaction, { mid: "mdl_1" } as ComponentData);

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(lastDispatchCtx?.BodyForAgent).toContain('Form "Details" submitted.');
    expect(lastDispatchCtx?.BodyForAgent).toContain("- Name: Casey");
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReplyMock).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReplyMock.mock.calls[0]?.[0]?.replyToId).toBe("msg-2");
    expect(resolveDiscordModalEntry({ id: "mdl_1" })).toBeNull();
  });
});
