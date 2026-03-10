import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultRuntime,
  resetLifecycleRuntimeLogs,
  resetLifecycleServiceMocks,
  service,
  stubEmptyGatewayEnv,
} from "./test-helpers/lifecycle-core-harness.js";

const readConfigFileSnapshotMock = vi.fn();
const loadConfig = vi.fn(() => ({}));

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

function setConfigSnapshot(params: {
  exists: boolean;
  valid: boolean;
  issues?: Array<{ path: string; message: string }>;
}) {
  readConfigFileSnapshotMock.mockResolvedValue({
    exists: params.exists,
    valid: params.valid,
    config: {},
    issues: params.issues ?? [],
  });
}

function createServiceRunArgs() {
  return {
    serviceNoun: "Gateway",
    service,
    renderStartHints: () => [],
    opts: { json: true },
  };
}

describe("runServiceRestart config pre-flight (#35862)", () => {
  let runServiceRestart: typeof import("./lifecycle-core.js").runServiceRestart;

  beforeAll(async () => {
    ({ runServiceRestart } = await import("./lifecycle-core.js"));
  });

  beforeEach(() => {
    resetLifecycleRuntimeLogs();
    readConfigFileSnapshotMock.mockReset();
    setConfigSnapshot({ exists: true, valid: true });
    loadConfig.mockReset();
    loadConfig.mockReturnValue({});
    resetLifecycleServiceMocks();
    stubEmptyGatewayEnv();
  });

  it("aborts restart when config is invalid", async () => {
    setConfigSnapshot({
      exists: true,
      valid: false,
      issues: [{ path: "agents.defaults.pdfModel", message: "Unrecognized key" }],
    });

    await expect(runServiceRestart(createServiceRunArgs())).rejects.toThrow("__exit__:1");

    expect(service.restart).not.toHaveBeenCalled();
  });

  it("proceeds with restart when config is valid", async () => {
    setConfigSnapshot({ exists: true, valid: true });

    const result = await runServiceRestart(createServiceRunArgs());

    expect(result).toBe(true);
    expect(service.restart).toHaveBeenCalledTimes(1);
  });

  it("proceeds with restart when config file does not exist", async () => {
    setConfigSnapshot({ exists: false, valid: true });

    const result = await runServiceRestart(createServiceRunArgs());

    expect(result).toBe(true);
    expect(service.restart).toHaveBeenCalledTimes(1);
  });

  it("proceeds with restart when snapshot read throws", async () => {
    readConfigFileSnapshotMock.mockRejectedValue(new Error("read failed"));

    const result = await runServiceRestart(createServiceRunArgs());

    expect(result).toBe(true);
    expect(service.restart).toHaveBeenCalledTimes(1);
  });
});

describe("runServiceStart config pre-flight (#35862)", () => {
  let runServiceStart: typeof import("./lifecycle-core.js").runServiceStart;

  beforeAll(async () => {
    ({ runServiceStart } = await import("./lifecycle-core.js"));
  });

  beforeEach(() => {
    resetLifecycleRuntimeLogs();
    readConfigFileSnapshotMock.mockReset();
    setConfigSnapshot({ exists: true, valid: true });
    resetLifecycleServiceMocks();
  });

  it("aborts start when config is invalid", async () => {
    setConfigSnapshot({
      exists: true,
      valid: false,
      issues: [{ path: "agents.defaults.pdfModel", message: "Unrecognized key" }],
    });

    await expect(runServiceStart(createServiceRunArgs())).rejects.toThrow("__exit__:1");

    expect(service.restart).not.toHaveBeenCalled();
  });

  it("does not attempt recovery restart when config is invalid and service is not loaded", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: false,
      config: {},
      issues: [{ path: "agents.defaults.pdfModel", message: "Unrecognized key" }],
    });
    service.isLoaded.mockResolvedValue(false);

    await expect(
      runServiceStart({
        serviceNoun: "Gateway",
        service,
        renderStartHints: () => ["openclaw gateway install"],
        opts: { json: true },
      }),
    ).rejects.toThrow("__exit__:1");

    expect(service.restart).not.toHaveBeenCalled();
  });

  it("proceeds with start when config is valid", async () => {
    setConfigSnapshot({ exists: true, valid: true });

    await runServiceStart(createServiceRunArgs());

    expect(service.restart).toHaveBeenCalledTimes(1);
  });

  it("attempts recovery restart when service is not loaded", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      issues: [],
    });
    service.isLoaded.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await runServiceStart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
    });

    expect(service.restart).toHaveBeenCalledTimes(1);
  });

  it("falls back to not-loaded guidance when recovery restart fails", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      issues: [],
    });
    service.isLoaded.mockResolvedValue(false);
    service.restart.mockRejectedValue(new Error("launchctl bootstrap failed"));

    await runServiceStart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => ["openclaw gateway install"],
      opts: { json: true },
    });

    const jsonLine = runtimeLogs.find((line) => line.trim().startsWith("{"));
    const payload = JSON.parse(jsonLine ?? "{}") as {
      result?: string;
      message?: string;
      hints?: string[];
    };
    expect(payload.result).toBe("not-loaded");
    expect(payload.message).toContain("not loaded");
    expect(payload.hints).toEqual(expect.arrayContaining(["openclaw gateway install"]));
  });
});
