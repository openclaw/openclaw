import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSlackSlashMocks, resetSlackSlashMocks } from "./slash.test-harness.js";

vi.mock("../../auto-reply/commands-registry.js", () => {
  const usageCommand = { key: "usage", nativeName: "usage" };
  const reportCommand = { key: "report", nativeName: "report" };
  const reportCompactCommand = { key: "reportcompact", nativeName: "reportcompact" };
  const reportExternalCommand = { key: "reportexternal", nativeName: "reportexternal" };
  const reportLongCommand = { key: "reportlong", nativeName: "reportlong" };
  const unsafeConfirmCommand = { key: "unsafeconfirm", nativeName: "unsafeconfirm" };
  const periodArg = { name: "period", description: "period" };
  const baseReportPeriodChoices = [
    { value: "day", label: "day" },
    { value: "week", label: "week" },
    { value: "month", label: "month" },
    { value: "quarter", label: "quarter" },
  ];
  const fullReportPeriodChoices = [...baseReportPeriodChoices, { value: "year", label: "year" }];
  const hasNonEmptyArgValue = (values: unknown, key: string) => {
    const raw =
      typeof values === "object" && values !== null
        ? (values as Record<string, unknown>)[key]
        : undefined;
    return typeof raw === "string" && raw.trim().length > 0;
  };
  const resolvePeriodMenu = (
    params: { args?: { values?: unknown } },
    choices: Array<{
      value: string;
      label: string;
    }>,
  ) => {
    if (hasNonEmptyArgValue(params.args?.values, "period")) {
      return null;
    }
    return { arg: periodArg, choices };
  };

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
      if (normalized === "reportexternal") {
        return reportExternalCommand;
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
        name: "reportexternal",
        description: "ReportExternal",
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
        return resolvePeriodMenu(params, [
          ...fullReportPeriodChoices,
          { value: "all", label: "all" },
        ]);
      }
      if (params.command?.key === "reportlong") {
        return resolvePeriodMenu(params, [
          ...fullReportPeriodChoices,
          { value: "x".repeat(90), label: "long" },
        ]);
      }
      if (params.command?.key === "reportcompact") {
        return resolvePeriodMenu(params, baseReportPeriodChoices);
      }
      if (params.command?.key === "reportexternal") {
        return {
          arg: { name: "period", description: "period" },
          choices: Array.from({ length: 140 }, (_v, i) => ({
            value: `period-${i + 1}`,
            label: `Period ${i + 1}`,
          })),
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createArgMenusHarness() {
  const commands = new Map<string, (args: unknown) => Promise<void>>();
  const actions = new Map<string, (args: unknown) => Promise<void>>();
  const options = new Map<string, (args: unknown) => Promise<void>>();
  const optionsReceiverContexts: unknown[] = [];

  const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  const app = {
    client: { chat: { postEphemeral } },
    command: (name: string, handler: (args: unknown) => Promise<void>) => {
      commands.set(name, handler);
    },
    action: (id: string, handler: (args: unknown) => Promise<void>) => {
      actions.set(id, handler);
    },
    options: function (this: unknown, id: string, handler: (args: unknown) => Promise<void>) {
      optionsReceiverContexts.push(this);
      options.set(id, handler);
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

  return {
    commands,
    actions,
    options,
    optionsReceiverContexts,
    postEphemeral,
    ctx,
    account,
    app,
  };
}

function requireHandler(
  handlers: Map<string, (args: unknown) => Promise<void>>,
  key: string,
  label: string,
): (args: unknown) => Promise<void> {
  const handler = handlers.get(key);
  if (!handler) {
    throw new Error(`Missing ${label} handler`);
  }
  return handler;
}

function createSlashCommand(overrides: Partial<Record<string, string>> = {}) {
  return {
    user_id: "U1",
    user_name: "Ada",
    channel_id: "C1",
    channel_name: "directmessage",
    text: "",
    trigger_id: "t1",
    ...overrides,
  };
}

async function runCommandHandler(handler: (args: unknown) => Promise<void>) {
  const respond = vi.fn().mockResolvedValue(undefined);
  const ack = vi.fn().mockResolvedValue(undefined);
  await handler({
    command: createSlashCommand(),
    ack,
    respond,
  });
  return { respond, ack };
}

function expectArgMenuLayout(respond: ReturnType<typeof vi.fn>): {
  type: string;
  elements?: Array<{ type?: string; action_id?: string; confirm?: unknown }>;
} {
  expect(respond).toHaveBeenCalledTimes(1);
  const payload = respond.mock.calls[0]?.[0] as { blocks?: Array<{ type: string }> };
  expect(payload.blocks?.[0]?.type).toBe("header");
  expect(payload.blocks?.[1]?.type).toBe("section");
  expect(payload.blocks?.[2]?.type).toBe("context");
  return findFirstActionsBlock(payload) ?? { type: "actions", elements: [] };
}

function expectSingleDispatchedSlashBody(expectedBody: string) {
  expect(dispatchMock).toHaveBeenCalledTimes(1);
  const call = dispatchMock.mock.calls[0]?.[0] as { ctx?: { Body?: string } };
  expect(call.ctx?.Body).toBe(expectedBody);
}

async function runArgMenuAction(
  handler: (args: unknown) => Promise<void>,
  params: {
    action: Record<string, unknown>;
    userId?: string;
    userName?: string;
    channelId?: string;
    channelName?: string;
    respond?: ReturnType<typeof vi.fn>;
    includeRespond?: boolean;
  },
) {
  const includeRespond = params.includeRespond ?? true;
  const respond = params.respond ?? vi.fn().mockResolvedValue(undefined);
  const payload: Record<string, unknown> = {
    ack: vi.fn().mockResolvedValue(undefined),
    action: params.action,
    body: {
      user: { id: params.userId ?? "U1", name: params.userName ?? "Ada" },
      channel: { id: params.channelId ?? "C1", name: params.channelName ?? "directmessage" },
      trigger_id: "t1",
    },
  };
  if (includeRespond) {
    payload.respond = respond;
  }
  await handler(payload);
  return respond;
}

describe("Slack native command argument menus", () => {
  let harness: ReturnType<typeof createArgMenusHarness>;
  let usageHandler: (args: unknown) => Promise<void>;
  let reportHandler: (args: unknown) => Promise<void>;
  let reportCompactHandler: (args: unknown) => Promise<void>;
  let reportExternalHandler: (args: unknown) => Promise<void>;
  let reportLongHandler: (args: unknown) => Promise<void>;
  let unsafeConfirmHandler: (args: unknown) => Promise<void>;
  let argMenuHandler: (args: unknown) => Promise<void>;
  let argMenuOptionsHandler: (args: unknown) => Promise<void>;

  beforeAll(async () => {
    harness = createArgMenusHarness();
    await registerCommands(harness.ctx, harness.account);
    usageHandler = requireHandler(harness.commands, "/usage", "/usage");
    reportHandler = requireHandler(harness.commands, "/report", "/report");
    reportCompactHandler = requireHandler(harness.commands, "/reportcompact", "/reportcompact");
    reportExternalHandler = requireHandler(harness.commands, "/reportexternal", "/reportexternal");
    reportLongHandler = requireHandler(harness.commands, "/reportlong", "/reportlong");
    unsafeConfirmHandler = requireHandler(harness.commands, "/unsafeconfirm", "/unsafeconfirm");
    argMenuHandler = requireHandler(harness.actions, "openclaw_cmdarg", "arg-menu action");
    argMenuOptionsHandler = requireHandler(harness.options, "openclaw_cmdarg", "arg-menu options");
  });

  beforeEach(() => {
    harness.postEphemeral.mockClear();
  });

  it("registers options handlers without losing app receiver binding", async () => {
    const testHarness = createArgMenusHarness();
    await registerCommands(testHarness.ctx, testHarness.account);
    expect(testHarness.commands.size).toBeGreaterThan(0);
    expect(testHarness.actions.has("openclaw_cmdarg")).toBe(true);
    expect(testHarness.options.has("openclaw_cmdarg")).toBe(true);
    expect(testHarness.optionsReceiverContexts[0]).toBe(testHarness.app);
  });

  it("shows a button menu when required args are omitted", async () => {
    const { respond } = await runCommandHandler(usageHandler);
    const actions = expectArgMenuLayout(respond);
    const elementType = actions?.elements?.[0]?.type;
    expect(elementType).toBe("button");
    expect(actions?.elements?.[0]?.confirm).toBeTruthy();
  });

  it("shows a static_select menu when choices exceed button row size", async () => {
    const { respond } = await runCommandHandler(reportHandler);
    const actions = expectArgMenuLayout(respond);
    const element = actions?.elements?.[0];
    expect(element?.type).toBe("static_select");
    expect(element?.action_id).toBe("openclaw_cmdarg");
    expect(element?.confirm).toBeTruthy();
  });

  it("falls back to buttons when static_select value limit would be exceeded", async () => {
    const { respond } = await runCommandHandler(reportLongHandler);

    expect(respond).toHaveBeenCalledTimes(1);
    const payload = respond.mock.calls[0]?.[0] as { blocks?: Array<{ type: string }> };
    const actions = findFirstActionsBlock(payload);
    const firstElement = actions?.elements?.[0];
    expect(firstElement?.type).toBe("button");
    expect(firstElement?.confirm).toBeTruthy();
  });

  it("shows an overflow menu when choices fit compact range", async () => {
    const { respond } = await runCommandHandler(reportCompactHandler);

    expect(respond).toHaveBeenCalledTimes(1);
    const payload = respond.mock.calls[0]?.[0] as { blocks?: Array<{ type: string }> };
    const actions = findFirstActionsBlock(payload);
    const element = actions?.elements?.[0];
    expect(element?.type).toBe("overflow");
    expect(element?.action_id).toBe("openclaw_cmdarg");
    expect(element?.confirm).toBeTruthy();
  });

  it("escapes mrkdwn characters in confirm dialog text", async () => {
    const { respond } = await runCommandHandler(unsafeConfirmHandler);

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
    await runArgMenuAction(argMenuHandler, {
      action: {
        value: encodeValue({ command: "usage", arg: "mode", value: "tokens", userId: "U1" }),
      },
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const call = dispatchMock.mock.calls[0]?.[0] as { ctx?: { Body?: string } };
    expect(call.ctx?.Body).toBe("/usage tokens");
  });

  it("dispatches the command when a static_select option is chosen", async () => {
    await runArgMenuAction(argMenuHandler, {
      action: {
        selected_option: {
          value: encodeValue({ command: "report", arg: "period", value: "month", userId: "U1" }),
        },
      },
    });

    expectSingleDispatchedSlashBody("/report month");
  });

  it("dispatches the command when an overflow option is chosen", async () => {
    await runArgMenuAction(argMenuHandler, {
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
    });

    expectSingleDispatchedSlashBody("/reportcompact quarter");
  });

  it("shows an external_select menu when choices exceed static_select options max", async () => {
    const { respond } = await runCommandHandler(reportExternalHandler);

    expect(respond).toHaveBeenCalledTimes(1);
    const payload = respond.mock.calls[0]?.[0] as {
      blocks?: Array<{ type: string; block_id?: string }>;
    };
    const actions = findFirstActionsBlock(payload);
    const element = actions?.elements?.[0];
    expect(element?.type).toBe("external_select");
    expect(element?.action_id).toBe("openclaw_cmdarg");
    const blockId = payload.blocks?.find((block) => block.type === "actions")?.block_id;
    expect(blockId).toContain("openclaw_cmdarg_ext:");
    const token = (blockId ?? "").slice("openclaw_cmdarg_ext:".length);
    expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });

  it("serves filtered options for external_select menus", async () => {
    const { respond } = await runCommandHandler(reportExternalHandler);

    const payload = respond.mock.calls[0]?.[0] as {
      blocks?: Array<{ type: string; block_id?: string }>;
    };
    const blockId = payload.blocks?.find((block) => block.type === "actions")?.block_id;
    expect(blockId).toContain("openclaw_cmdarg_ext:");

    const ackOptions = vi.fn().mockResolvedValue(undefined);
    await argMenuOptionsHandler({
      ack: ackOptions,
      body: {
        user: { id: "U1" },
        value: "period 12",
        actions: [{ block_id: blockId }],
      },
    });

    expect(ackOptions).toHaveBeenCalledTimes(1);
    const optionsPayload = ackOptions.mock.calls[0]?.[0] as {
      options?: Array<{ text?: { text?: string }; value?: string }>;
    };
    const optionTexts = (optionsPayload.options ?? []).map((option) => option.text?.text ?? "");
    expect(optionTexts.some((text) => text.includes("Period 12"))).toBe(true);
  });

  it("rejects external_select option requests without user identity", async () => {
    const { respond } = await runCommandHandler(reportExternalHandler);

    const payload = respond.mock.calls[0]?.[0] as {
      blocks?: Array<{ type: string; block_id?: string }>;
    };
    const blockId = payload.blocks?.find((block) => block.type === "actions")?.block_id;
    expect(blockId).toContain("openclaw_cmdarg_ext:");

    const ackOptions = vi.fn().mockResolvedValue(undefined);
    await argMenuOptionsHandler({
      ack: ackOptions,
      body: {
        value: "period 1",
        actions: [{ block_id: blockId }],
      },
    });

    expect(ackOptions).toHaveBeenCalledTimes(1);
    expect(ackOptions).toHaveBeenCalledWith({ options: [] });
  });

  it("rejects menu clicks from other users", async () => {
    const respond = await runArgMenuAction(argMenuHandler, {
      action: {
        value: encodeValue({ command: "usage", arg: "mode", value: "tokens", userId: "U1" }),
      },
      userId: "U2",
      userName: "Eve",
    });

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "That menu is for another user.",
      response_type: "ephemeral",
    });
  });

  it("falls back to postEphemeral with token when respond is unavailable", async () => {
    await runArgMenuAction(argMenuHandler, {
      action: { value: "garbage" },
      includeRespond: false,
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
    await runArgMenuAction(argMenuHandler, {
      action: { value: "cmdarg|%E0%A4%A|mode|on|U1" },
      includeRespond: false,
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

async function registerAndRunPolicySlash(params: {
  harness: ReturnType<typeof createPolicyHarness>;
  command?: Partial<{
    user_id: string;
    user_name: string;
    channel_id: string;
    channel_name: string;
    text: string;
    trigger_id: string;
  }>;
}) {
  await registerCommands(params.harness.ctx, params.harness.account);
  return await runSlashHandler({
    commands: params.harness.commands,
    command: {
      channel_id: params.command?.channel_id ?? params.harness.channelId,
      channel_name: params.command?.channel_name ?? params.harness.channelName,
      ...params.command,
    },
  });
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
    const harness = createPolicyHarness({
      groupPolicy: "open",
      channelsConfig: { C_LISTED: { requireMention: true } },
      channelId: "C_UNLISTED",
      channelName: "unlisted",
    });
    const { respond } = await registerAndRunPolicySlash({ harness });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(respond).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: "This channel is not allowed." }),
    );
  });

  it("blocks explicitly denied channels when groupPolicy is open", async () => {
    const harness = createPolicyHarness({
      groupPolicy: "open",
      channelsConfig: { C_DENIED: { allow: false } },
      channelId: "C_DENIED",
      channelName: "denied",
    });
    const { respond } = await registerAndRunPolicySlash({ harness });

    expectChannelBlockedResponse(respond);
  });

  it("blocks unlisted channels when groupPolicy is allowlist", async () => {
    const harness = createPolicyHarness({
      groupPolicy: "allowlist",
      channelsConfig: { C_LISTED: { requireMention: true } },
      channelId: "C_UNLISTED",
      channelName: "unlisted",
    });
    const { respond } = await registerAndRunPolicySlash({ harness });

    expectChannelBlockedResponse(respond);
  });
});

describe("slack slash commands access groups", () => {
  it("fails closed when channel type lookup returns empty for channels", async () => {
    const harness = createPolicyHarness({
      allowFrom: [],
      channelId: "C_UNKNOWN",
      channelName: "unknown",
      resolveChannelName: async () => ({}),
    });
    const { respond } = await registerAndRunPolicySlash({ harness });

    expectUnauthorizedResponse(respond);
  });

  it("still treats D-prefixed channel ids as DMs when lookup fails", async () => {
    const harness = createPolicyHarness({
      allowFrom: [],
      channelId: "D123",
      channelName: "notdirectmessage",
      resolveChannelName: async () => ({}),
    });
    const { respond } = await registerAndRunPolicySlash({
      harness,
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
    const harness = createPolicyHarness({
      allowFrom: ["U_OWNER"],
      channelId: "D999",
      channelName: "directmessage",
      resolveChannelName: async () => ({ name: "directmessage", type: "im" }),
    });
    await registerAndRunPolicySlash({
      harness,
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
    const harness = createPolicyHarness({
      allowFrom: [],
      channelId: "G123",
      channelName: "private",
      resolveChannelName: async () => ({}),
    });
    const { respond } = await registerAndRunPolicySlash({ harness });

    expectUnauthorizedResponse(respond);
  });
});

describe("slack slash command session metadata", () => {
  const { recordSessionMetaFromInboundMock } = getSlackSlashMocks();

  it("calls recordSessionMetaFromInbound after dispatching a slash command", async () => {
    const harness = createPolicyHarness({ groupPolicy: "open" });
    await registerAndRunPolicySlash({ harness });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(recordSessionMetaFromInboundMock).toHaveBeenCalledTimes(1);
    const call = recordSessionMetaFromInboundMock.mock.calls[0]?.[0] as {
      sessionKey?: string;
      ctx?: { OriginatingChannel?: string };
    };
    expect(call.ctx?.OriginatingChannel).toBe("slack");
    expect(call.sessionKey).toBeDefined();
  });

  it("awaits session metadata persistence before dispatch", async () => {
    const deferred = createDeferred<void>();
    recordSessionMetaFromInboundMock.mockClear().mockReturnValue(deferred.promise);

    const harness = createPolicyHarness({ groupPolicy: "open" });
    await registerCommands(harness.ctx, harness.account);

    const runPromise = runSlashHandler({
      commands: harness.commands,
      command: {
        channel_id: harness.channelId,
        channel_name: harness.channelName,
      },
    });

    await vi.waitFor(() => {
      expect(recordSessionMetaFromInboundMock).toHaveBeenCalledTimes(1);
    });
    expect(dispatchMock).not.toHaveBeenCalled();

    deferred.resolve();
    await runPromise;

    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });
});
