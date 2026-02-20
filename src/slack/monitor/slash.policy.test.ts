import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSlackMonitorSlashCommands } from "./slash.js";

const dispatchMock = vi.fn();
const readAllowFromStoreMock = vi.fn();
const upsertPairingRequestMock = vi.fn();
const resolveAgentRouteMock = vi.fn();

vi.mock("../../auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithDispatcher: (...args: unknown[]) => dispatchMock(...args),
}));

vi.mock("../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
}));

vi.mock("../../routing/resolve-route.js", () => ({
  resolveAgentRoute: (...args: unknown[]) => resolveAgentRouteMock(...args),
}));

vi.mock("../../agents/identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/identity.js")>();
  return {
    ...actual,
    resolveEffectiveMessagesConfig: () => ({ responsePrefix: "" }),
  };
});

function createHarness(overrides?: {
  groupPolicy?: "open" | "allowlist";
  channelsConfig?: Record<string, { allow?: boolean; requireMention?: boolean }>;
  channelId?: string;
  channelName?: string;
}) {
  const commands = new Map<unknown, (args: unknown) => Promise<void>>();
  const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  const app = {
    client: { chat: { postEphemeral } },
    command: (name: unknown, handler: (args: unknown) => Promise<void>) => {
      commands.set(name, handler);
    },
  };

  const channelId = overrides?.channelId ?? "C_UNLISTED";
  const channelName = overrides?.channelName ?? "unlisted";

  const ctx = {
    cfg: { commands: { native: false } },
    runtime: {},
    botToken: "bot-token",
    botUserId: "bot",
    teamId: "T1",
    allowFrom: ["*"],
    dmEnabled: true,
    dmPolicy: "open",
    groupDmEnabled: false,
    groupDmChannels: [],
    defaultRequireMention: true,
    groupPolicy: overrides?.groupPolicy ?? "open",
    useAccessGroups: true,
    channelsConfig: overrides?.channelsConfig,
    slashCommand: {
      enabled: true,
      name: "openclaw",
      ephemeral: true,
      sessionPrefix: "slack:slash",
    },
    textLimit: 4000,
    app,
    isChannelAllowed: () => true,
    resolveChannelName: async () => ({ name: channelName, type: "channel" }),
    resolveUserName: async () => ({ name: "Ada" }),
  } as unknown;

  const account = { accountId: "acct", config: { commands: { native: false } } } as unknown;

  return { commands, ctx, account, postEphemeral, channelId, channelName };
}

beforeEach(() => {
  dispatchMock.mockReset().mockResolvedValue({ counts: { final: 1, tool: 0, block: 0 } });
  readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
  resolveAgentRouteMock.mockReset().mockReturnValue({
    agentId: "main",
    sessionKey: "session:1",
    accountId: "acct",
  });
});

describe("slack slash commands channel policy", () => {
  it("allows unlisted channels when groupPolicy is open", async () => {
    const { commands, ctx, account, channelId, channelName } = createHarness({
      groupPolicy: "open",
      channelsConfig: { C_LISTED: { requireMention: true } },
      channelId: "C_UNLISTED",
      channelName: "unlisted",
    });
    registerSlackMonitorSlashCommands({ ctx: ctx as never, account: account as never });

    const handler = [...commands.values()][0];
    if (!handler) {
      throw new Error("Missing slash handler");
    }

    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      command: {
        user_id: "U1",
        user_name: "Ada",
        channel_id: channelId,
        channel_name: channelName,
        text: "hello",
        trigger_id: "t1",
      },
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(respond).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: "This channel is not allowed." }),
    );
  });

  it("blocks explicitly denied channels when groupPolicy is open", async () => {
    const { commands, ctx, account, channelId, channelName } = createHarness({
      groupPolicy: "open",
      channelsConfig: { C_DENIED: { allow: false } },
      channelId: "C_DENIED",
      channelName: "denied",
    });
    registerSlackMonitorSlashCommands({ ctx: ctx as never, account: account as never });

    const handler = [...commands.values()][0];
    if (!handler) {
      throw new Error("Missing slash handler");
    }

    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      command: {
        user_id: "U1",
        user_name: "Ada",
        channel_id: channelId,
        channel_name: channelName,
        text: "hello",
        trigger_id: "t1",
      },
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
    });

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "This channel is not allowed.",
      response_type: "ephemeral",
    });
  });

  it("blocks unlisted channels when groupPolicy is allowlist", async () => {
    const { commands, ctx, account, channelId, channelName } = createHarness({
      groupPolicy: "allowlist",
      channelsConfig: { C_LISTED: { requireMention: true } },
      channelId: "C_UNLISTED",
      channelName: "unlisted",
    });
    registerSlackMonitorSlashCommands({ ctx: ctx as never, account: account as never });

    const handler = [...commands.values()][0];
    if (!handler) {
      throw new Error("Missing slash handler");
    }

    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      command: {
        user_id: "U1",
        user_name: "Ada",
        channel_id: channelId,
        channel_name: channelName,
        text: "hello",
        trigger_id: "t1",
      },
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
    });

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "This channel is not allowed.",
      response_type: "ephemeral",
    });
  });
});
