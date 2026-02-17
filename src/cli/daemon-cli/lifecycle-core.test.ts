import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.fn(() => ({
  gateway: {
    auth: {
      token: "config-token",
    },
  },
}));

const runtimeLogs: string[] = [];
const defaultRuntime = {
  log: (message: string) => runtimeLogs.push(message),
  error: vi.fn(),
  exit: (code: number) => {
    throw new Error(`__exit__:${code}`);
  },
};

const service = {
  label: "TestService",
  loadedText: "loaded",
  notLoadedText: "not loaded",
  install: vi.fn(),
  uninstall: vi.fn(),
  stop: vi.fn(),
  isLoaded: vi.fn(),
  readCommand: vi.fn(),
  readRuntime: vi.fn(),
  restart: vi.fn(),
};

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfig(),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

describe("runServiceRestart token drift", () => {
  beforeEach(() => {
    runtimeLogs.length = 0;
    loadConfig.mockClear();
    service.isLoaded.mockClear();
    service.readCommand.mockClear();
    service.restart.mockClear();
    service.isLoaded.mockResolvedValue(true);
    service.readCommand.mockResolvedValue({
      environment: { OPENCLAW_GATEWAY_TOKEN: "service-token" },
    });
    service.restart.mockResolvedValue(undefined);
    vi.unstubAllEnvs();
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
    vi.stubEnv("CLAWDBOT_GATEWAY_TOKEN", "");
  });

  it("emits drift warning when enabled", async () => {
    const { runServiceRestart } = await import("./lifecycle-core.js");

    await runServiceRestart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
      checkTokenDrift: true,
    });

    expect(loadConfig).toHaveBeenCalledTimes(1);
    const jsonLine = runtimeLogs.find((line) => line.trim().startsWith("{"));
    const payload = JSON.parse(jsonLine ?? "{}") as { warnings?: string[] };
    expect(payload.warnings?.[0]).toContain("gateway install --force");
  });

  it("skips drift warning when disabled", async () => {
    const { runServiceRestart } = await import("./lifecycle-core.js");

    await runServiceRestart({
      serviceNoun: "Node",
      service,
      renderStartHints: () => [],
      opts: { json: true },
    });

    expect(loadConfig).not.toHaveBeenCalled();
    expect(service.readCommand).not.toHaveBeenCalled();
    const jsonLine = runtimeLogs.find((line) => line.trim().startsWith("{"));
    const payload = JSON.parse(jsonLine ?? "{}") as { warnings?: string[] };
    expect(payload.warnings).toBeUndefined();
  });
});
