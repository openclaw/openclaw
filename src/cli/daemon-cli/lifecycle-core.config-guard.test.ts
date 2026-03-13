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

describe("runServiceRestart config pre-flight (#35862)", () => {
  let runServiceRestart: typeof import("./lifecycle-core.js").runServiceRestart;

  beforeAll(async () => {
    ({ runServiceRestart } = await import("./lifecycle-core.js"));
  });

  beforeEach(() => {
    resetLifecycleRuntimeLogs();
    readConfigFileSnapshotMock.mockReset();
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      issues: [],
    });
    loadConfig.mockReset();
    loadConfig.mockReturnValue({});
    resetLifecycleServiceMocks();
    stubEmptyGatewayEnv();
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

describe("runServiceStart config pre-flight (#35862)", () => {
  let runServiceStart: typeof import("./lifecycle-core.js").runServiceStart;

  beforeAll(async () => {
    ({ runServiceStart } = await import("./lifecycle-core.js"));
  });

  beforeEach(() => {
    resetLifecycleRuntimeLogs();
    readConfigFileSnapshotMock.mockReset();
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      issues: [],
    });
    resetLifecycleServiceMocks();
  });

  it("aborts start when config is invalid", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: false,
      config: {},
      issues: [{ path: "agents.defaults.pdfModel", message: "Unrecognized key" }],
    });

    await expect(
      runServiceStart({
        serviceNoun: "Gateway",
        service,
        renderStartHints: () => [],
        opts: { json: true },
      }),
    ).rejects.toThrow("__exit__:1");

    expect(service.restart).not.toHaveBeenCalled();
  });

  it("proceeds with start when config is valid", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      issues: [],
    });

    await runServiceStart({
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json: true },
    });

    expect(service.restart).toHaveBeenCalledTimes(1);
  });
});
