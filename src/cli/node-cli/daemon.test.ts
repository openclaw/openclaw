import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { DaemonActionResponse } from "../daemon-cli/response.js";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";

const buildNodeInstallPlanMock = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => ({
    programArguments: ["openclaw", "node", "run"],
    workingDirectory: "/tmp",
    environment: {},
    environmentValueSources: {},
    description: "OpenClaw node service",
  })),
);
const isNodeDaemonRuntimeMock = vi.hoisted(() =>
  vi.fn((value: unknown) => value === "node" || value === "bun"),
);
const loadNodeHostConfigMock = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{
      version: number;
      nodeId?: string;
      gateway?: { host?: string; port?: number; tls?: boolean; tlsFingerprint?: string };
    } | null> => null,
  ),
);
const resolveNodeServiceMock = vi.hoisted(() => vi.fn());
const installDaemonServiceAndEmitMock = vi.hoisted(() => vi.fn(async (_params?: unknown) => {}));
const buildDaemonServiceSnapshotMock = vi.hoisted(() =>
  vi.fn(() => ({ label: "Node", loaded: false })),
);
const runServiceStartMock = vi.hoisted(() => vi.fn(async (_params?: unknown) => {}));
const runServiceStopMock = vi.hoisted(() => vi.fn(async (_params?: unknown) => {}));
const runServiceRestartMock = vi.hoisted(() => vi.fn(async (_params?: unknown) => {}));
const runServiceUninstallMock = vi.hoisted(() => vi.fn(async (_params?: unknown) => {}));
const parsePortMock = vi.hoisted(() =>
  vi.fn((value: unknown): number | null => {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "string" && value.trim()) {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }),
);
const resolveIsNixModeMock = vi.hoisted(() => vi.fn(() => false));

const actionState = vi.hoisted(() => ({
  warnings: [] as string[],
  emitted: [] as DaemonActionResponse[],
  failed: [] as Array<{ message: string; hints?: string[] }>,
}));

const createService = vi.hoisted(() => () => ({
  label: "Node",
  loadedText: "loaded",
  notLoadedText: "not loaded",
  isLoaded: vi.fn(async () => false),
  install: vi.fn(async () => {}),
  uninstall: vi.fn(async () => {}),
  readCommand: vi.fn<
    () => Promise<{
      programArguments?: string[];
      sourcePath?: string;
      workingDirectory?: string;
      environment?: Record<string, string | undefined>;
    } | null>
  >(async () => null),
  readRuntime: vi.fn<() => Promise<GatewayServiceRuntime>>(async () => ({ status: "stopped" })),
}));

vi.mock("../../commands/node-daemon-install-helpers.js", () => ({
  buildNodeInstallPlan: buildNodeInstallPlanMock,
}));

vi.mock("../../commands/node-daemon-runtime.js", () => ({
  DEFAULT_NODE_DAEMON_RUNTIME: "node",
  isNodeDaemonRuntime: isNodeDaemonRuntimeMock,
}));

vi.mock("../../node-host/config.js", () => ({
  loadNodeHostConfig: loadNodeHostConfigMock,
}));

vi.mock("../../daemon/node-service.js", () => ({
  resolveNodeService: resolveNodeServiceMock,
}));

vi.mock("../daemon-cli/response.js", () => ({
  buildDaemonServiceSnapshot: buildDaemonServiceSnapshotMock,
  installDaemonServiceAndEmit: installDaemonServiceAndEmitMock,
}));

vi.mock("../daemon-cli/lifecycle-core.js", () => ({
  runServiceStart: runServiceStartMock,
  runServiceStop: runServiceStopMock,
  runServiceRestart: runServiceRestartMock,
  runServiceUninstall: runServiceUninstallMock,
}));

vi.mock("../daemon-cli/shared.js", () => ({
  parsePort: parsePortMock,
  createCliStatusTextStyles: () => ({
    rich: false,
    label: (s: string) => s,
    accent: (s: string) => s,
    infoText: (s: string) => s,
    okText: (s: string) => s,
    warnText: (s: string) => s,
    errorText: (s: string) => s,
  }),
  createDaemonInstallActionContext: (jsonFlag: unknown) => {
    const json = Boolean(jsonFlag);
    return {
      json,
      stdout: process.stdout,
      warnings: actionState.warnings,
      emit: (payload: DaemonActionResponse) => {
        actionState.emitted.push(payload);
      },
      fail: (message: string, hints?: string[]) => {
        actionState.failed.push({ message, hints });
      },
    };
  },
  failIfNixDaemonInstallMode: (fail: (message: string, hints?: string[]) => void) => {
    if (!resolveIsNixModeMock()) {
      return false;
    }
    fail("Nix mode detected; service install is disabled.");
    return true;
  },
  formatRuntimeStatus: (runtime: unknown) =>
    runtime && typeof runtime === "object" && "status" in runtime
      ? String((runtime as { status: unknown }).status)
      : "",
  resolveRuntimeStatusColor: () => "default",
}));

vi.mock("../error-format.js", () => ({
  formatInvalidPortOption: (flag: string) => `Invalid ${flag} value`,
  formatInvalidConfigPort: (path: string) => `Invalid ${path} value`,
}));

const { defaultRuntime, runtimeLogs, runtimeErrors, resetRuntimeCapture } =
  createCliRuntimeCapture();
vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

const {
  runNodeDaemonInstall,
  runNodeDaemonStart,
  runNodeDaemonStop,
  runNodeDaemonRestart,
  runNodeDaemonUninstall,
  runNodeDaemonStatus,
} = await import("./daemon.js");

describe("runNodeDaemonInstall", () => {
  beforeEach(() => {
    actionState.warnings.length = 0;
    actionState.emitted.length = 0;
    actionState.failed.length = 0;
    resetRuntimeCapture();
    buildNodeInstallPlanMock.mockClear();
    installDaemonServiceAndEmitMock.mockClear();
    isNodeDaemonRuntimeMock.mockClear();
    isNodeDaemonRuntimeMock.mockImplementation((v: unknown) => v === "node" || v === "bun");
    parsePortMock.mockClear();
    resolveIsNixModeMock.mockReturnValue(false);
    loadNodeHostConfigMock.mockReset();
    loadNodeHostConfigMock.mockResolvedValue(null);
    resolveNodeServiceMock.mockImplementation(createService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fails when --port is explicitly invalid", async () => {
    parsePortMock.mockReturnValueOnce(null);

    await runNodeDaemonInstall({ port: "abc" });

    expect(actionState.failed[0]?.message).toBe("Invalid --port value");
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });

  it("fails when configured node.gateway.port is out of range", async () => {
    loadNodeHostConfigMock.mockResolvedValue({
      version: 1,
      nodeId: "node-1",
      gateway: { host: "127.0.0.1", port: 0 },
    });

    await runNodeDaemonInstall({});

    expect(actionState.failed[0]?.message).toBe("Invalid node.gateway.port value");
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid --runtime value", async () => {
    parsePortMock.mockReturnValueOnce(19000);

    await runNodeDaemonInstall({ port: "19000", runtime: "deno" });

    expect(actionState.failed[0]?.message).toContain('"node" or "bun"');
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });

  it("returns already-installed without reinstalling when service is loaded and force is not set", async () => {
    parsePortMock.mockReturnValueOnce(19000);
    const loadedService = createService();
    loadedService.isLoaded = vi.fn(async () => true);
    resolveNodeServiceMock.mockReturnValueOnce(loadedService);

    await runNodeDaemonInstall({ port: "19000", json: true });

    const result = actionState.emitted[0]?.result;
    expect(result).toBe("already-installed");
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
    expect(buildNodeInstallPlanMock).not.toHaveBeenCalled();
  });

  it("force-reinstalls when --force is set even if service is already loaded", async () => {
    parsePortMock.mockReturnValueOnce(19000);
    const loadedService = createService();
    loadedService.isLoaded = vi.fn(async () => true);
    resolveNodeServiceMock.mockReturnValueOnce(loadedService);

    await runNodeDaemonInstall({ port: "19000", force: true });

    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
    expect(buildNodeInstallPlanMock).toHaveBeenCalledTimes(1);
  });

  it("inherits TLS settings from saved gateway config when host is unchanged", async () => {
    parsePortMock.mockReturnValueOnce(null);
    loadNodeHostConfigMock.mockResolvedValue({
      version: 1,
      nodeId: "node-saved",
      gateway: { host: "10.0.0.5", port: 19002, tls: true, tlsFingerprint: "fp-saved" },
    });

    await runNodeDaemonInstall({});

    expect(buildNodeInstallPlanMock).toHaveBeenCalledTimes(1);
    const planArgs = buildNodeInstallPlanMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(planArgs.host).toBe("10.0.0.5");
    expect(planArgs.port).toBe(19002);
    expect(planArgs.tls).toBe(true);
    expect(planArgs.tlsFingerprint).toBe("fp-saved");
    expect(planArgs.runtime).toBe("node");
  });

  it("falls back to the default port 18789 when no override and no config is provided", async () => {
    parsePortMock.mockReturnValueOnce(null);

    await runNodeDaemonInstall({});

    const planArgs = buildNodeInstallPlanMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(planArgs.port).toBe(18789);
    expect(planArgs.host).toBe("127.0.0.1");
  });

  it("aborts install when running in nix daemon install mode", async () => {
    resolveIsNixModeMock.mockReturnValue(true);

    await runNodeDaemonInstall({ port: "19000" });

    expect(actionState.failed[0]?.message).toContain("Nix mode");
    expect(buildNodeInstallPlanMock).not.toHaveBeenCalled();
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });
});

describe("runNodeDaemonStart / Stop / Restart / Uninstall", () => {
  beforeEach(() => {
    runServiceStartMock.mockClear();
    runServiceStopMock.mockClear();
    runServiceRestartMock.mockClear();
    runServiceUninstallMock.mockClear();
    resolveNodeServiceMock.mockImplementation(createService);
  });

  it("delegates start to runServiceStart with the Node service noun and start hints", async () => {
    await runNodeDaemonStart({ json: true });
    expect(runServiceStartMock).toHaveBeenCalledTimes(1);
    const args = runServiceStartMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.serviceNoun).toBe("Node");
    expect(typeof args.renderStartHints).toBe("function");
    expect((args.opts as { json?: boolean }).json).toBe(true);
  });

  it("delegates stop to runServiceStop", async () => {
    await runNodeDaemonStop({ json: false });
    const args = runServiceStopMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.serviceNoun).toBe("Node");
  });

  it("delegates restart to runServiceRestart with start hints", async () => {
    await runNodeDaemonRestart({});
    const args = runServiceRestartMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.serviceNoun).toBe("Node");
    expect(typeof args.renderStartHints).toBe("function");
  });

  it("delegates uninstall without stopBeforeUninstall and without post-assert", async () => {
    await runNodeDaemonUninstall({});
    const args = runServiceUninstallMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.serviceNoun).toBe("Node");
    expect(args.stopBeforeUninstall).toBe(false);
    expect(args.assertNotLoadedAfterUninstall).toBe(false);
  });
});

describe("runNodeDaemonStatus", () => {
  beforeEach(() => {
    resetRuntimeCapture();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    buildDaemonServiceSnapshotMock.mockClear();
    buildDaemonServiceSnapshotMock.mockReturnValue({ label: "Node", loaded: false });
    resolveNodeServiceMock.mockReset();
    resolveNodeServiceMock.mockImplementation(createService);
  });

  it("emits a JSON payload combining service snapshot, command, and runtime", async () => {
    const svc = createService();
    svc.isLoaded = vi.fn(async () => true);
    svc.readCommand = vi.fn(async () => ({
      programArguments: ["openclaw", "node", "run"],
      sourcePath: "/etc/svc",
    }));
    svc.readRuntime = vi.fn(async (): Promise<GatewayServiceRuntime> => ({ status: "running" }));
    resolveNodeServiceMock.mockReturnValueOnce(svc);
    buildDaemonServiceSnapshotMock.mockReturnValueOnce({ label: "Node", loaded: true });

    await runNodeDaemonStatus({ json: true });

    expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
    const payload = defaultRuntime.writeJson.mock.calls[0]?.[0] as {
      service?: Record<string, unknown>;
    };
    expect(payload.service?.command).toEqual({
      programArguments: ["openclaw", "node", "run"],
      sourcePath: "/etc/svc",
    });
    expect(payload.service?.runtime).toEqual({ status: "running" });
    expect(payload.service?.loaded).toBe(true);
  });

  it("prints start hints when the service is not loaded in human mode", async () => {
    const svc = createService();
    svc.isLoaded = vi.fn(async () => false);
    resolveNodeServiceMock.mockReturnValueOnce(svc);

    await runNodeDaemonStatus({ json: false });

    const allOutput = runtimeLogs.join("\n");
    expect(allOutput).toContain("openclaw node start");
  });

  it("falls back to a stable runtime status when the service throws on readRuntime", async () => {
    const svc = createService();
    svc.isLoaded = vi.fn(async () => true);
    svc.readCommand = vi.fn(async () => null);
    svc.readRuntime = vi.fn(async (): Promise<GatewayServiceRuntime> => {
      throw new Error("permission denied");
    });
    resolveNodeServiceMock.mockReturnValueOnce(svc);
    buildDaemonServiceSnapshotMock.mockReturnValueOnce({ label: "Node", loaded: true });

    await runNodeDaemonStatus({ json: true });

    const payload = defaultRuntime.writeJson.mock.calls[0]?.[0] as {
      service?: { runtime?: Record<string, unknown> };
    };
    expect(payload.service?.runtime?.status).toBe("unknown");
    expect(String(payload.service?.runtime?.detail ?? "")).toContain("permission denied");
  });

  it("emits a service-unit-not-found error path when runtime missingUnit is true", async () => {
    const svc = createService();
    svc.isLoaded = vi.fn(async () => true);
    svc.readCommand = vi.fn(async () => null);
    svc.readRuntime = vi.fn(
      async (): Promise<GatewayServiceRuntime> => ({ status: "running", missingUnit: true }),
    );
    resolveNodeServiceMock.mockReturnValueOnce(svc);
    buildDaemonServiceSnapshotMock.mockReturnValueOnce({ label: "Node", loaded: true });

    await runNodeDaemonStatus({ json: false });

    expect(runtimeErrors.some((line) => line.includes("Service unit not found"))).toBe(true);
  });

  it("emits a stopped-runtime error path when runtime status is stopped", async () => {
    const svc = createService();
    svc.isLoaded = vi.fn(async () => true);
    svc.readCommand = vi.fn(async () => null);
    svc.readRuntime = vi.fn(async (): Promise<GatewayServiceRuntime> => ({ status: "stopped" }));
    resolveNodeServiceMock.mockReturnValueOnce(svc);
    buildDaemonServiceSnapshotMock.mockReturnValueOnce({ label: "Node", loaded: true });

    await runNodeDaemonStatus({ json: false });

    expect(runtimeErrors.some((line) => line.includes("not running"))).toBe(true);
  });
});
