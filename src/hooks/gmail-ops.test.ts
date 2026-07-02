// Gmail hook ops tests cover foreground watcher command behavior.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  defaultRuntime: {
    error: vi.fn(),
    log: vi.fn(),
    writeJson: vi.fn(),
  },
  ensureDependency: vi.fn(),
  ensureGcloudAuth: vi.fn(),
  ensureSubscription: vi.fn(),
  ensureTailscaleEndpoint: vi.fn(),
  ensureTopic: vi.fn(),
  getRuntimeConfig: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
  resolveExecutable: vi.fn((name: string) => name),
  resolveGatewayPort: vi.fn(() => 8080),
  resolveProjectIdFromGogCredentials: vi.fn(),
  runCommandWithTimeout: vi.fn(),
  runGcloud: vi.fn(),
  spawn: vi.fn(),
  validateConfigObjectWithPlugins: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "/tmp/openclaw.json",
  DEFAULT_GATEWAY_PORT: 8080,
  getRuntimeConfig: mocks.getRuntimeConfig,
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  replaceConfigFile: mocks.replaceConfigFile,
  resolveGatewayPort: mocks.resolveGatewayPort,
  validateConfigObjectWithPlugins: mocks.validateConfigObjectWithPlugins,
}));

vi.mock("../infra/executable-path.js", () => ({
  resolveExecutable: mocks.resolveExecutable,
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("./gmail-setup-utils.js", () => ({
  ensureDependency: mocks.ensureDependency,
  ensureGcloudAuth: mocks.ensureGcloudAuth,
  ensureSubscription: mocks.ensureSubscription,
  ensureTailscaleEndpoint: mocks.ensureTailscaleEndpoint,
  ensureTopic: mocks.ensureTopic,
  resolveProjectIdFromGogCredentials: mocks.resolveProjectIdFromGogCredentials,
  runGcloud: mocks.runGcloud,
}));

const { runGmailService } = await import("./gmail-ops.js");
const { GMAIL_WATCH_REAUTH_REASON } = await import("./gmail-watcher-errors.js");

let baselineSigintListeners: Set<(...args: unknown[]) => void>;
let baselineSigtermListeners: Set<(...args: unknown[]) => void>;

function createGmailConfig() {
  return {
    hooks: {
      enabled: true,
      token: "hook-token",
      gmail: {
        account: "me@example.com",
        topic: "projects/demo/topics/gmail",
        pushToken: "push-token",
        renewEveryMinutes: 1,
      },
    },
  };
}

function createChild() {
  const child = new EventEmitter();
  return Object.assign(child, {
    kill: vi.fn(() => true),
    killed: false,
  });
}

describe("runGmailService", () => {
  beforeEach(() => {
    baselineSigintListeners = new Set(
      process.listeners("SIGINT") as Array<(...args: unknown[]) => void>,
    );
    baselineSigtermListeners = new Set(
      process.listeners("SIGTERM") as Array<(...args: unknown[]) => void>,
    );
    mocks.defaultRuntime.error.mockClear();
    mocks.defaultRuntime.log.mockClear();
    mocks.defaultRuntime.writeJson.mockClear();
    mocks.ensureDependency.mockReset();
    mocks.ensureDependency.mockResolvedValue(undefined);
    mocks.ensureGcloudAuth.mockReset();
    mocks.ensureSubscription.mockReset();
    mocks.ensureTailscaleEndpoint.mockReset();
    mocks.ensureTopic.mockReset();
    mocks.getRuntimeConfig.mockReset();
    mocks.getRuntimeConfig.mockReturnValue(createGmailConfig());
    mocks.replaceConfigFile.mockReset();
    mocks.resolveExecutable.mockImplementation((name: string) => name);
    mocks.resolveGatewayPort.mockReturnValue(8080);
    mocks.resolveProjectIdFromGogCredentials.mockReset();
    mocks.runCommandWithTimeout.mockReset();
    mocks.runCommandWithTimeout.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    mocks.runGcloud.mockReset();
    mocks.spawn.mockReset();
    mocks.spawn.mockImplementation(createChild);
    mocks.validateConfigObjectWithPlugins.mockReset();
    mocks.readConfigFileSnapshot.mockReset();
  });

  afterEach(() => {
    for (const listener of process.listeners("SIGINT")) {
      if (!baselineSigintListeners.has(listener as (...args: unknown[]) => void)) {
        process.off("SIGINT", listener);
      }
    }
    for (const listener of process.listeners("SIGTERM")) {
      if (!baselineSigtermListeners.has(listener as (...args: unknown[]) => void)) {
        process.off("SIGTERM", listener);
      }
    }
  });

  it("stops the foreground serve process when watch renewal needs Gmail re-auth", async () => {
    vi.useFakeTimers();
    try {
      const child = createChild();
      mocks.spawn.mockReturnValue(child);
      mocks.runCommandWithTimeout
        .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
        .mockResolvedValueOnce({
          code: 1,
          stdout: "",
          stderr: "invalid_grant: Token has been expired or revoked",
        });

      await runGmailService({});

      await vi.advanceTimersByTimeAsync(60_000);

      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(
        `${GMAIL_WATCH_REAUTH_REASON}; stopping gmail watcher`,
      );
      expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
