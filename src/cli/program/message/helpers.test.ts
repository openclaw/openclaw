import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addTestHook, createMockPluginRegistry } from "../../../plugins/hooks.test-helpers.js";
import {
  applyResolvedCommandOutputMode,
  withConsoleLogsRoutedToStderrForJson,
} from "../../json-output-mode.js";

const messageCommandMock = vi.fn(
  async (_options: Record<string, unknown>): Promise<unknown> => undefined,
);
// mock-isolation: Parser fixtures capture dispatch without executing channel sends.
vi.mock("../../../commands/message.js", () => ({ messageCommand: messageCommandMock }));

const ensureConfigReadyMock = vi.fn(async () => {});
vi.mock("../config-guard.js", () => ({ ensureConfigReady: ensureConfigReadyMock }));

const getChannelPluginMock = vi.fn();
// mock-isolation: Action support comes from synthetic plugins, not the runtime registry.
vi.mock("../../../channels/plugins/index.js", () => ({ getChannelPlugin: getChannelPluginMock }));

const resolveGatewayDelegatedChannelPluginMock = vi.fn();
// mock-isolation: Manifest delegation comes from synthetic adapters, not installed plugin state.
vi.mock("../../../channels/plugins/read-only.js", () => ({
  resolveGatewayDelegatedChannelPlugin: resolveGatewayDelegatedChannelPluginMock,
}));

// mock-isolation: Terminal styling and verbose state must not affect parser output assertions.
vi.mock("../../../globals.js", () => ({ danger: (s: string) => s, setVerbose: vi.fn() }));

const pluginRegistry = createMockPluginRegistry([]);
const loadPluginRegistryHandleMock = vi.fn(() => pluginRegistry);
// mock-isolation: Message helper fixtures use empty config without reading operator state.
vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  loadConfig: () => ({}),
  captureRuntimeConfigAsyncReader: () => async () => ({}),
}));
vi.mock("../../../plugins/channel-plugin-ids.js", () => ({
  resolveConfiguredChannelPluginIds: () => ["configured-channel"],
  resolveDiscoverableScopedChannelPluginIds: (params: { channelIds: string[] }) =>
    params.channelIds,
}));
vi.mock("../../../plugins/loader.js", () => ({
  loadPluginRegistryHandle: loadPluginRegistryHandleMock,
}));

const runGatewayStopMock = vi.fn(
  async (_eventValue: { reason?: string }, _ctx: Record<string, unknown>) => {},
);
const hookErrorMock = vi.hoisted(() => vi.fn());
// mock-isolation: Hook failures are captured without configuring process-global log sinks.
vi.mock("../../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ debug: vi.fn(), warn: hookErrorMock, error: hookErrorMock }),
}));

function registerStopHook() {
  addTestHook({
    registry: pluginRegistry,
    pluginId: "test-plugin",
    hookName: "gateway_stop",
    handler: runGatewayStopMock,
  });
}

const exitMock = vi.fn((_code: number): never => {
  throw new Error("exit");
});
const errorMock = vi.fn();
const runtimeMock = { log: vi.fn(), error: errorMock, exit: exitMock };
vi.mock("../../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime.js")>()),
  defaultRuntime: runtimeMock,
}));

// Forward to the same synchronous-throwing exit mock: runMessageAction only defers the
// real exit via the one-shot output drain, which these tests don't exercise directly.
vi.mock("../../one-shot-exit.js", () => ({
  requestExitAfterOneShotOutput: (runtime: { exit: (code: number) => never }, exitCode = 0) => {
    runtime.exit(exitCode);
    return true;
  },
}));

// mock-isolation: Captured command dispatch does not need installed runtime providers.
vi.mock("../../deps.js", () => ({ createDefaultDeps: () => ({}) }));

const { registerMessageCommands } = await import("../register.message.js");
const { initializeGlobalHookRunner, resetGlobalHookRunner } =
  await import("../../../plugins/hook-runner-global.js");
afterEach(resetGlobalHookRunner);

const NON_NEGATIVE_INTEGER_FLAGS = new Set(["--delete-days", "--duration-min"]);

const baseSendOptions = { channel: "discord", target: "123", message: "hi" };

async function parseAction(action: string, opts: Record<string, unknown>) {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
  registerMessageCommands(program, {
    programVersion: "test",
    messageChannelOptions: "discord|telegram",
    agentChannelOptions: "last|discord|telegram",
  });
  const commandPath = action === "list-pins" ? ["pins"] : action.split("-");
  let command = program.commands.find((candidate) => candidate.name() === "message");
  for (const name of commandPath) {
    command = command?.commands.find((candidate) => candidate.name() === name);
  }
  if (!command) {
    throw new Error(`unknown message fixture action: ${action}`);
  }
  const defaults: Record<string, unknown> = {
    pollQuestion: "Ship it?",
    pollOption: ["Yes", "No"],
    threadName: "ops",
  };
  const argv = ["message", ...commandPath];
  for (const [key, value] of Object.entries({ ...defaults, ...opts })) {
    const option = command.options.find((candidate) => candidate.attributeName() === key);
    if (!option || value === undefined) {
      continue;
    }
    const flag = option.long;
    if (!flag) {
      throw new Error(`missing fixture option flag: ${key}`);
    }
    if (value === true) {
      argv.push(flag);
    } else if (typeof value === "string" || Array.isArray(value)) {
      const values = typeof value === "string" ? [value] : value;
      if (option.variadic) {
        argv.push(flag, ...values);
      } else {
        argv.push(...values.map((item) => `${flag}=${item}`));
      }
    } else if (value !== false) {
      // Exercise typed-invalid values through Commander's public option API.
      command.setOptionValue(key, value);
    }
  }
  return program.parseAsync(argv, { from: "user" });
}

async function runSendAction(opts: Record<string, unknown> = {}) {
  await runAction("send", { ...baseSendOptions, ...opts });
}

async function runAction(action: string, opts: Record<string, unknown>) {
  await expect(parseAction(action, opts)).rejects.toThrow("exit");
}

function registerRootStopHook() {
  const rootStop = vi.fn();
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      { hookName: "gateway_stop", handler: rootStop, pluginId: "process-root" },
    ]),
  );
  return rootStop;
}

function mockChannelExecutionModes(modes: Record<string, "gateway" | "local"> = {}) {
  getChannelPluginMock.mockImplementation((id: string) => ({
    actions: { resolveExecutionMode: () => modes[id] ?? "local" },
  }));
}

function expectMessageCommandOptions(expected: Record<string, unknown>): void {
  expect(messageCommandMock).toHaveBeenCalledWith(
    expect.objectContaining(expected),
    expect.anything(),
    expect.anything(),
  );
  expect(messageCommandMock.mock.calls[0]?.[0]).not.toHaveProperty("account");
}

function expectRegistryLoad(pluginIds: string[]): void {
  expect(loadPluginRegistryHandleMock).toHaveBeenCalledWith(
    expect.objectContaining({ onlyPluginIds: pluginIds, throwOnLoadError: true }),
  );
  expect(ensureConfigReadyMock).toHaveBeenCalledBefore(loadPluginRegistryHandleMock);
}

function expectConfigReady(action: string, validateConfigOnly: boolean, json = false): void {
  expect(ensureConfigReadyMock).toHaveBeenCalledExactlyOnceWith({
    runtime: runtimeMock,
    commandPath: ["message", action],
    measure: expect.any(Function),
    suppressDoctorStdout: json,
    validateConfigOnly,
  });
  if (!json) {
    expect(ensureConfigReadyMock).toHaveBeenCalledBefore(messageCommandMock);
  }
}

function expectRejectedBeforeDispatch(error: string): void {
  expect(errorMock).toHaveBeenCalledWith(error);
  expect(loadPluginRegistryHandleMock).not.toHaveBeenCalled();
  expect(messageCommandMock).not.toHaveBeenCalled();
  expect(exitMock).toHaveBeenCalledExactlyOnceWith(1);
}

function mockResult(action: string, payload: unknown, extra: Record<string, unknown> = {}) {
  messageCommandMock.mockResolvedValueOnce({
    kind: ["send", "broadcast"].includes(action) ? action : "action",
    channel: "telegram",
    action,
    to: "123",
    handledBy: "core",
    payload,
    dryRun: false,
    ...extra,
  });
}

describe("message actions through the CLI parser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getChannelPluginMock.mockReset();
    resolveGatewayDelegatedChannelPluginMock.mockReset();
    mockChannelExecutionModes({ telegram: "gateway" });
    ensureConfigReadyMock.mockReset().mockResolvedValue(undefined);
    messageCommandMock.mockResolvedValue(undefined);
    pluginRegistry.typedHooks.length = 0;
    resetGlobalHookRunner();
    runGatewayStopMock.mockResolvedValue(undefined);
  });

  it.each([
    { name: "sent", status: "sent" as const, exitCode: 0 },
    { name: "suppressed", status: "suppressed" as const, exitCode: 1 },
    { name: "failed", status: "failed" as const, exitCode: 1 },
    { name: "partial_failed", status: "partial_failed" as const, exitCode: 1 },
    { name: "dry-run", status: undefined, dryRun: true, exitCode: 0 },
  ])("propagates $name send outcomes", async ({ status, dryRun, exitCode }) => {
    const sendResult = {
      channel: "discord",
      to: "channel:123",
      via: "direct" as const,
      mediaUrl: null,
      deliveryStatus: status,
    };
    mockResult("send", sendResult, {
      channel: "discord",
      to: "channel:123",
      sendResult,
      dryRun: Boolean(dryRun),
    });
    await runSendAction({ target: "channel:123", dryRun });
    expect(exitMock).toHaveBeenCalledWith(exitCode);
  });

  it.each(["", "   "])("rejects blank channel %j before startup", async (channel) => {
    await expect(
      parseAction("send", { ...baseSendOptions, channel, target: "channel:123" }),
    ).rejects.toThrow("--channel must not be blank");
    expect(loadPluginRegistryHandleMock).not.toHaveBeenCalled();
    expect(messageCommandMock).not.toHaveBeenCalled();
  });

  it.each([
    ["disabled reaction", "react", { ok: false, hint: "Reactions are disabled." }, 1],
    ["rejected added reaction", "react", { ok: false, warning: "Unavailable", added: "✅" }, 1],
    ["rejected delete", "delete", { ok: false, deleted: false, warning: "Not deleted" }, 1],
    ["rejected send", "send", { ok: false, error: "Message rejected" }, 1],
    ["successful reaction", "react", { ok: true, added: "✅" }, 0],
    ["legacy reaction", "react", { added: "✅" }, 0],
    ["non-boolean outcome", "react", { ok: "false", added: "✅" }, 0],
    ["dry-run", "react", { ok: false, error: "Not executed" }, 0],
  ] as const)("propagates %s", async (name, action, payload, exitCode) => {
    const dryRun = name === "dry-run";
    mockResult(action, payload, { handledBy: "plugin", dryRun });
    const opts = {
      react: { messageId: "456", emoji: "✅" },
      delete: { messageId: "456" },
      send: { message: "hello" },
    }[action];
    await runAction(action, { channel: "telegram", target: "123", ...opts, dryRun });
    expect(exitMock).toHaveBeenCalledWith(exitCode);
  });

  it.each([
    ["123", "configured-channel"],
    ["discord:channel:12345", "discord"],
  ])("scopes plugin loading for target %s", async (target, pluginId) => {
    await runSendAction({ channel: undefined, target });
    expectRegistryLoad([pluginId]);
  });

  it("keeps unknown actions on the local preload path", async () => {
    getChannelPluginMock.mockReturnValue({
      actions: {
        resolveExecutionMode: () => "gateway",
        resolveCliActionRequest: ({ args }: { args: Record<string, unknown> }) => ({
          action: "custom-action",
          args,
        }),
      },
    });
    await runAction("thread-create", { ...baseSendOptions, target: "channel:12345" });
    expectRegistryLoad(["discord"]);
    expectMessageCommandOptions({ action: "custom-action" });
  });

  it("skips local preload for reads an external channel manifest delegates to the Gateway", async () => {
    getChannelPluginMock.mockReturnValue(undefined);
    const delegate = { id: "discord", meta: { id: "discord" } };
    resolveGatewayDelegatedChannelPluginMock.mockReturnValue(delegate);
    const { getPluginRuntimeGatewayRequestScope } =
      await import("../../../plugins/runtime/gateway-request-scope.js");
    let scopedChannels: unknown;
    messageCommandMock.mockImplementationOnce(async () => {
      scopedChannels = getPluginRuntimeGatewayRequestScope()?.pluginRegistry?.channels;
      return undefined;
    });
    await runAction("read", { channel: "discord", target: "channel:12345" });
    expectConfigReady("read", true);
    expect(resolveGatewayDelegatedChannelPluginMock).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "discord", action: "read" }),
    );
    expect(loadPluginRegistryHandleMock).not.toHaveBeenCalled();
    expectMessageCommandOptions({ action: "read", channel: "discord", target: "channel:12345" });
    expect(scopedChannels).toEqual([expect.objectContaining({ plugin: delegate })]);
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("preloads when the scoped channel plugin is not cheaply available", async () => {
    getChannelPluginMock.mockReturnValue(undefined);
    await runSendAction({ target: "channel:12345" });
    expectRegistryLoad(["discord"]);
    expect(ensureConfigReadyMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ validateConfigOnly: false }),
    );
  });

  it.each([
    { channel: "discord", target: "channel:12345" },
    { channel: undefined, target: "telegram:12345" },
    {
      channel: "telegram",
      account: "default",
      target: "@ops",
      media: "./diagram.png",
      presentation: '{"blocks":[{"type":"buttons","buttons":[{"label":"OK","value":"ok"}]}]}',
      delivery: '{"pin":true}',
      forceDocument: true,
    },
  ])("skips local preload for gateway-owned send to $target", async (options) => {
    const rootStop = registerRootStopHook();
    mockChannelExecutionModes({ discord: "gateway", telegram: "gateway" });
    const { account, media, ...opts } = { account: undefined, media: undefined, ...options };
    await runSendAction({ account, media, ...opts });
    expectConfigReady("send", true);
    expect(loadPluginRegistryHandleMock).not.toHaveBeenCalled();
    const { channel, ...expectedOpts } = opts;
    expectMessageCommandOptions({
      action: "send",
      ...expectedOpts,
      ...(channel === undefined ? {} : { channel }),
      accountId: account,
      message: "hi",
      mediaUrls: media ? [media] : undefined,
    });
    expect(rootStop).not.toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("keeps Telegram dry-runs on the local preload path for local validation", async () => {
    await runSendAction({ channel: "telegram", target: "@ops", dryRun: true });
    expectConfigReady("send", false);
    expectRegistryLoad(["telegram"]);
    expect(messageCommandMock).toHaveBeenCalledTimes(1);
  });

  it("exits with failure when plugin registry loading fails before dispatch", async () => {
    loadPluginRegistryHandleMock.mockImplementationOnce(() => {
      throw new Error("plugin load failed");
    });
    await runSendAction();
    expect(messageCommandMock).not.toHaveBeenCalled();
    expect(errorMock).toHaveBeenCalledWith("plugin load failed");
    expect(exitMock).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("preserves JSON config failures before plugin loading or message dispatch", async () => {
    const error = new Error("config admission failed");
    ensureConfigReadyMock.mockRejectedValueOnce(error);
    await withConsoleLogsRoutedToStderrForJson(
      ["node", "openclaw", "message", "send", "--json"],
      async () => {
        applyResolvedCommandOutputMode(true);
        await expect(parseAction("send", { ...baseSendOptions, json: true })).rejects.toBe(error);
      },
    );
    expectConfigReady("send", false, true);
    expect(loadPluginRegistryHandleMock).not.toHaveBeenCalled();
    expect(messageCommandMock).not.toHaveBeenCalled();
    expect(errorMock).not.toHaveBeenCalled();
    expect(exitMock).not.toHaveBeenCalled();
  });

  it("rejects conflicting poll visibility flags before loading channel plugins", async () => {
    const opts = { channel: "telegram", target: "123", pollAnonymous: true, pollPublic: true };
    await runAction("poll", opts);
    expectRejectedBeforeDispatch("--poll-anonymous and --poll-public are mutually exclusive.");
  });

  it.each([
    ["poll", "pollDurationHours", "1.5"],
    ["poll", "pollDurationSeconds", "60s"],
    ["timeout", "durationMin", "5m"],
    ["ban", "deleteDays", "7d"],
    ["read", "limit", "10x"],
    ["search", "limit", "10x"],
    ["list-pins", "limit", "10x"],
    ["reactions", "limit", "10x"],
    ["thread-create", "autoArchiveMin", "60m"],
    ["thread-list", "limit", "10x"],
    ["poll", "pollDurationHours", "0"],
    ["poll", "pollDurationSeconds", "-1"],
    ["timeout", "durationMin", ""],
    ["ban", "deleteDays", Number.NaN],
    ["read", "limit", 1.2],
    ["thread-create", "autoArchiveMin", null],
  ] as const)("rejects invalid %s %s=%s", async (action, key, value) => {
    await runAction(action, {
      ...baseSendOptions,
      guildId: "g",
      userId: "u",
      query: "hello",
      messageId: "m",
      [key]: value,
    });
    const flag = `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    const kind = NON_NEGATIVE_INTEGER_FLAGS.has(flag) ? "non-negative" : "positive";
    expectRejectedBeforeDispatch(`${flag} must be a ${kind} integer.`);
  });

  it.each([
    ["ban", "deleteDays"],
    ["timeout", "durationMin"],
  ])("allows zero %s duration", async (action, key) => {
    const opts = { guildId: "g", userId: "u", [key]: "0" };
    await runAction(action, opts);
    expect(errorMock).not.toHaveBeenCalled();
    expectMessageCommandOptions({ action, ...opts });
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("finalizes only the command's registry when a process root also has hooks", async () => {
    const rootStop = registerRootStopHook();
    registerStopHook();
    await runSendAction();
    expectConfigReady("send", false);
    expectRegistryLoad(["discord"]);
    expect(exitMock).toHaveBeenCalledExactlyOnceWith(0);
    expect(runGatewayStopMock).toHaveBeenCalledOnce();
    expect(runGatewayStopMock).toHaveBeenCalledWith({ reason: "cli message action complete" }, {});
    expect(runGatewayStopMock).toHaveBeenCalledBefore(exitMock);
    expect(rootStop).not.toHaveBeenCalled();
  });

  it("skips gateway_stop hooks for read-only message reads", async () => {
    registerStopHook();
    await runAction("read", { channel: "discord", target: "channel:123", limit: 1 });
    expect(runGatewayStopMock).not.toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("runs gateway_stop hooks on failure before exit(1)", async () => {
    registerStopHook();
    messageCommandMock.mockRejectedValueOnce(new Error("send failed"));
    await runSendAction();
    expect(runGatewayStopMock).toHaveBeenCalledWith({ reason: "cli message action complete" }, {});
    expect(runGatewayStopMock).toHaveBeenCalledBefore(exitMock);
    expect(errorMock).toHaveBeenCalledWith("send failed");
    expect(exitMock).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("runs gateway_stop hooks before exit(1) for a failed broadcast result", async () => {
    registerStopHook();
    mockResult("broadcast", {
      results: [
        { channel: "telegram", to: "123", ok: true },
        { channel: "telegram", to: "456", ok: false, error: "delivery failed" },
      ],
    });
    await runAction("broadcast", {
      channel: "telegram",
      targets: ["123", "456"],
      message: "hi",
    });
    expect(runGatewayStopMock).toHaveBeenCalledOnce();
    expect(runGatewayStopMock).toHaveBeenCalledBefore(exitMock);
    expect(exitMock).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each([0, 1])("logs gateway_stop failure and preserves exit code %s", async (exitCode) => {
    registerStopHook();
    if (exitCode === 1) {
      messageCommandMock.mockRejectedValueOnce(new Error("send failed"));
    }
    runGatewayStopMock.mockRejectedValueOnce(new Error("hook failed"));
    await runSendAction();
    if (exitCode === 1) {
      expect(errorMock).toHaveBeenCalledWith("send failed");
    }
    expect(hookErrorMock).toHaveBeenCalledWith(expect.stringContaining("hook failed"));
    expect(exitMock).toHaveBeenCalledWith(exitCode);
  });

  it.each([
    ["poll", "acct-1", "acct-1"],
    ["send", 42, undefined],
  ] as const)("maps the %s account %s to accountId", async (action, account, accountId) => {
    await runAction(action, { ...baseSendOptions, account });
    expectMessageCommandOptions({ action, ...baseSendOptions, accountId });
  });
});
