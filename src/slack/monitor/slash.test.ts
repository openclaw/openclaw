import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSlackSlashMocks, resetSlackSlashMocks } from "./slash.test-harness.js";

vi.mock("../../auto-reply/commands-registry.js", () => {
  const usageCommand = { key: "usage", nativeName: "usage" };
  const reportCommand = { key: "report", nativeName: "report" };
  const reportCompactCommand = { key: "reportcompact", nativeName: "reportcompact" };
  const reportLongCommand = { key: "reportlong", nativeName: "reportlong" };
  const unsafeConfirmCommand = { key: "unsafeconfirm", nativeName: "unsafeconfirm" };

  return {
    buildCommandTextFromArgs: (
      cmd: { nativeName?: string; key: string },
      args?: { values?: Record<string, unknown> },
    ) => {
      const name = cmd.nativeName ?? cmd.key;
      const values = args?.values ?? {};
      const mode = values.mode;
      const period = values.period;
      const selected =
        typeof mode === "string" && mode.trim()
          ? mode.trim()
          : typeof period === "string" && period.trim()
            ? period.trim()
            : "";
      return selected ? `/${name} ${selected}` : `/${name}`;
    },
    findCommandByNativeName: (name: string) => {
      const normalized = name.trim().toLowerCase();
      if (normalized === "usage") {
        return usageCommand;
      }
      if (normalized === "report") {
        return reportCommand;
      }
      if (normalized === "reportcompact") {
        return reportCompactCommand;
      }
      if (normalized === "reportlong") {
        return reportLongCommand;
      }
      if (normalized === "unsafeconfirm") {
        return unsafeConfirmCommand;
      }
      return undefined;
    },
    listNativeCommandSpecsForConfig: () => [
      {
        name: "usage",
        description: "Usage",
        acceptsArgs: true,
        args: [],
      },
      {
        name: "report",
        description: "Report",
        acceptsArgs: true,
        args: [],
      },
      {
        name: "reportcompact",
        description: "ReportCompact",
        acceptsArgs: true,
        args: [],
      },
      {
        name: "reportlong",
        description: "ReportLong",
        acceptsArgs: true,
        args: [],
      },
      {
        name: "unsafeconfirm",
        description: "UnsafeConfirm",
        acceptsArgs: true,
        args: [],
      },
    ],
    parseCommandArgs: () => ({ values: {} }),
    resolveCommandArgMenu: (params: {
      command?: { key?: string };
      args?: { values?: unknown };
    }) => {
      if (params.command?.key === "report") {
        const values = (params.args?.values ?? {}) as Record<string, unknown>;
        if (typeof values.period === "string" && values.period.trim()) {
          return null;
        }
        return {
          arg: { name: "period", description: "period" },
          choices: [
            { value: "day", label: "day" },
            { value: "week", label: "week" },
            { value: "month", label: "month" },
            { value: "quarter", label: "quarter" },
            { value: "year", label: "year" },
            { value: "all", label: "all" },
          ],
        };
      }
      if (params.command?.key === "reportlong") {
        const values = (params.args?.values ?? {}) as Record<string, unknown>;
        if (typeof values.period === "string" && values.period.trim()) {
          return null;
        }
        return {
          arg: { name: "period", description: "period" },
          choices: [
            { value: "day", label: "day" },
            { value: "week", label: "week" },
            { value: "month", label: "month" },
            { value: "quarter", label: "quarter" },
            { value: "year", label: "year" },
            { value: "x".repeat(90), label: "long" },
          ],
        };
      }
      if (params.command?.key === "reportcompact") {
        const values = (params.args?.values ?? {}) as Record<string, unknown>;
        if (typeof values.period === "string" && values.period.trim()) {
          return null;
        }
        return {
          arg: { name: "period", description: "period" },
          choices: [
            { value: "day", label: "day" },
            { value: "week", label: "week" },
            { value: "month", label: "month" },
            { value: "quarter", label: "quarter" },
          ],
        };
      }
      if (params.command?.key === "unsafeconfirm") {
        return {
          arg: { name: "mode_*`~<&>", description: "mode" },
          choices: [
            { value: "on", label: "on" },
            { value: "off", label: "off" },
          ],
        };
      }
      if (params.command?.key !== "usage") {
        return null;
      }
      const values = (params.args?.values ?? {}) as Record<string, unknown>;
      if (typeof values.mode === "string" && values.mode.trim()) {
        return null;
      }
      return {
        arg: { name: "mode", description: "mode" },
        choices: [
          { value: "tokens", label: "tokens" },
          { value: "cost", label: "cost" },
        ],
      };
    },
  };
});

type RegisterFn = (params: { ctx: unknown; account: unknown }) => Promise<void>;
let registerSlackMonitorSlashCommands: RegisterFn;

const { dispatchMock } = getSlackSlashMocks();

beforeAll(async () => {
  ({ registerSlackMonitorSlashCommands } = (await import("./slash.js")) as unknown as {
    registerSlackMonitorSlashCommands: RegisterFn;
  });
});

beforeEach(() => {
  resetSlackSlashMocks();
});

async function registerCommands(ctx: unknown, account: unknown) {
  await registerSlackMonitorSlashCommands({ ctx: ctx as never, account: account as never });
}

function encodeValue(parts: { command: string; arg: string; value: string; userId: string }) {
  return [
    "cmdarg",
    encodeURIComponent(parts.command),
    encodeURIComponent(parts.arg),
    encodeURIComponent(parts.value),
    encodeURIComponent(parts.userId),
  ].join("|");
}

function findFirstActionsBlock(payload: { blocks?: Array<{ type: string }> }) {
  return payload.blocks?.find((block) => block.type === "actions") as
    | { type: string; elements?: Array<{ type?: string; action_id?: string; confirm?: unknown }> }
    | undefined;
}

function createArgMenusHarness() {
  const commands = new Map<string, (args: unknown) => Promise<void>>();
  const actions = new Map<string, (args: unknown) => Promise<void>>();

  const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  const app = {
    client: { chat: { postEphemeral } },
    command: (name: string, handler: (args: unknown) => Promise<void>) => {
      commands.set(name, handler);
    },
    action: (id: string, handler: (args: unknown) => Promise<void>) => {
      actions.set(id, handler);
    },
  };

  const ctx = {
    cfg: { commands: { native: true, nativeSkills: false } },
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
    groupPolicy: "open",
    useAccessGroups: false,
    channelsConfig: undefined,
    slashCommand: {
      enabled: true,
      name: "openclaw",
      ephemeral: true,
      sessionPrefix: "slack:slash",
    },
    textLimit: 4000,
    app,
    isChannelAllowed: () => true,
    resolveChannelName: async () => ({ name: "dm", type: "im" }),
    resolveUserName: async () => ({ name: "Ada" }),
  } as unknown;

  const account = {
    accountId: "acct",
    config: { commands: { native: true, nativeSkills: false } },
  } as unknown;

  return { commands, actions, postEphemeral, ctx, account };
}

describe("Slack native command argument menus", () => {
  let harness: ReturnType<typeof createArgMenusHarness>;
  let usageHandler: (args: unknown) => Promise<void>;
  let reportHandler: (args: unknown) => Promise<void>;
  let reportCompactHandler: (args: unknown) => Promise<void>;
  let reportLongHandler: (args: unknown) => Promise<void>;
  let unsafeConfirmHandler: (args: unknown) => Promise<void>;
  let argMenuHandler: (args: unknown) => Promise<void>;

  beforeAll(async () => {
    harness = createArgMenusHarness();
    await registerCommands(harness.ctx, harness.account);

    const usage = harness.commands.get("/usage");
    if (!usage) {
      throw new Error("Missing /usage handler");
    }
    usageHandler = usage;
    const report = harness.commands.get("/report");
    if (!report) {
      throw new Error("Missing /report handler");
    }
    reportHandler = report;
    const reportCompact = harness.commands.get("/reportcompact");
    if (!reportCompact) {
      throw new Error("Missing /reportcompact handler");
    }
    reportCompactHandler = reportCompact;
    const reportLong = harness.commands.get("/reportlong");
    if (!reportLong) {
      throw new Error("Missing /reportlong handler");
    }
    reportLongHandler = reportLong;
    const unsafeConfirm = harness.commands.get("/unsafeconfirm");
    if (!unsafeConfirm) {
      throw new Error("Missing /unsafeconfirm handler");
    }
    unsafeConfirmHandler = unsafeConfirm;

    const argMenu = harness.actions.get("openclaw_cmdarg");
    if (!argMenu) {
      throw new Error("Missing arg-menu action handler");
    }
    argMenuHandler = argMenu;
  });

  beforeEach(() => {
    harness.postEphemeral.mockClear();
  });

  it("shows a button menu when required args are omitted", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const ack = vi.fn().mockResolvedValue(undefined);

    await usageHandler({
      command: {
        user_id: "U1",
        user_name: "Ada",
        channel_id: "C1",
        channel_name: "directmessage",
        text: "",
        trigger_id: "t1",
      },
      ack,
      respond,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    const payload = respond.mock.calls[0]?.[0] as { blocks?: Array<{ type: string }> };
    expect(payload.blocks?.[0]?.type).toBe("header");
    expect(payload.blocks?.[1]?.type).toBe("section");
    expect(payload.blocks?.[2]?.type).toBe("context");
    const actions = findFirstActionsBlock(payload);
    const elementType = actions?.elements?.[0]?.type;
    expect(elementType).toBe("button");
    expect(actions?.elements?.[0]?.confirm).toBeTruthy();
  });

  it("shows a static_select menu when choices exceed button row size", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const ack = vi.fn().mockResolvedValue(undefined);

    await reportHandler({
      command: {
        user_id: "U1",
        user_name: "Ada",
        channel_id: "C1",
        channel_name: "directmessage",
        text: "",
        trigger_id: "t1",
      },
      ack,
      respond,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    const payload = respond.mock.calls[0]?.[0] as { blocks?: Array<{ type: string }> };
    expect(payload.blocks?.[0]?.type).toBe("header");
    expect(payload.blocks?.[1]?.type).toBe("section");
    expect(payload.blocks?.[2]?.type).toBe("context");
    const actions = findFirstActionsBlock(payload);
    const element = actions?.elements?.[0];
    expect(element?.type).toBe("static_select");
    expect(element?.action_id).toBe("openclaw_cmdarg");
    expect(element?.confirm).toBeTruthy();
  });

  it("falls back to buttons when static_select value limit would be exceeded", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const ack = vi.fn().mockResolvedValue(undefined);

    await reportLongHandler({
      command: {
        user_id: "U1",
        user_name: "Ada",
        channel_id: "C1",
        channel_name: "directmessage",
        text: "",
        trigger_id: "t1",
      },
      ack,
      respond,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    const payload = respond.mock.calls[0]?.[0] as { blocks?: Array<{ type: string }> };
    const actions = findFirstActionsBlock(payload);
    const firstElement = actions?.elements?.[0];
    expect(firstElement?.type).toBe("button");
    expect(firstElement?.confirm).toBeTruthy();
  });

  it("shows an overflow menu when choices fit compact range", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const ack = vi.fn().mockResolvedValue(undefined);

    await reportCompactHandler({
      command: {
        user_id: "U1",
        user_name: "Ada",
        channel_id: "C1",
        channel_name: "directmessage",
        text: "",
        trigger_id: "t1",
      },
      ack,
      respond,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    const payload = respond.mock.calls[0]?.[0] as { blocks?: Array<{ type: string }> };
    const actions = findFirstActionsBlock(payload);
    const element = actions?.elements?.[0];
    expect(element?.type).toBe("overflow");
    expect(element?.action_id).toBe("openclaw_cmdarg");
    expect(element?.confirm).toBeTruthy();
  });

  it("escapes mrkdwn characters in confirm dialog text", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const ack = vi.fn().mockResolvedValue(undefined);

    await unsafeConfirmHandler({
      command: {
        user_id: "U1",
        user_name: "Ada",
        channel_id: "C1",
        channel_name: "directmessage",
        text: "",
        trigger_id: "t1",
      },
      ack,
      respond,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    const payload = respond.mock.calls[0]?.[0] as { blocks?: Array<{ type: string }> };
    const actions = findFirstActionsBlock(payload);
    const element = actions?.elements?.[0] as
      | { confirm?: { text?: { text?: string } } }
      | undefined;
    expect(element?.confirm?.text?.text).toContain(
      "Run */unsafeconfirm* with *mode\\_\\*\\`\\~&lt;&amp;&gt;* set to this value?",
    );
  });

  it("dispatches the command when a menu button is clicked", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    await argMenuHandler({
      ack: vi.fn().mockResolvedValue(undefined),
      action: {
        value: encodeValue({ command: "usage", arg: "mode", value: "tokens", userId: "U1" }),
      },
      body: {
        user: { id: "U1", name: "Ada" },
        channel: { id: "C1", name: "directmessage" },
        trigger_id: "t1",
      },
      respond,
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const call = dispatchMock.mock.calls[0]?.[0] as { ctx?: { Body?: string } };
    expect(call.ctx?.Body).toBe("/usage tokens");
  });

  it("dispatches the command when a static_select option is chosen", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    await argMenuHandler({
      ack: vi.fn().mockResolvedValue(undefined),
      action: {
        selected_option: {
          value: encodeValue({ command: "report", arg: "period", value: "month", userId: "U1" }),
        },
      },
      body: {
        user: { id: "U1", name: "Ada" },
        channel: { id: "C1", name: "directmessage" },
        trigger_id: "t1",
      },
      respond,
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const call = dispatchMock.mock.calls[0]?.[0] as { ctx?: { Body?: string } };
    expect(call.ctx?.Body).toBe("/report month");
  });

  it("dispatches the command when an overflow option is chosen", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    await argMenuHandler({
      ack: vi.fn().mockResolvedValue(undefined),
      action: {
        selected_option: {
          value: encodeValue({
            command: "reportcompact",
            arg: "period",
            value: "quarter",
            userId: "U1",
          }),
        },
      },
      body: {
        user: { id: "U1", name: "Ada" },
        channel: { id: "C1", name: "directmessage" },
        trigger_id: "t1",
      },
      respond,
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const call = dispatchMock.mock.calls[0]?.[0] as { ctx?: { Body?: string } };
    expect(call.ctx?.Body).toBe("/reportcompact quarter");
  });

  it("rejects menu clicks from other users", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    await argMenuHandler({
      ack: vi.fn().mockResolvedValue(undefined),
      action: {
        value: encodeValue({ command: "usage", arg: "mode", value: "tokens", userId: "U1" }),
      },
      body: {
        user: { id: "U2", name: "Eve" },
        channel: { id: "C1", name: "directmessage" },
        trigger_id: "t1",
      },
      respond,
    });

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "That menu is for another user.",
      response_type: "ephemeral",
    });
  });

  it("falls back to postEphemeral with token when respond is unavailable", async () => {
    await argMenuHandler({
      ack: vi.fn().mockResolvedValue(undefined),
      action: { value: "garbage" },
      body: { user: { id: "U1" }, channel: { id: "C1" } },
    });

    expect(harness.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "bot-token",
        channel: "C1",
        user: "U1",
      }),
    );
  });

  it("treats malformed percent-encoding as an invalid button (no throw)", async () => {
    await argMenuHandler({
      ack: vi.fn().mockResolvedValue(undefined),
      action: { value: "cmdarg|%E0%A4%A|mode|on|U1" },
      body: { user: { id: "U1" }, channel: { id: "C1" } },
    });

    expect(harness.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "bot-token",
        channel: "C1",
        user: "U1",
        text: "Sorry, that button is no longer valid.",
      }),
    );
  });
});

function createPolicyHarness(overrides?: {
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

function expectChannelBlockedResponse(respond: ReturnType<typeof vi.fn>) {
  expect(dispatchMock).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith({
    text: "This channel is not allowed.",
    response_type: "ephemeral",
  });
}

function expectUnauthorizedResponse(respond: ReturnType<typeof vi.fn>) {
  expect(dispatchMock).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith({
    text: "You are not authorized to use this command.",
    response_type: "ephemeral",
  });
}

describe("slack slash commands channel policy", () => {
  it("allows unlisted channels when groupPolicy is open", async () => {
    const { commands, ctx, account, channelId, channelName } = createPolicyHarness({
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
    const { commands, ctx, account, channelId, channelName } = createPolicyHarness({
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

    expectChannelBlockedResponse(respond);
  });

  it("blocks unlisted channels when groupPolicy is allowlist", async () => {
    const { commands, ctx, account, channelId, channelName } = createPolicyHarness({
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

    expectChannelBlockedResponse(respond);
  });
});

describe("slack slash commands access groups", () => {
  it("fails closed when channel type lookup returns empty for channels", async () => {
    const { commands, ctx, account, channelId, channelName } = createPolicyHarness({
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

    expectUnauthorizedResponse(respond);
  });

  it("still treats D-prefixed channel ids as DMs when lookup fails", async () => {
    const { commands, ctx, account } = createPolicyHarness({
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
    const { commands, ctx, account } = createPolicyHarness({
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
    const { commands, ctx, account, channelId, channelName } = createPolicyHarness({
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

    expectUnauthorizedResponse(respond);
  });
});
