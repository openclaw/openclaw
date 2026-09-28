// Lifecycle core env-drift tests verify restart-time detection of managed service environment changes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import {
  createGatewayServiceRunArgs as createServiceRunArgs,
  lifecycleRuntimeLogs,
  lifecycleTestRuntime,
  resetLifecycleRuntimeLogs,
  resetLifecycleServiceMocks,
  service,
  stubEmptyGatewayEnv,
} from "./test-helpers/lifecycle-core-harness.js";

const loadConfig = vi.fn<() => OpenClawConfig>(() => ({
  gateway: {
    auth: {
      token: "config-token",
    },
  },
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => loadConfig(),
  loadConfig: () => loadConfig(),
  readBestEffortConfig: async () => loadConfig(),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: lifecycleTestRuntime,
}));

vi.mock("../../infra/restart-intent.js", () => ({
  prepareGatewayRestartIntentLegacyProcess: async () => undefined,
  clearGatewayRestartIntentSync: () => undefined,
  writeGatewayRestartIntentSync: () => undefined,
  writeGatewayServiceRestartIntentSync: () => undefined,
}));

const { runServiceRestart } = await import("./lifecycle-core.js");

describe("runServiceRestart managed service env drift", () => {
  beforeEach(() => {
    mockSystemAccountHome();
    stubEmptyGatewayEnv();
    resetLifecycleServiceMocks();
    resetLifecycleRuntimeLogs();
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    });
  });

  function readJsonLog(): { warnings?: string[] } {
    const jsonLine = lifecycleRuntimeLogs.find((line) => line.trim().startsWith("{"));
    return JSON.parse(jsonLine ?? "{}") as { warnings?: string[] };
  }

  it("warns when managed service environment has changed value on restart", async () => {
    loadConfig.mockReturnValue({
      env: {
        TAVILY_API_KEY: "tvly-new-value",
      },
    });
    service.readCommand.mockResolvedValue({
      programArguments: [],
      environment: {
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "TAVILY_API_KEY",
        TAVILY_API_KEY: "tvly-stale-value",
      },
    });

    await runServiceRestart(createServiceRunArgs(true));

    const payload = readJsonLog();
    expect(
      payload.warnings?.some((warning) =>
        warning.includes(
          "Durable service environment differs from service definition for managed keys (TAVILY_API_KEY)",
        ),
      ),
    ).toBe(true);
    expect(payload.warnings?.some((warning) => warning.includes("gateway install --force"))).toBe(
      true,
    );
  });

  it("warns when a managed durable key was removed on restart", async () => {
    loadConfig.mockReturnValue({});
    service.readCommand.mockResolvedValue({
      programArguments: [],
      environment: {
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "TAVILY_API_KEY",
        TAVILY_API_KEY: "tvly-stale-value",
      },
    });

    await runServiceRestart(createServiceRunArgs(true));

    const payload = readJsonLog();
    expect(
      payload.warnings?.some((warning) =>
        warning.includes(
          "Durable service environment differs from service definition for managed keys (TAVILY_API_KEY)",
        ),
      ),
    ).toBe(true);
    expect(payload.warnings?.some((warning) => warning.includes("gateway install --force"))).toBe(
      true,
    );
  });

  it("includes config env values in durable environment during restart drift checks", async () => {
    loadConfig.mockReturnValue({
      env: {
        CONFIG_MANAGED_KEY: "config-value",
      },
    });
    service.readCommand.mockResolvedValue({
      programArguments: [],
      environment: {
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "CONFIG_MANAGED_KEY",
        CONFIG_MANAGED_KEY: "config-value",
      },
    });

    await runServiceRestart(createServiceRunArgs(true));

    const payload = readJsonLog();
    expect(payload.warnings).toBeUndefined();
  });

  it("runs environment drift check even when token SecretRef resolution fails", async () => {
    loadConfig.mockReturnValue({
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
      gateway: {
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "UNRESOLVED_TOKEN_KEY" },
        },
      },
      env: {
        TAVILY_API_KEY: "tvly-new-value",
      },
    });
    service.readCommand.mockResolvedValue({
      programArguments: [],
      environment: {
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "TAVILY_API_KEY",
        TAVILY_API_KEY: "tvly-stale-value",
      },
    });

    await runServiceRestart(createServiceRunArgs(true));

    const payload = readJsonLog();
    expect(
      payload.warnings?.some((warning) =>
        warning.includes("gateway.auth.token SecretRef is configured but unavailable"),
      ),
    ).toBe(true);
    expect(
      payload.warnings?.some((warning) =>
        warning.includes(
          "Durable service environment differs from service definition for managed keys (TAVILY_API_KEY)",
        ),
      ),
    ).toBe(true);
  });
});
