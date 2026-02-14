import { beforeEach, describe, expect, it, vi } from "vitest";

const messageCommandMock = vi.fn(async () => {});
vi.mock("../../../commands/message.js", () => ({
  messageCommand: (...args: unknown[]) => messageCommandMock(...args),
}));

vi.mock("../../../globals.js", () => ({
  danger: (s: string) => s,
  setVerbose: vi.fn(),
}));

vi.mock("../../plugin-registry.js", () => ({
  ensurePluginRegistryLoaded: vi.fn(),
}));

const hasHooksMock = vi.fn(() => false);
const runGatewayStopMock = vi.fn(async () => {});
const runGlobalGatewayStopSafelyMock = vi.fn(
  async (params: {
    event: { reason?: string };
    ctx: Record<string, unknown>;
    onError?: (err: unknown) => void;
  }) => {
    if (!hasHooksMock("gateway_stop")) {
      return;
    }
    try {
      await runGatewayStopMock(params.event, params.ctx);
    } catch (err) {
      params.onError?.(err);
    }
  },
);
vi.mock("../../../plugins/hook-runner-global.js", () => ({
  runGlobalGatewayStopSafely: (...args: unknown[]) => runGlobalGatewayStopSafelyMock(...args),
}));

const exitMock = vi.fn((): never => {
  throw new Error("exit");
});
const errorMock = vi.fn();
const runtimeMock = { log: vi.fn(), error: errorMock, exit: exitMock };
vi.mock("../../../runtime.js", () => ({
  defaultRuntime: runtimeMock,
}));

vi.mock("../../deps.js", () => ({
  createDefaultDeps: () => ({}),
}));

const { createMessageCliHelpers } = await import("./helpers.js");

describe("runMessageAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    messageCommandMock.mockReset().mockResolvedValue(undefined);
    hasHooksMock.mockReset().mockReturnValue(false);
    runGatewayStopMock.mockReset().mockResolvedValue(undefined);
    runGlobalGatewayStopSafelyMock.mockClear();
    exitMock.mockReset().mockImplementation((): never => {
      throw new Error("exit");
    });
  });

  it("calls exit(0) after successful message delivery", async () => {
    const fakeCommand = { help: vi.fn() } as never;
    const { runMessageAction } = createMessageCliHelpers(fakeCommand, "discord");

    await expect(
      runMessageAction("send", { channel: "discord", target: "123", message: "hi" }),
    ).rejects.toThrow("exit");

    expect(exitMock).toHaveBeenCalledOnce();
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("runs gateway_stop hooks before exit when registered", async () => {
    hasHooksMock.mockReturnValueOnce(true);
    const fakeCommand = { help: vi.fn() } as never;
    const { runMessageAction } = createMessageCliHelpers(fakeCommand, "discord");

    await expect(
      runMessageAction("send", { channel: "discord", target: "123", message: "hi" }),
    ).rejects.toThrow("exit");

    expect(runGatewayStopMock).toHaveBeenCalledWith({ reason: "cli message action complete" }, {});
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("calls exit(1) when message delivery fails", async () => {
    messageCommandMock.mockRejectedValueOnce(new Error("send failed"));
    const fakeCommand = { help: vi.fn() } as never;
    const { runMessageAction } = createMessageCliHelpers(fakeCommand, "discord");

    await expect(
      runMessageAction("send", { channel: "discord", target: "123", message: "hi" }),
    ).rejects.toThrow("exit");

    expect(errorMock).toHaveBeenCalledWith("Error: send failed");
    expect(exitMock).toHaveBeenCalledOnce();
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("runs gateway_stop hooks on failure before exit(1)", async () => {
    hasHooksMock.mockReturnValueOnce(true);
    messageCommandMock.mockRejectedValueOnce(new Error("send failed"));
    const fakeCommand = { help: vi.fn() } as never;
    const { runMessageAction } = createMessageCliHelpers(fakeCommand, "discord");

    await expect(
      runMessageAction("send", { channel: "discord", target: "123", message: "hi" }),
    ).rejects.toThrow("exit");

    expect(runGatewayStopMock).toHaveBeenCalledWith({ reason: "cli message action complete" }, {});
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("logs gateway_stop failure and still exits with success code", async () => {
    hasHooksMock.mockReturnValueOnce(true);
    runGatewayStopMock.mockRejectedValueOnce(new Error("hook failed"));
    const fakeCommand = { help: vi.fn() } as never;
    const { runMessageAction } = createMessageCliHelpers(fakeCommand, "discord");

    await expect(
      runMessageAction("send", { channel: "discord", target: "123", message: "hi" }),
    ).rejects.toThrow("exit");

    expect(errorMock).toHaveBeenCalledWith("gateway_stop hook failed: Error: hook failed");
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("logs gateway_stop failure and preserves failure exit code when send fails", async () => {
    hasHooksMock.mockReturnValueOnce(true);
    messageCommandMock.mockRejectedValueOnce(new Error("send failed"));
    runGatewayStopMock.mockRejectedValueOnce(new Error("hook failed"));
    const fakeCommand = { help: vi.fn() } as never;
    const { runMessageAction } = createMessageCliHelpers(fakeCommand, "discord");

    await expect(
      runMessageAction("send", { channel: "discord", target: "123", message: "hi" }),
    ).rejects.toThrow("exit");

    expect(errorMock).toHaveBeenNthCalledWith(1, "Error: send failed");
    expect(errorMock).toHaveBeenNthCalledWith(2, "gateway_stop hook failed: Error: hook failed");
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("does not call exit(0) when the action throws", async () => {
    messageCommandMock.mockRejectedValueOnce(new Error("boom"));
    const fakeCommand = { help: vi.fn() } as never;
    const { runMessageAction } = createMessageCliHelpers(fakeCommand, "discord");

    await expect(
      runMessageAction("send", { channel: "discord", target: "123", message: "hi" }),
    ).rejects.toThrow("exit");

    // exit should only be called once with code 1, never with 0
    expect(exitMock).toHaveBeenCalledOnce();
    expect(exitMock).not.toHaveBeenCalledWith(0);
  });

  it("does not call exit(0) if the error path returns", async () => {
    messageCommandMock.mockRejectedValueOnce(new Error("boom"));
    exitMock.mockReset().mockImplementation(() => undefined as never);
    const fakeCommand = { help: vi.fn() } as never;
    const { runMessageAction } = createMessageCliHelpers(fakeCommand, "discord");

    await expect(
      runMessageAction("send", { channel: "discord", target: "123", message: "hi" }),
    ).resolves.toBeUndefined();

    expect(errorMock).toHaveBeenCalledWith("Error: boom");
    expect(exitMock).toHaveBeenCalledOnce();
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(exitMock).not.toHaveBeenCalledWith(0);
  });

  it("passes action and maps account to accountId", async () => {
    const fakeCommand = { help: vi.fn() } as never;
    const { runMessageAction } = createMessageCliHelpers(fakeCommand, "discord");

    await expect(
      runMessageAction("poll", {
        channel: "discord",
        target: "456",
        account: "acct-1",
        message: "hi",
      }),
    ).rejects.toThrow("exit");

    expect(messageCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "poll",
        channel: "discord",
        target: "456",
        accountId: "acct-1",
        message: "hi",
      }),
      expect.anything(),
      expect.anything(),
    );
    // account key should be stripped in favor of accountId
    const passedOpts = messageCommandMock.mock.calls[0][0] as Record<string, unknown>;
    expect(passedOpts).not.toHaveProperty("account");
  });
});
