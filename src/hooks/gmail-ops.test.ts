// Foreground Gmail service tests cover `openclaw webhooks gmail run` behavior.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDependency: vi.fn(),
  ensureTailscaleEndpoint: vi.fn(),
  getRuntimeConfig: vi.fn(),
  runCommandWithTimeout: vi.fn(),
  spawn: vi.fn(),
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    { spawn: mocks.spawn },
  );
});

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: mocks.getRuntimeConfig,
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("./gmail-setup-utils.js", () => ({
  ensureDependency: mocks.ensureDependency,
  ensureGcloudAuth: vi.fn(),
  ensureSubscription: vi.fn(),
  ensureTailscaleEndpoint: mocks.ensureTailscaleEndpoint,
  ensureTopic: vi.fn(),
  resolveProjectIdFromGogCredentials: vi.fn(),
  runGcloud: vi.fn(),
}));

vi.mock("../infra/executable-path.js", () => ({
  resolveExecutable: vi.fn((name: string) => name),
}));

const { runGmailService } = await import("./gmail-ops.js");

function createGmailConfig(account = "me@example.com") {
  return {
    hooks: {
      enabled: true,
      token: "hook-token",
      gmail: {
        account,
        topic: "projects/demo/topics/gmail",
        pushToken: "push-token",
        tailscale: { mode: "off" as const },
      },
    },
  };
}

describe("runGmailService", () => {
  beforeEach(() => {
    mocks.ensureDependency.mockResolvedValue(undefined);
    mocks.ensureTailscaleEndpoint.mockResolvedValue(undefined);
    mocks.getRuntimeConfig.mockReturnValue(createGmailConfig());
    mocks.runCommandWithTimeout.mockReset();
    mocks.defaultRuntime.log.mockReset();
    mocks.defaultRuntime.error.mockReset();
    mocks.spawn.mockReset();
  });

  afterEach(async () => {
    vi.useRealTimers();
    // Reset any leftover handlers from the previous run.
    vi.restoreAllMocks();
  });

  it("catches renewal interval errors instead of letting them become unhandled rejections", async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    // Initial watch start succeeds; every renewal throws.
    mocks.runCommandWithTimeout
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockRejectedValue(new Error("renewal failed"));

    const child = new EventEmitter();
    const kill = vi.fn((signal: string) => {
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    });
    mocks.spawn.mockReturnValue(Object.assign(child, { kill, killed: false }));

    // Start the service without awaiting; it runs until we signal shutdown.
    const servicePromise = runGmailService({} as never);

    // Advance one full renewal cycle to trigger the interval callback.
    await vi.advanceTimersByTimeAsync(720 * 60_000);

    // Shut down so the test can finish.
    process.emit("SIGINT", "SIGINT");
    await servicePromise.catch(() => {
      // The service may reject on forced shutdown; we only care about unhandled rejections.
    });

    process.off("unhandledRejection", onUnhandled);

    expect(unhandled).toHaveLength(0);
  });
});
