import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  start: vi.fn(),
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

let runServiceRestart: typeof import("./lifecycle-core.js").runServiceRestart;
let runServiceStart: typeof import("./lifecycle-core.js").runServiceStart;

describe("runServiceRestart token drift", () => {
  beforeAll(async () => {
    ({ runServiceRestart, runServiceStart } = await import("./lifecycle-core.js"));
  });

  beforeEach(() => {
    runtimeLogs.length = 0;
    loadConfig.mockClear();
    service.isLoaded.mockClear();
    service.readCommand.mockClear();
    service.start.mockClear();
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

describe("runServiceStart", () => {
  beforeAll(async () => {
    if (!runServiceStart) {
      ({ runServiceStart } = await import("./lifecycle-core.js"));
    }
  });

  beforeEach(() => {
    runtimeLogs.length = 0;
    service.isLoaded.mockClear();
    service.start.mockClear();
    service.restart.mockClear();
    vi.unstubAllEnvs();
  });

  it("invokes start when service is not loaded", async () => {
    service.isLoaded.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    service.start.mockResolvedValue(undefined);

    await runServiceStart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => ["hint-1"],
      opts: { json: true },
    });

    expect(service.start).toHaveBeenCalledTimes(1);
    expect(service.restart).not.toHaveBeenCalled();
    const jsonLine = runtimeLogs.find((line) => line.trim().startsWith("{"));
    const payload = JSON.parse(jsonLine ?? "{}") as { ok?: boolean; result?: string };
    expect(payload.ok).toBe(true);
    expect(payload.result).toBe("started");
  });

  it("falls back to hints when start throws", async () => {
    service.isLoaded.mockResolvedValue(false);
    service.start.mockRejectedValue(new Error("boom"));

    await runServiceStart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => ["hint-1"],
      opts: { json: true },
    });

    const jsonLine = runtimeLogs.find((line) => line.trim().startsWith("{"));
    const payload = JSON.parse(jsonLine ?? "{}") as { result?: string; hints?: string[] };
    expect(payload.result).toBe("not-loaded");
    expect(payload.hints?.[0]).toBe("hint-1");
  });
});
