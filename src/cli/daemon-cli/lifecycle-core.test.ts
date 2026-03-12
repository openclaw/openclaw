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

  describe("repairNotLoaded (#43602)", () => {
    it("start: repairs unloaded service when repairNotLoaded succeeds", async () => {
      service.isLoaded.mockResolvedValue(false);
      const repairNotLoaded = vi.fn().mockResolvedValue({ ok: true });
      const serviceWithRepair = { ...service, repairNotLoaded };

      await runServiceStart({
        serviceNoun: "Gateway",
        service: serviceWithRepair,
        renderStartHints: () => [],
        opts: { json: true },
      });

      expect(repairNotLoaded).toHaveBeenCalledTimes(1);
      // After successful repair, start should proceed to restart the service.
      expect(service.restart).toHaveBeenCalledTimes(1);
      const jsonLine = runtimeLogs.find((line) => line.trim().startsWith("{"));
      const payload = JSON.parse(jsonLine ?? "{}") as { result?: string };
      expect(payload.result).toBe("started");
    });

    it("start: falls through to hints when repairNotLoaded returns ok:false", async () => {
      service.isLoaded.mockResolvedValue(false);
      const repairNotLoaded = vi.fn().mockResolvedValue({ ok: false });
      const serviceWithRepair = { ...service, repairNotLoaded };

      await runServiceStart({
        serviceNoun: "Gateway",
        service: serviceWithRepair,
        renderStartHints: () => ["openclaw gateway install"],
        opts: { json: true },
      });

      expect(repairNotLoaded).toHaveBeenCalledTimes(1);
      expect(service.restart).not.toHaveBeenCalled();
      const jsonLine = runtimeLogs.find((line) => line.trim().startsWith("{"));
      const payload = JSON.parse(jsonLine ?? "{}") as { result?: string; hints?: string[] };
      expect(payload.result).toBe("not-loaded");
      expect(payload.hints).toContain("openclaw gateway install");
    });

    it("start: falls through to hints when repairNotLoaded throws", async () => {
      service.isLoaded.mockResolvedValue(false);
      const repairNotLoaded = vi.fn().mockRejectedValue(new Error("launchctl failed"));
      const serviceWithRepair = { ...service, repairNotLoaded };

      await runServiceStart({
        serviceNoun: "Gateway",
        service: serviceWithRepair,
        renderStartHints: () => ["openclaw gateway install"],
        opts: { json: true },
      });

      expect(repairNotLoaded).toHaveBeenCalledTimes(1);
      expect(service.restart).not.toHaveBeenCalled();
      const jsonLine = runtimeLogs.find((line) => line.trim().startsWith("{"));
      const payload = JSON.parse(jsonLine ?? "{}") as { result?: string };
      expect(payload.result).toBe("not-loaded");
    });

    it("start: does not call repairNotLoaded when service is already loaded", async () => {
      service.isLoaded.mockResolvedValue(true);
      const repairNotLoaded = vi.fn().mockResolvedValue({ ok: true });
      const serviceWithRepair = { ...service, repairNotLoaded };

      await runServiceStart({
        serviceNoun: "Gateway",
        service: serviceWithRepair,
        renderStartHints: () => [],
        opts: { json: true },
      });

      expect(repairNotLoaded).not.toHaveBeenCalled();
    });

    it("restart: repairs unloaded service when onNotLoaded returns null", async () => {
      service.isLoaded.mockResolvedValue(false);
      const repairNotLoaded = vi.fn().mockResolvedValue({ ok: true });
      const serviceWithRepair = { ...service, repairNotLoaded };

      const result = await runServiceRestart({
        serviceNoun: "Gateway",
        service: serviceWithRepair,
        renderStartHints: () => [],
        opts: { json: true },
        onNotLoaded: async () => null,
      });

      expect(result).toBe(true);
      expect(repairNotLoaded).toHaveBeenCalledTimes(1);
      const jsonLine = runtimeLogs.find((line) => line.trim().startsWith("{"));
      const payload = JSON.parse(jsonLine ?? "{}") as { result?: string; message?: string };
      expect(payload.result).toBe("restarted");
      expect(payload.message).toContain("re-registered");
    });

    it("restart: skips repair when onNotLoaded handles it", async () => {
      service.isLoaded.mockResolvedValue(false);
      const repairNotLoaded = vi.fn().mockResolvedValue({ ok: true });
      const serviceWithRepair = { ...service, repairNotLoaded };

      const result = await runServiceRestart({
        serviceNoun: "Gateway",
        service: serviceWithRepair,
        renderStartHints: () => [],
        opts: { json: true },
        onNotLoaded: async () => ({
          result: "restarted" as const,
          message: "handled by SIGUSR1",
        }),
      });

      expect(result).toBe(true);
      expect(repairNotLoaded).not.toHaveBeenCalled();
    });

    it("restart: falls through to hints when repair returns ok:false", async () => {
      service.isLoaded.mockResolvedValue(false);
      const repairNotLoaded = vi.fn().mockResolvedValue({ ok: false });
      const serviceWithRepair = { ...service, repairNotLoaded };

      const result = await runServiceRestart({
        serviceNoun: "Gateway",
        service: serviceWithRepair,
        renderStartHints: () => ["openclaw gateway install"],
        opts: { json: true },
        onNotLoaded: async () => null,
      });

      expect(result).toBe(false);
      expect(repairNotLoaded).toHaveBeenCalledTimes(1);
      const jsonLine = runtimeLogs.find((line) => line.trim().startsWith("{"));
      const payload = JSON.parse(jsonLine ?? "{}") as { result?: string };
      expect(payload.result).toBe("not-loaded");
    });
  });
});
