// Gmail ops tests cover setup/runtime config transitions.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runGmailService, runGmailSetup } from "./gmail-ops.js";

const mocks = vi.hoisted(() => ({
  ensureDependency: vi.fn(),
  ensureGcloudAuth: vi.fn(),
  ensureSubscription: vi.fn(),
  ensureTailscaleEndpoint: vi.fn(),
  ensureTopic: vi.fn(),
  resolveProjectIdFromGogCredentials: vi.fn(),
  runGcloud: vi.fn(),
  getRuntimeConfig: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
  resolveGatewayPort: vi.fn(),
  validateConfigObjectWithPlugins: vi.fn(),
  runCommandWithTimeout: vi.fn(),
  spawn: vi.fn(),
  runtimeError: vi.fn(),
  runtimeLog: vi.fn(),
  runtimeWriteJson: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    { spawn: mocks.spawn },
  );
});

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "/tmp/openclaw-test.json",
  getRuntimeConfig: mocks.getRuntimeConfig,
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  replaceConfigFile: mocks.replaceConfigFile,
  resolveGatewayPort: mocks.resolveGatewayPort,
  validateConfigObjectWithPlugins: mocks.validateConfigObjectWithPlugins,
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    error: mocks.runtimeError,
    log: mocks.runtimeLog,
    writeJson: mocks.runtimeWriteJson,
  },
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

describe("runGmailSetup", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.resolveGatewayPort.mockReturnValue(18789);
    mocks.validateConfigObjectWithPlugins.mockImplementation((config: OpenClawConfig) => ({
      ok: true,
      config,
    }));
    mocks.runCommandWithTimeout.mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });
    mocks.spawn.mockReset();
  });

  it("replaces stale pull delivery when setup writes a push subscription", async () => {
    const baseConfig: OpenClawConfig = {
      hooks: {
        enabled: true,
        path: "/hooks",
        token: "existing-hook-token",
        presets: ["gmail"],
        gmail: {
          account: "old@example.com",
          label: "INBOX",
          topic: "projects/project-a/topics/gog-gmail-watch",
          subscription: "projects/project-a/subscriptions/gog-gmail-watch-pull",
          delivery: {
            mode: "pull",
            subscription: "projects/project-a/subscriptions/gog-gmail-watch-pull",
          },
          hookUrl: "http://127.0.0.1:18789/hooks/gmail",
          includeBody: false,
          maxBytes: 100,
          renewEveryMinutes: 60,
        },
      },
    };

    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: baseConfig,
    });

    await runGmailSetup({
      account: "new@example.com",
      project: "project-a",
      subscription: "gog-gmail-watch-push",
      pushEndpoint: "https://gateway.example.com/gmail-pubsub",
      tailscale: "off",
    });

    expect(mocks.ensureSubscription).toHaveBeenCalledWith(
      "project-a",
      "gog-gmail-watch-push",
      "gog-gmail-watch",
      "https://gateway.example.com/gmail-pubsub",
    );

    const write = mocks.replaceConfigFile.mock.calls[0]?.[0] as
      | { nextConfig: OpenClawConfig }
      | undefined;
    const gmail = write?.nextConfig.hooks?.gmail;

    expect(gmail?.subscription).toBe("gog-gmail-watch-push");
    expect(gmail?.delivery).toEqual({
      mode: "push",
      subscription: "gog-gmail-watch-push",
    });
    expect(gmail?.account).toBe("new@example.com");
  });

  it("fails pull delivery before spawning when gog lacks pull support", async () => {
    const config: OpenClawConfig = {
      hooks: {
        enabled: true,
        token: "hook-token",
        gmail: {
          account: "new@example.com",
          topic: "projects/project-a/topics/gog-gmail-watch",
          delivery: {
            mode: "pull",
            subscription: "projects/project-a/subscriptions/gog-gmail-watch-pull",
          },
        },
      },
    };
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.runCommandWithTimeout.mockResolvedValue({
      stdout: "",
      stderr: "unknown command pull",
      code: 1,
      signal: null,
      killed: false,
    });

    await expect(runGmailService({})).rejects.toThrow("gog gmail watch pull is unavailable");

    expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(1);
    expect(mocks.runCommandWithTimeout).toHaveBeenCalledWith(
      ["gog", "gmail", "watch", "pull", "--help"],
      expect.objectContaining({ timeoutMs: 30000 }),
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
