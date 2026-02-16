import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSlackSlashMocks, resetSlackSlashMocks } from "./slash.test-harness.js";

vi.mock("../../auto-reply/commands-registry.js", () => {
  const usageCommand = { key: "usage", nativeName: "usage" };

  return {
    buildCommandTextFromArgs: (
      cmd: { nativeName?: string; key: string },
      args?: { values?: Record<string, unknown> },
    ) => {
      const name = cmd.nativeName ?? cmd.key;
      const mode = args?.values?.mode;
      return typeof mode === "string" && mode.trim() ? `/${name} ${mode.trim()}` : `/${name}`;
    },
    findCommandByNativeName: (name: string) => {
      return name.trim().toLowerCase() === "usage" ? usageCommand : undefined;
    },
    listNativeCommandSpecsForConfig: () => [
      {
        name: "usage",
        description: "Usage",
        acceptsArgs: true,
        args: [],
      },
    ],
    parseCommandArgs: () => ({ values: {} }),
    resolveCommandArgMenu: (params: {
      command?: { key?: string };
      args?: { values?: unknown };
    }) => {
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
  let argMenuHandler: (args: unknown) => Promise<void>;

  beforeAll(async () => {
    harness = createArgMenusHarness();
    await registerCommands(harness.ctx, harness.account);

    const argMenu = harness.actions.get("openclaw_cmdarg");
    if (!argMenu) {
      throw new Error("Missing arg-menu action handler");
    }
    argMenuHandler = argMenu;
  });

  beforeEach(() => {
    harness.postEphemeral.mockClear();
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
});

function createPolicyHarness() {
  const commands = new Map<unknown, (args: unknown) => Promise<void>>();
  const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  const app = {
    client: { chat: { postEphemeral } },
    command: (name: unknown, handler: (args: unknown) => Promise<void>) => {
      commands.set(name, handler);
    },
  };

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
    groupPolicy: "open",
    useAccessGroups: true,
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
    resolveChannelName: async () => ({ name: "unlisted", type: "channel" }),
    resolveUserName: async () => ({ name: "Ada" }),
  } as Record<string, unknown>;

  const account = { accountId: "acct", config: { commands: { native: false } } } as unknown;

  return { commands, ctx, account, postEphemeral };
}

function resetPolicyHarness(harness: ReturnType<typeof createPolicyHarness>) {
  harness.ctx.allowFrom = ["*"];
  harness.ctx.groupPolicy = "open";
  harness.ctx.useAccessGroups = true;
  harness.ctx.channelsConfig = undefined;
  harness.ctx.resolveChannelName = async () => ({ name: "unlisted", type: "channel" });
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
  let harness: ReturnType<typeof createPolicyHarness>;

  beforeAll(async () => {
    harness = createPolicyHarness();
    await registerCommands(harness.ctx, harness.account);
  });

  beforeEach(() => {
    harness.postEphemeral.mockClear();
    resetPolicyHarness(harness);
  });

  it("blocks unlisted channels when groupPolicy is allowlist", async () => {
    harness.ctx.groupPolicy = "allowlist";
    harness.ctx.channelsConfig = { C_LISTED: { requireMention: true } };
    harness.ctx.resolveChannelName = async () => ({ name: "unlisted", type: "channel" });

    const { respond } = await runSlashHandler({
      commands: harness.commands,
      command: {
        channel_id: "C_UNLISTED",
        channel_name: "unlisted",
      },
    });

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "This channel is not allowed.",
      response_type: "ephemeral",
    });
  });
});
