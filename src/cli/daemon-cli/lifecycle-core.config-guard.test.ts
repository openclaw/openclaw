import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const readConfigFileSnapshotMock = vi.fn();
const loadConfig = vi.fn(() => ({}));

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
  readConfigFileSnapshot: () => readConfigFileSnapshotMock(),
}));

vi.mock("../../config/issue-format.js", () => ({
  formatConfigIssueLines: (
    issues: Array<{ path: string; message: string }>,
    _prefix: string,
    _opts?: unknown,
  ) => issues.map((i) => `${i.path}: ${i.message}`),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

describe("runServiceRestart config pre-flight (#35862)", () => {
  let runServiceRestart: typeof import("./lifecycle-core.js").runServiceRestart;

  beforeAll(async () => {
    ({ runServiceRestart } = await import("./lifecycle-core.js"));
  });

  beforeEach(() => {
    runtimeLogs.length = 0;
    readConfigFileSnapshotMock.mockReset();
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      issues: [],
    });
    loadConfig.mockReset();
    loadConfig.mockReturnValue({});
    service.isLoaded.mockClear();
    service.readCommand.mockClear();
    service.restart.mockClear();
    service.isLoaded.mockResolvedValue(true);
    service.readCommand.mockResolvedValue({ environment: {} });
    service.restart.mockResolvedValue(undefined);
    vi.unstubAllEnvs();
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
    vi.stubEnv("CLAWDBOT_GATEWAY_TOKEN", "");
  });

  it("aborts restart when config is invalid", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: false,
      config: {},
      issues: [{ path: "agents.defaults.pdfModel", message: "Unrecognized key" }],
    });

    await expect(
      runServiceRestart({
        serviceNoun: "Gateway",
        service,
        renderStartHints: () => [],
        opts: { json: true },
      }),
    ).rejects.toThrow("__exit__:1");

    expect(service.restart).not.toHaveBeenCalled();
  });

  it("proceeds with restart when config is valid", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      issues: [],
    });

    const result = await runServiceRestart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
    });

    expect(result).toBe(true);
    expect(service.restart).toHaveBeenCalledTimes(1);
  });

  it("proceeds with restart when config file does not exist", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: false,
      valid: true,
      config: {},
      issues: [],
    });

    const result = await runServiceRestart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
    });

    expect(result).toBe(true);
    expect(service.restart).toHaveBeenCalledTimes(1);
  });

  it("proceeds with restart when snapshot read throws", async () => {
    readConfigFileSnapshotMock.mockRejectedValue(new Error("read failed"));

    const result = await runServiceRestart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
    });

    expect(result).toBe(true);
    expect(service.restart).toHaveBeenCalledTimes(1);
  });
});
