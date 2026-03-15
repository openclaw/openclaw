import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultRuntime,
  resetLifecycleRuntimeLogs,
  resetLifecycleServiceMocks,
  runtimeLogs,
  service,
  stubEmptyGatewayEnv,
} from "./test-helpers/lifecycle-core-harness.js";

const loadConfig = vi.fn(() => ({
  gateway: {
    auth: {
      token: "config-token",
    },
  },
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfig(),
  readBestEffortConfig: async () => loadConfig(),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

let runServiceRestart: typeof import("./lifecycle-core.js").runServiceRestart;
let runServiceStart: typeof import("./lifecycle-core.js").runServiceStart;
let runServiceStop: typeof import("./lifecycle-core.js").runServiceStop;

function readJsonLog<T extends object>() {
  const jsonLine = runtimeLogs.find((line) => line.trim().startsWith("{"));
  return JSON.parse(jsonLine ?? "{}") as T;
}

function createServiceRunArgs(checkTokenDrift?: boolean) {
  return {
    serviceNoun: "Gateway",
    service,
    renderStartHints: () => [],
    opts: { json: true as const },
    ...(checkTokenDrift ? { checkTokenDrift } : {}),
  };
}

describe("runServiceRestart token drift", () => {
  beforeAll(async () => {
    ({ runServiceRestart, runServiceStart, runServiceStop } = await import("./lifecycle-core.js"));
  });

  beforeEach(() => {
    resetLifecycleRuntimeLogs();
    loadConfig.mockReset();
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    });
    resetLifecycleServiceMocks();
    service.readCommand.mockResolvedValue({
      programArguments: [],
      environment: { OPENCLAW_GATEWAY_TOKEN: "service-token" },
    });
    stubEmptyGatewayEnv();
  });

  it("emits drift warning when enabled", async () => {
    await runServiceRestart(createServiceRunArgs(true));

    expect(loadConfig).toHaveBeenCalledTimes(1);
    const payload = readJsonLog<{ warnings?: string[] }>();
    expect(payload.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("gateway install --force")]),
    );
  });

  it("compares restart drift against config token even when caller env is set", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    });
    service.readCommand.mockResolvedValue({
      programArguments: [],
      environment: { OPENCLAW_GATEWAY_TOKEN: "env-token" },
    });
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "env-token");

    await runServiceRestart(createServiceRunArgs(true));

    const payload = readJsonLog<{ warnings?: string[] }>();
    expect(payload.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("gateway install --force")]),
    );
  });

  it("skips drift warning when disabled", async () => {
    await runServiceRestart({
      serviceNoun: "Node",
      service,
      renderStartHints: () => [],
      opts: { json: true },
    });

    expect(loadConfig).not.toHaveBeenCalled();
    expect(service.readCommand).not.toHaveBeenCalled();
    const payload = readJsonLog<{ warnings?: string[] }>();
    expect(payload.warnings).toBeUndefined();
  });

  it("emits stopped when an unmanaged process handles stop", async () => {
    service.isLoaded.mockResolvedValue(false);

    await runServiceStop({
      serviceNoun: "Gateway",
      service,
      opts: { json: true },
      onNotLoaded: async () => ({
        result: "stopped",
        message: "Gateway stop signal sent to unmanaged process on port 18789: 4200.",
      }),
    });

    const payload = readJsonLog<{ result?: string; message?: string }>();
    expect(payload.result).toBe("stopped");
    expect(payload.message).toContain("unmanaged process");
    expect(service.stop).not.toHaveBeenCalled();
  });

  it("runs restart health checks after an unmanaged restart signal", async () => {
    const postRestartCheck = vi.fn(async () => {});
    service.isLoaded.mockResolvedValue(false);

    await runServiceRestart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
      onNotLoaded: async () => ({
        result: "restarted",
        message: "Gateway restart signal sent to unmanaged process on port 18789: 4200.",
      }),
      postRestartCheck,
    });

    expect(postRestartCheck).toHaveBeenCalledTimes(1);
    expect(service.restart).not.toHaveBeenCalled();
    expect(service.readCommand).not.toHaveBeenCalled();
    const payload = readJsonLog<{ result?: string; message?: string }>();
    expect(payload.result).toBe("restarted");
    expect(payload.message).toContain("unmanaged process");
  });

  it("skips restart health checks when restart is only scheduled", async () => {
    const postRestartCheck = vi.fn(async () => {});
    service.restart.mockResolvedValue({ outcome: "scheduled" });

    const result = await runServiceRestart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
      postRestartCheck,
    });

    expect(result).toBe(true);
    expect(postRestartCheck).not.toHaveBeenCalled();
    const payload = readJsonLog<{ result?: string; message?: string }>();
    expect(payload.result).toBe("scheduled");
    expect(payload.message).toBe("restart scheduled, gateway will restart momentarily");
  });

  it("invokes the before-restart hook before a successful direct restart", async () => {
    const events: string[] = [];
    const onBeforeRestart = vi.fn(async () => {
      events.push("before");
    });
    service.restart.mockImplementation(async (...args) => {
      void args;
      events.push("restart");
      return { outcome: "completed" };
    });

    await runServiceRestart({
      ...createServiceRunArgs(true),
      onBeforeRestart,
    });

    expect(onBeforeRestart).toHaveBeenCalledTimes(1);
    expect(events.slice(0, 2)).toEqual(["before", "restart"]);
  });

  it("invokes the restart completion hook for scheduled restarts", async () => {
    const onRestartComplete = vi.fn();
    service.restart.mockResolvedValue({ outcome: "scheduled" });

    await runServiceRestart({
      ...createServiceRunArgs(),
      onRestartComplete,
    });

    expect(onRestartComplete).toHaveBeenCalledTimes(1);
  });

  it("invokes the restart-failed hook when a prepared direct restart throws", async () => {
    const onBeforeRestart = vi.fn();
    const onRestartFailed = vi.fn();
    service.restart.mockRejectedValue(new Error("boom"));

    await expect(
      runServiceRestart({
        ...createServiceRunArgs(),
        onBeforeRestart,
        onRestartFailed,
      }),
    ).rejects.toThrow("__exit__:1");

    expect(onBeforeRestart).toHaveBeenCalledTimes(1);
    expect(onRestartFailed).toHaveBeenCalledTimes(1);
  });

  it("emits scheduled when service start routes through a scheduled restart", async () => {
    service.restart.mockResolvedValue({ outcome: "scheduled" });

    await runServiceStart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
    });

    expect(service.isLoaded).toHaveBeenCalledTimes(1);
    const payload = readJsonLog<{ result?: string; message?: string }>();
    expect(payload.result).toBe("scheduled");
    expect(payload.message).toBe("restart scheduled, gateway will restart momentarily");
  });
});
