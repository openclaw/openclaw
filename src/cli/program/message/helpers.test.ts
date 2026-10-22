import { Command } from "commander";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addTestHook, createMockPluginRegistry } from "../../../plugins/hooks.test-helpers.js";
import {
  applyResolvedCommandOutputMode,
  withConsoleLogsRoutedToStderrForJson,
} from "../../json-output-mode.js";

const messageCommandMock = vi.fn(async (): Promise<unknown> => undefined);
vi.mock("../../../commands/message.js", () => ({
  messageCommand: messageCommandMock,
}));

const ensureConfigReadyMock = vi.fn(async () => {});
vi.mock("../config-guard.js", () => ({ ensureConfigReady: ensureConfigReadyMock }));

const getChannelPluginMock = vi.fn();
vi.mock("../../../channels/plugins/index.js", () => ({
  getChannelPlugin: getChannelPluginMock,
}));

vi.mock("../../../globals.js", () => ({
  danger: (s: string) => s,
  setVerbose: vi.fn(),
}));

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
vi.mock("../../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    warn: hookErrorMock,
    error: hookErrorMock,
  }),
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

vi.mock("../../deps.js", () => ({
  createDefaultDeps: () => ({}),
}));

const { registerMessageCommands } = await import("../register.message.js");
const { initializeGlobalHookRunner, resetGlobalHookRunner } =
  await import("../../../plugins/hook-runner-global.js");
afterEach(resetGlobalHookRunner);

const NON_NEGATIVE_INTEGER_FLAGS = new Set(["--delete-days", "--duration-min"]);

const baseSendOptions = {
  channel: "discord",
  target: "123",
  message: "hi",
};

function createRunMessageAction() {
  return async (action: string, opts: Record<string, unknown>) => {
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
    const defaults: Record<string, unknown> =
      action === "poll"
        ? { pollQuestion: "Ship it?", pollOption: ["Yes", "No"] }
        : action === "thread-create"
          ? { threadName: "ops" }
          : {};
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
      } else if (typeof value === "string") {
        argv.push(`${flag}=${value}`);
      } else if (Array.isArray(value)) {
        if (option.variadic) {
          argv.push(flag, ...value);
        } else {
          for (const item of value) {
            argv.push(`${flag}=${item}`);
          }
        }
      } else if (value !== false) {
        // Exercise typed-invalid values through Commander's public option API.
        command.setOptionValue(key, value);
      }
    }
    return program.parseAsync(argv, { from: "user" });
  };
}

async function runSendAction(opts: Record<string, unknown> = {}) {
  await runAction("send", { ...baseSendOptions, ...opts });
}

async function runAction(action: string, opts: Record<string, unknown>) {
  await expect(createRunMessageAction()(action, opts)).rejects.toThrow("exit");
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
    actions: {
      resolveExecutionMode: () => modes[id] ?? "local",
    },
  }));
}

function expectNoAccountFieldInPassedOptions() {
  const call = (messageCommandMock.mock.calls as unknown[][])[0];
  expect(requireRecord(call?.[0], "messageCommand options")).not.toHaveProperty("account");
}

const requireRecord = createRequireRecord("record", "expected-label-object");

function expectMessageCommandOptions(expected: Record<string, unknown>, callIndex = 0): void {
  const call = (messageCommandMock.mock.calls as unknown[][])[callIndex];
  if (!call) {
    throw new Error(`expected messageCommand call ${callIndex}`);
  }
  const options = requireRecord(call[0], `messageCommand options ${callIndex}`);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(options[key], `messageCommand options.${key}`).toEqual(expectedValue);
  }
  if (call[1] == null) {
    throw new Error("expected messageCommand runtime");
  }
  if (call[2] == null) {
    throw new Error("expected messageCommand deps");
  }
}

function expectRegistryLoad(pluginIds: string[]): void {
  expect(loadPluginRegistryHandleMock).toHaveBeenCalledWith(
    expect.objectContaining({ onlyPluginIds: pluginIds, throwOnLoadError: true }),
  );
  expect(ensureConfigReadyMock).toHaveBeenCalledBefore(loadPluginRegistryHandleMock);
}

function expectConfigReady(action: string, validateConfigOnly: boolean): void {
  expect(ensureConfigReadyMock).toHaveBeenCalledExactlyOnceWith({
    runtime: runtimeMock,
    commandPath: ["message", action],
    measure: expect.any(Function),
    suppressDoctorStdout: false,
    validateConfigOnly,
  });
  expect(ensureConfigReadyMock).toHaveBeenCalledBefore(messageCommandMock);
}

describe("runMessageAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getChannelPluginMock.mockReset();
    mockChannelExecutionModes({ telegram: "gateway" });
    ensureConfigReadyMock.mockReset().mockResolvedValue(undefined);
    messageCommandMock.mockClear().mockResolvedValue(undefined);
    pluginRegistry.typedHooks.length = 0;
    resetGlobalHookRunner();
    runGatewayStopMock.mockClear().mockResolvedValue(undefined);
    exitMock.mockClear().mockImplementation((_code: number): never => {
      throw new Error("exit");
    });
  });

  it("calls exit(0) after successful message delivery", async () => {
    await runSendAction();
    expectConfigReady("send", false);
    expectRegistryLoad(["discord"]);
    expect(exitMock).toHaveBeenCalledExactlyOnceWith(0);
  });

  it.each([
    { name: "sent", status: "sent" as const, exitCode: 0 },
    { name: "suppressed", status: "suppressed" as const, exitCode: 1 },
    { name: "failed", status: "failed" as const, exitCode: 1 },
    { name: "partial_failed", status: "partial_failed" as const, exitCode: 1 },
    { name: "dry-run", status: undefined, dryRun: true, exitCode: 0 },
  ])(
    "propagates $name send outcomes through the real CLI parser",
    async ({ status, dryRun, exitCode }) => {
      const sendResult = {
        channel: "discord",
        to: "channel:123",
        via: "direct" as const,
        mediaUrl: null,
        ...(status ? { deliveryStatus: status } : {}),
        ...(status === "suppressed"
          ? { suppressionReason: "cancelled_by_message_sending_hook" as const }
          : {}),
        ...(status === "failed" || status === "partial_failed"
          ? { error: "provider rejected the message" }
          : {}),
        ...(status === "partial_failed"
          ? { sentBeforeError: true as const, result: { channel: "discord", messageId: "part-1" } }
          : {}),
      };
      messageCommandMock.mockResolvedValueOnce({
        kind: "send",
        channel: "discord",
        action: "send",
        to: "channel:123",
        handledBy: "core",
        payload: sendResult,
        sendResult,
        dryRun: Boolean(dryRun),
      });
      await runSendAction({ target: "channel:123", dryRun });
      expect(exitMock).toHaveBeenCalledWith(exitCode);
    },
  );

  it.each(["", "   "])(
    "rejects an explicitly blank message channel before command startup (%j)",
    async (channel) => {
      await expect(
        createRunMessageAction()("send", { ...baseSendOptions, channel, target: "channel:123" }),
      ).rejects.toThrow("--channel must not be blank");
      expect(loadPluginRegistryHandleMock).not.toHaveBeenCalled();
      expect(messageCommandMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["disabled reaction", "react", { ok: false, hint: "Reactions are disabled." }, 1],
    ["rejected added reaction", "react", { ok: false, warning: "Unavailable", added: "✅" }, 1],
    ["rejected delete", "delete", { ok: false, deleted: false, warning: "Not deleted" }, 1],
    ["rejected send", "send", { ok: false, error: "Message rejected" }, 1],
    ["successful reaction", "react", { ok: true, added: "✅" }, 0],
    ["legacy reaction", "react", { added: "✅" }, 0],
    ["non-boolean outcome", "react", { ok: "false", added: "✅" }, 0],
    ["dry-run", "react", { ok: false, error: "Not executed" }, 0],
  ] as const)(
    "propagates %s through the real CLI parser",
    async (name, action, payload, exitCode) => {
      const dryRun = name === "dry-run";
      const kind = action === "send" ? action : "action";
      messageCommandMock.mockResolvedValueOnce({
        kind,
        channel: "telegram",
        action,
        ...(kind === "action" ? {} : { to: "123" }),
        handledBy: "plugin",
        payload,
        dryRun,
      });
      const opts = {
        react: { messageId: "456", emoji: "✅" },
        delete: { messageId: "456" },
        send: { message: "hello" },
      }[action];
      await runAction(action, { channel: "telegram", target: "123", ...opts, dryRun });
      expect(exitMock).toHaveBeenCalledWith(exitCode);
    },
  );

  it("loads configured channel plugins when no target channel is known yet", async () => {
    await runSendAction({ channel: undefined });
    expectRegistryLoad(["configured-channel"]);
  });

  it("narrows plugin loading from a channel-prefixed target", async () => {
    await runSendAction({ channel: undefined, target: "discord:channel:12345" });
    expectRegistryLoad(["discord"]);
  });

  it("skips local plugin preload for any gateway-owned scoped channel action", async () => {
    mockChannelExecutionModes({ discord: "gateway" });
    await runSendAction({ target: "channel:12345" });
    expectConfigReady("send", true);
    expect(loadPluginRegistryHandleMock).not.toHaveBeenCalled();
    expectMessageCommandOptions({
      action: "send",
      channel: "discord",
      target: "channel:12345",
      message: "hi",
    });
    expect(exitMock).toHaveBeenCalledWith(0);
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

  it("preloads when the scoped channel plugin is not cheaply available", async () => {
    getChannelPluginMock.mockReturnValue(undefined);
    await runSendAction({ target: "channel:12345" });
    expectRegistryLoad(["discord"]);
  });

  it("keeps target-prefixed Telegram sends from local plugin preload", async () => {
    await runSendAction({ channel: undefined, target: "telegram:12345" });
    expect(loadPluginRegistryHandleMock).not.toHaveBeenCalled();
    expectMessageCommandOptions({
      action: "send",
      target: "telegram:12345",
      message: "hi",
    });
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("keeps explicit Telegram sends on the normal command path without local plugin preload", async () => {
    await runSendAction({
      channel: "telegram",
      account: "default",
      target: "@ops",
      media: "./diagram.png",
      presentation: '{"blocks":[{"type":"buttons","buttons":[{"label":"OK","value":"ok"}]}]}',
      delivery: '{"pin":true}',
      forceDocument: true,
    });
    expect(loadPluginRegistryHandleMock).not.toHaveBeenCalled();
    expectMessageCommandOptions({
      action: "send",
      channel: "telegram",
      accountId: "default",
      target: "@ops",
      message: "hi",
      mediaUrls: ["./diagram.png"],
      presentation: '{"blocks":[{"type":"buttons","buttons":[{"label":"OK","value":"ok"}]}]}',
      delivery: '{"pin":true}',
      forceDocument: true,
    });
    expectNoAccountFieldInPassedOptions();
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
    expect(exitMock).not.toHaveBeenCalledWith(0);
  });

  it("preserves JSON config failures before plugin loading or message dispatch", async () => {
    const error = new Error("config admission failed");
    ensureConfigReadyMock.mockRejectedValueOnce(error);
    const runMessageAction = createRunMessageAction();
    await withConsoleLogsRoutedToStderrForJson(
      ["node", "openclaw", "message", "send", "--json"],
      async () => {
        applyResolvedCommandOutputMode(true);
        await expect(runMessageAction("send", { ...baseSendOptions, json: true })).rejects.toBe(
          error,
        );
      },
    );
    expect(ensureConfigReadyMock).toHaveBeenCalledExactlyOnceWith({
      runtime: runtimeMock,
      commandPath: ["message", "send"],
      measure: expect.any(Function),
      suppressDoctorStdout: true,
      validateConfigOnly: false,
    });
    expect(loadPluginRegistryHandleMock).not.toHaveBeenCalled();
    expect(messageCommandMock).not.toHaveBeenCalled();
    expect(errorMock).not.toHaveBeenCalled();
    expect(exitMock).not.toHaveBeenCalled();
  });

  it("rejects conflicting poll visibility flags before loading channel plugins", async () => {
    await runAction("poll", {
      channel: "telegram",
      target: "123",
      pollAnonymous: true,
      pollPublic: true,
    });
    expect(errorMock).toHaveBeenCalledWith(
      "--poll-anonymous and --poll-public are mutually exclusive.",
    );
    expect(loadPluginRegistryHandleMock).not.toHaveBeenCalled();
    expect(messageCommandMock).not.toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(exitMock).not.toHaveBeenCalledWith(0);
  });

  it.each([
    ["poll duration hours", "poll", { pollDurationHours: "1.5" }, "--poll-duration-hours"],
    [
      "poll duration seconds",
      "poll",
      { channel: "telegram", pollDurationSeconds: "60s" },
      "--poll-duration-seconds",
    ],
    ["timeout duration", "timeout", { durationMin: "5m" }, "--duration-min"],
    ["ban delete days", "ban", { deleteDays: "7d" }, "--delete-days"],
    ["read limit", "read", { limit: "10x" }, "--limit"],
    ["search limit", "search", { query: "hello", limit: "10x" }, "--limit"],
    ["pins limit", "list-pins", { limit: "10x" }, "--limit"],
    ["reactions limit", "reactions", { messageId: "m", limit: "10x" }, "--limit"],
    [
      "thread auto archive minutes",
      "thread-create",
      { autoArchiveMin: "60m" },
      "--auto-archive-min",
    ],
    ["thread list limit", "thread-list", { limit: "10x" }, "--limit"],
  ])("rejects malformed numeric CLI option for %s", async (_name, action, opts, flag) => {
    await runAction(action, { ...baseSendOptions, guildId: "g", userId: "u", ...opts });
    const kind = NON_NEGATIVE_INTEGER_FLAGS.has(flag) ? "non-negative" : "positive";
    expect(errorMock).toHaveBeenCalledWith(`${flag} must be a ${kind} integer.`);
    expect(loadPluginRegistryHandleMock).not.toHaveBeenCalled();
    expect(messageCommandMock).not.toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(exitMock).not.toHaveBeenCalledWith(0);
  });

  it.each([
    ["pollDurationHours", "0", "--poll-duration-hours", "poll"],
    ["pollDurationSeconds", "-1", "--poll-duration-seconds", "poll"],
    ["durationMin", "", "--duration-min", "timeout"],
    ["deleteDays", Number.NaN, "--delete-days", "ban"],
    ["limit", 1.2, "--limit", "read"],
    ["autoArchiveMin", null, "--auto-archive-min", "thread-create"],
  ])("rejects non-positive or non-integer %s values", async (key, value, flag, action) => {
    await runAction(action, { ...baseSendOptions, guildId: "g", userId: "u", [key]: value });
    const kind = NON_NEGATIVE_INTEGER_FLAGS.has(flag) ? "non-negative" : "positive";
    expect(errorMock).toHaveBeenCalledWith(`${flag} must be a ${kind} integer.`);
    expect(messageCommandMock).not.toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("allows zero delete-days for no-history Discord bans", async () => {
    const opts = { guildId: "g", userId: "u", deleteDays: "0" };
    await runAction("ban", opts);
    expect(errorMock).not.toHaveBeenCalled();
    expectMessageCommandOptions({ action: "ban", ...opts });
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("allows zero duration-min for clearing Discord timeouts", async () => {
    const opts = { guildId: "g", userId: "u", durationMin: "0" };
    await runAction("timeout", opts);
    expect(errorMock).not.toHaveBeenCalled();
    expectMessageCommandOptions({ action: "timeout", ...opts });
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("finalizes only the command's registry when a process root also has hooks", async () => {
    const rootStop = registerRootStopHook();
    registerStopHook();
    await runSendAction();
    expect(runGatewayStopMock).toHaveBeenCalledOnce();
    expect(rootStop).not.toHaveBeenCalled();
  });

  it("leaves Gateway-owned resources running when the CLI loads no registry", async () => {
    const rootStop = registerRootStopHook();
    mockChannelExecutionModes({ discord: "gateway" });
    await runSendAction();
    expect(loadPluginRegistryHandleMock).not.toHaveBeenCalled();
    expect(rootStop).not.toHaveBeenCalled();
  });

  it("runs gateway_stop hooks before exit when registered", async () => {
    registerStopHook();
    await runSendAction();
    expect(runGatewayStopMock).toHaveBeenCalledWith({ reason: "cli message action complete" }, {});
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("skips gateway_stop hooks for read-only message reads", async () => {
    registerStopHook();
    await runAction("read", { channel: "discord", target: "channel:123", limit: 1 });
    expect(runGatewayStopMock).not.toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("calls exit(1) when message delivery fails", async () => {
    messageCommandMock.mockRejectedValueOnce(new Error("send failed"));
    await runSendAction();
    expect(errorMock).toHaveBeenCalledWith("send failed");
    expect(exitMock).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("runs gateway_stop hooks on failure before exit(1)", async () => {
    registerStopHook();
    messageCommandMock.mockRejectedValueOnce(new Error("send failed"));
    await runSendAction();
    expect(runGatewayStopMock).toHaveBeenCalledWith({ reason: "cli message action complete" }, {});
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("runs gateway_stop hooks before exit(1) for a failed broadcast result", async () => {
    const order: string[] = [];
    registerStopHook();
    messageCommandMock.mockResolvedValueOnce({
      kind: "broadcast",
      channel: "telegram",
      action: "broadcast",
      handledBy: "core",
      payload: {
        results: [
          { channel: "telegram", to: "123", ok: true },
          { channel: "telegram", to: "456", ok: false, error: "delivery failed" },
        ],
      },
      dryRun: false,
    });
    runGatewayStopMock.mockImplementationOnce(async () => {
      order.push("stop");
    });
    exitMock.mockImplementationOnce((code: number): never => {
      order.push(`exit:${code}`);
      throw new Error("exit");
    });
    await runAction("broadcast", {
      channel: "telegram",
      targets: ["123", "456"],
      message: "hi",
    });
    expect(order).toEqual(["stop", "exit:1"]);
    expect(exitMock).not.toHaveBeenCalledWith(0);
  });

  it("logs gateway_stop failure and still exits with success code", async () => {
    registerStopHook();
    runGatewayStopMock.mockRejectedValueOnce(new Error("hook failed"));
    await runSendAction();
    expect(hookErrorMock).toHaveBeenCalledWith(expect.stringContaining("hook failed"));
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("logs gateway_stop failure and preserves failure exit code when send fails", async () => {
    registerStopHook();
    messageCommandMock.mockRejectedValueOnce(new Error("send failed"));
    runGatewayStopMock.mockRejectedValueOnce(new Error("hook failed"));
    await runSendAction();
    expect(errorMock).toHaveBeenCalledWith("send failed");
    expect(hookErrorMock).toHaveBeenCalledWith(expect.stringContaining("hook failed"));
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("passes action and maps account to accountId", async () => {
    const opts = { channel: "discord", target: "456", message: "hi" };
    await runAction("poll", { ...opts, account: "acct-1" });
    expectMessageCommandOptions({ action: "poll", ...opts, accountId: "acct-1" });
    expectNoAccountFieldInPassedOptions();
  });

  it("strips non-string account values instead of passing accountId", async () => {
    await runSendAction({ target: "789", account: 42 });
    expectMessageCommandOptions({
      action: "send",
      channel: "discord",
      target: "789",
      accountId: undefined,
    });
    expectNoAccountFieldInPassedOptions();
  });
});
