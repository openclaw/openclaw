// Message program helper tests cover message command helper behavior and mocks.
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
vi.mock("../../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
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

const { createMessageCliHelpers } = await import("./helpers.js");
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
  return createMessageCliHelpers("discord").runMessageAction;
}

async function runSendAction(opts: Record<string, unknown> = {}) {
  const runMessageAction = createRunMessageAction();
  await expect(runMessageAction("send", { ...baseSendOptions, ...opts })).rejects.toThrow("exit");
}

function mockChannelExecutionModes(modes: Record<string, "gateway" | "local"> = {}) {
  getChannelPluginMock.mockImplementation((id: string) => ({
    actions: {
      resolveExecutionMode: () => modes[id] ?? "local",
    },
  }));
}

function expectNoAccountFieldInPassedOptions() {
  const passedOpts = (
    messageCommandMock.mock.calls as unknown as Array<[Record<string, unknown>]>
  )?.[0]?.[0];
  if (passedOpts === undefined) {
    throw new Error("expected message command call");
  }
  expect(passedOpts).not.toHaveProperty("account");
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

  it.each([
    ["rejected delete", "delete", { ok: false, deleted: false, warning: "Not deleted" }, 1],
    ["rejected poll", "poll", { ok: false, error: "Poll rejected" }, 1],
    ["rejected send", "send", { ok: false, error: "Message rejected" }, 1],
    ["dry-run", "react", { ok: false, error: "Not executed" }, 0],
  ] as const)(
    "propagates %s through the real CLI parser",
    async (name, action, payload, exitCode) => {
      const dryRun = name === "dry-run";
      const kind = action === "send" || action === "poll" ? action : "action";
      messageCommandMock.mockResolvedValueOnce({
        kind,
        channel: "telegram",
        action,
        ...(kind === "action" ? {} : { to: "123" }),
        handledBy: "plugin",
        payload,
        dryRun,
      });
      const program = new Command();
      registerMessageCommands(program, {
        programVersion: "test",
        messageChannelOptions: "telegram",
        agentChannelOptions: "last|telegram",
      });
      const args = {
        react: ["--message-id", "456", "--emoji", "✅"],
        delete: ["--message-id", "456"],
        poll: ["--poll-question", "Ready?", "--poll-option", "Yes", "--poll-option", "No"],
        send: ["--message", "hello"],
      }[action];

      await expect(
        program.parseAsync(
          [
            "message",
            action,
            "--channel",
            "telegram",
            "--target",
            "123",
            ...args,
            ...(dryRun ? ["--dry-run"] : []),
          ],
          { from: "user" },
        ),
      ).rejects.toThrow("exit");

      expect(exitMock).toHaveBeenCalledWith(exitCode);
    },
  );

  it("loads configured channel plugins when no target channel is known yet", async () => {
    await runSendAction({ channel: undefined });

    expectRegistryLoad(["configured-channel"]);
  });

  it("keeps broadcast on the local preload path for same-channel prefixed targets", async () => {
    const runMessageAction = createRunMessageAction();

    await expect(
      runMessageAction("broadcast", {
        targets: ["telegram:1", "telegram:2"],
        message: "hi",
      }),
    ).rejects.toThrow("exit");

    expectConfigReady("broadcast", false);
    expectRegistryLoad(["telegram"]);
    expectMessageCommandOptions({
      action: "broadcast",
      targets: ["telegram:1", "telegram:2"],
      message: "hi",
    });
  });

  it("loads configured channel plugins for mixed broadcast target prefixes", async () => {
    const runMessageAction = createRunMessageAction();

    await expect(
      runMessageAction("broadcast", {
        targets: ["discord:channel:1", "telegram:123"],
        message: "hi",
      }),
    ).rejects.toThrow("exit");

    expectRegistryLoad(["configured-channel"]);
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
    const runMessageAction = createRunMessageAction();

    await expect(
      runMessageAction("poll", {
        channel: "telegram",
        target: "123",
        pollQuestion: "Ship it?",
        pollOption: ["Yes", "No"],
        pollAnonymous: true,
        pollPublic: true,
      }),
    ).rejects.toThrow("exit");

    expect(errorMock).toHaveBeenCalledWith(
      "--poll-anonymous and --poll-public are mutually exclusive.",
    );
    expect(loadPluginRegistryHandleMock).not.toHaveBeenCalled();
    expect(messageCommandMock).not.toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(exitMock).not.toHaveBeenCalledWith(0);
  });

  it.each([
    ["pollDurationHours", "0", "--poll-duration-hours"],
    ["durationMin", "", "--duration-min"],
  ])("rejects non-positive or non-integer %s values", async (key, value, flag) => {
    const runMessageAction = createRunMessageAction();

    await expect(
      runMessageAction("send", {
        ...baseSendOptions,
        [key]: value,
      }),
    ).rejects.toThrow("exit");

    const kind = NON_NEGATIVE_INTEGER_FLAGS.has(flag) ? "non-negative" : "positive";
    expect(errorMock).toHaveBeenCalledWith(`${flag} must be a ${kind} integer.`);
    expect(messageCommandMock).not.toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("finalizes only the command's registry when a process root also has hooks", async () => {
    const rootStop = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "gateway_stop", handler: rootStop, pluginId: "process-root" },
      ]),
    );
    registerStopHook();

    await runSendAction();

    expect(runGatewayStopMock).toHaveBeenCalledOnce();
    expect(rootStop).not.toHaveBeenCalled();
  });

  it("leaves Gateway-owned resources running when the CLI loads no registry", async () => {
    const rootStop = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "gateway_stop", handler: rootStop, pluginId: "process-root" },
      ]),
    );
    mockChannelExecutionModes({ discord: "gateway" });

    await runSendAction();

    expect(loadPluginRegistryHandleMock).not.toHaveBeenCalled();
    expect(rootStop).not.toHaveBeenCalled();
  });

  it("skips gateway_stop hooks for read-only message reads", async () => {
    registerStopHook();
    const runMessageAction = createRunMessageAction();

    await expect(
      runMessageAction("read", {
        channel: "discord",
        target: "channel:123",
        limit: 1,
      }),
    ).rejects.toThrow("exit");

    expect(runGatewayStopMock).not.toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("bounds gateway_stop hooks so message actions still exit", async () => {
    vi.useFakeTimers();
    try {
      registerStopHook();
      runGatewayStopMock.mockImplementationOnce(() => new Promise(() => {}));
      const runMessageAction = createRunMessageAction();

      const pending = expect(runMessageAction("send", baseSendOptions)).rejects.toThrow("exit");
      await vi.advanceTimersByTimeAsync(2500);
      await pending;

      expect(errorMock).toHaveBeenCalledWith("gateway_stop hook exceeded 2500ms; continuing");
      expect(exitMock).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
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
    const runMessageAction = createRunMessageAction();

    await expect(
      runMessageAction("broadcast", {
        channel: "telegram",
        targets: ["123", "456"],
        message: "hi",
      }),
    ).rejects.toThrow("exit");

    expect(order).toEqual(["stop", "exit:1"]);
    expect(exitMock).not.toHaveBeenCalledWith(0);
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
    const { runMessageAction } = createMessageCliHelpers("discord");

    await expect(
      runMessageAction("poll", {
        channel: "discord",
        target: "456",
        account: "acct-1",
        message: "hi",
      }),
    ).rejects.toThrow("exit");

    expectMessageCommandOptions({
      action: "poll",
      channel: "discord",
      target: "456",
      accountId: "acct-1",
      message: "hi",
    });
    // account key should be stripped in favor of accountId
    expectNoAccountFieldInPassedOptions();
  });
});
