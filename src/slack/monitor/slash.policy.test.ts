import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSlackSlashMocks, resetSlackSlashMocks } from "./slash.test-harness.js";

const { dispatchMock } = getSlackSlashMocks();

beforeEach(() => {
  resetSlackSlashMocks();
});

async function registerCommands(ctx: unknown, account: unknown) {
  const { registerSlackMonitorSlashCommands } = await import("./slash.js");
  registerSlackMonitorSlashCommands({ ctx: ctx as never, account: account as never });
}

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
    await registerCommands(ctx, account);

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
    await registerCommands(ctx, account);

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
    await registerCommands(ctx, account);

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
    await registerCommands(ctx, account);

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
    await registerCommands(ctx, account);

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
    await registerCommands(ctx, account);

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
    await registerCommands(ctx, account);

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
