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

describe("runServiceRestart token drift", () => {
  beforeAll(async () => {
    ({ runServiceRestart } = await import("./lifecycle-core.js"));
  });

  beforeEach(() => {
    runtimeLogs.length = 0;
    loadConfig.mockReset();
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    });
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

  it("uses env-first token precedence when checking drift", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    });
    service.readCommand.mockResolvedValue({
      environment: { OPENCLAW_GATEWAY_TOKEN: "env-token" },
    });
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "env-token");

    await runServiceRestart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
      checkTokenDrift: true,
    });

    const jsonLine = runtimeLogs.find((line) => line.trim().startsWith("{"));
    const payload = JSON.parse(jsonLine ?? "{}") as { warnings?: string[] };
    expect(payload.warnings).toBeUndefined();
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

describe("runServiceStart — load on not-loaded service", () => {
  let runServiceStart: typeof import("./lifecycle-core.js").runServiceStart;

  const loadMock = vi.fn();

  const serviceWithLoad = {
    ...service,
    load: loadMock,
  };

  beforeAll(async () => {
    ({ runServiceStart } = await import("./lifecycle-core.js"));
  });

  beforeEach(() => {
    runtimeLogs.length = 0;
    service.isLoaded.mockReset();
    service.restart.mockReset();
    loadMock.mockReset();
    vi.unstubAllEnvs();
  });

  it("calls load() and emits started when service is not loaded but load succeeds", async () => {
    service.isLoaded
      .mockResolvedValueOnce(false) // initial isLoaded check
      .mockResolvedValueOnce(true); // post-load isLoaded check
    loadMock.mockResolvedValue(undefined);

    await runServiceStart({
      serviceNoun: "Gateway",
      service: serviceWithLoad,
      renderStartHints: () => ["openclaw gateway install"],
      opts: { json: true },
    });

    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(service.restart).not.toHaveBeenCalled();
    const jsonLine = runtimeLogs.find((l) => l.trim().startsWith("{"));
    const payload = JSON.parse(jsonLine ?? "{}") as { result?: string };
    expect(payload.result).toBe("started");
  });

  it("falls back to not-loaded hint when load() throws (plist missing)", async () => {
    service.isLoaded.mockResolvedValueOnce(false);
    loadMock.mockRejectedValue(new Error("No LaunchAgent plist found"));

    await runServiceStart({
      serviceNoun: "Gateway",
      service: serviceWithLoad,
      renderStartHints: () => ["openclaw gateway install"],
      opts: { json: true },
    });

    expect(loadMock).toHaveBeenCalledTimes(1);
    const jsonLine = runtimeLogs.find((l) => l.trim().startsWith("{"));
    const payload = JSON.parse(jsonLine ?? "{}") as { result?: string };
    expect(payload.result).toBe("not-loaded");
  });

  it("uses restart() when service is already loaded", async () => {
    service.isLoaded.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    service.restart.mockResolvedValue(undefined);

    await runServiceStart({
      serviceNoun: "Gateway",
      service: serviceWithLoad,
      renderStartHints: () => [],
      opts: { json: true },
    });

    expect(service.restart).toHaveBeenCalledTimes(1);
    expect(loadMock).not.toHaveBeenCalled();
    const jsonLine = runtimeLogs.find((l) => l.trim().startsWith("{"));
    const payload = JSON.parse(jsonLine ?? "{}") as { result?: string };
    expect(payload.result).toBe("started");
  });
});
