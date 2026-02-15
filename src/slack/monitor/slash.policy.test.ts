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

function createHarness(overrides?: {
  groupPolicy?: "open" | "allowlist";
  channelsConfig?: Record<string, { allow?: boolean; requireMention?: boolean }>;
  channelId?: string;
  channelName?: string;
  allowFrom?: string[];
  useAccessGroups?: boolean;
  resolveChannelName?: () => Promise<{ name?: string; type?: string }>;
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
    allowFrom: overrides?.allowFrom ?? ["*"],
    dmEnabled: true,
    dmPolicy: "open",
    groupDmEnabled: false,
    groupDmChannels: [],
    defaultRequireMention: true,
    groupPolicy: overrides?.groupPolicy ?? "open",
    useAccessGroups: overrides?.useAccessGroups ?? true,
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
    resolveChannelName:
      overrides?.resolveChannelName ?? (async () => ({ name: channelName, type: "channel" })),
    resolveUserName: async () => ({ name: "Ada" }),
  } as unknown;

  const account = { accountId: "acct", config: { commands: { native: false } } } as unknown;

  return { commands, ctx, account, postEphemeral, channelId, channelName };
}

async function runSlashHandler(params: {
  commands: Map<unknown, (args: unknown) => Promise<void>>;
  command: Partial<{
    user_id: string;
    user_name: string;
    channel_id: string;
    channel_name: string;
    text: string;
    trigger_id: string;
  }> &
    Pick<{ channel_id: string; channel_name: string }, "channel_id" | "channel_name">;
}): Promise<{ respond: ReturnType<typeof vi.fn>; ack: ReturnType<typeof vi.fn> }> {
  const handler = [...params.commands.values()][0];
  if (!handler) {
    throw new Error("Missing slash handler");
  }

  const respond = vi.fn().mockResolvedValue(undefined);
  const ack = vi.fn().mockResolvedValue(undefined);

  await handler({
    command: {
      user_id: "U1",
      user_name: "Ada",
      text: "hello",
      trigger_id: "t1",
      ...params.command,
    },
    ack,
    respond,
  });

  return { respond, ack };
}

describe("slack slash commands channel policy", () => {
  it("allows unlisted channels when groupPolicy is open", async () => {
    const { commands, ctx, account, channelId, channelName } = createHarness({
      groupPolicy: "open",
      channelsConfig: { C_LISTED: { requireMention: true } },
      channelId: "C_UNLISTED",
      channelName: "unlisted",
    });
    registerSlackMonitorSlashCommands({ ctx: ctx as never, account: account as never });

    const { respond } = await runSlashHandler({
      commands,
      command: {
        channel_id: channelId,
        channel_name: channelName,
      },
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

    const { respond } = await runSlashHandler({
      commands,
      command: {
        channel_id: channelId,
        channel_name: channelName,
      },
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

    const { respond } = await runSlashHandler({
      commands,
      command: {
        channel_id: channelId,
        channel_name: channelName,
      },
    });

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "This channel is not allowed.",
      response_type: "ephemeral",
    });
  });
});

describe("slack slash commands access groups", () => {
  it("fails closed when channel type lookup returns empty for channels", async () => {
    const { commands, ctx, account, channelId, channelName } = createHarness({
      allowFrom: [],
      channelId: "C_UNKNOWN",
      channelName: "unknown",
      resolveChannelName: async () => ({}),
    });
    registerSlackMonitorSlashCommands({ ctx: ctx as never, account: account as never });

    const { respond } = await runSlashHandler({
      commands,
      command: {
        channel_id: channelId,
        channel_name: channelName,
      },
    });

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "You are not authorized to use this command.",
      response_type: "ephemeral",
    });
  });

  it("still treats D-prefixed channel ids as DMs when lookup fails", async () => {
    const { commands, ctx, account } = createHarness({
      allowFrom: [],
      channelId: "D123",
      channelName: "notdirectmessage",
      resolveChannelName: async () => ({}),
    });
    registerSlackMonitorSlashCommands({ ctx: ctx as never, account: account as never });

    const { respond } = await runSlashHandler({
      commands,
      command: {
        channel_id: "D123",
        channel_name: "notdirectmessage",
      },
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(respond).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: "You are not authorized to use this command." }),
    );
    const dispatchArg = dispatchMock.mock.calls[0]?.[0] as {
      ctx?: { CommandAuthorized?: boolean };
    };
    expect(dispatchArg?.ctx?.CommandAuthorized).toBe(false);
  });

  it("computes CommandAuthorized for DM slash commands when dmPolicy is open", async () => {
    const { commands, ctx, account } = createHarness({
      allowFrom: ["U_OWNER"],
      channelId: "D999",
      channelName: "directmessage",
      resolveChannelName: async () => ({ name: "directmessage", type: "im" }),
    });
    registerSlackMonitorSlashCommands({ ctx: ctx as never, account: account as never });

    await runSlashHandler({
      commands,
      command: {
        user_id: "U_ATTACKER",
        user_name: "Mallory",
        channel_id: "D999",
        channel_name: "directmessage",
      },
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchArg = dispatchMock.mock.calls[0]?.[0] as {
      ctx?: { CommandAuthorized?: boolean };
    };
    expect(dispatchArg?.ctx?.CommandAuthorized).toBe(false);
  });

  it("enforces access-group gating when lookup fails for private channels", async () => {
    const { commands, ctx, account, channelId, channelName } = createHarness({
      allowFrom: [],
      channelId: "G123",
      channelName: "private",
      resolveChannelName: async () => ({}),
    });
    registerSlackMonitorSlashCommands({ ctx: ctx as never, account: account as never });

    const { respond } = await runSlashHandler({
      commands,
      command: {
        channel_id: channelId,
        channel_name: channelName,
      },
    });

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "You are not authorized to use this command.",
      response_type: "ephemeral",
    });
  });
});
