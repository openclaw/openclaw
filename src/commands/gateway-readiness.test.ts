import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatus } from "../cli/daemon-cli/status.gather.js";
import { createCliTtyMock } from "../cli/test-runtime-capture.js";
import { expectNoCalls } from "../test-utils/mock-call-assertions.js";
import { dashboardCommand } from "./dashboard.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const { gatherStatus, confirm, installGateway, startGateway } = vi.hoisted(() => ({
  gatherStatus: vi.fn(),
  confirm: vi.fn(),
  installGateway: vi.fn(),
  startGateway: vi.fn(),
}));
vi.mock("../cli/daemon-cli/status.gather.js", () => ({ gatherDaemonStatus: gatherStatus }));
vi.mock("../cli/prompt.js", () => ({ promptYesNo: confirm }));
vi.mock("../cli/daemon-cli/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/daemon-cli/install.js")>()),
  runDaemonInstall: installGateway,
}));
vi.mock("../cli/daemon-cli/lifecycle.js", () => ({ runDaemonStart: startGateway }));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: async () => ({ ...baseConfigSnapshot, sourceConfig: {} }),
}));
vi.mock("./control-ui-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./control-ui-handoff.js")>()),
  resolveControlUiHandoffTarget: async () => ({
    port: 18789,
    bind: "loopback",
    links: { httpUrl: "http://127.0.0.1:18789/", wsUrl: "ws://127.0.0.1:18789" },
    authMode: "token",
    includeTokenInUrl: false,
    dashboardUrl: "http://127.0.0.1:18789/",
    documentUrl: "http://127.0.0.1:18789/",
    probeUrl: "ws://127.0.0.1:18789",
  }),
  waitForControlUiDocument: async () => ({ ready: true }),
  issueControlUiBrowserHandoff: async () => ({ browserUrl: "http://127.0.0.1:18789/" }),
}));
vi.mock("../infra/clipboard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clipboard.js")>()),
  copyToClipboard: async () => true,
}));

type StatusOverrides = Omit<Partial<DaemonStatus>, "service"> & {
  service?: Omit<DaemonStatus["service"], "loaded">;
};

function createStatus(overrides: StatusOverrides = {}, port = 18789): DaemonStatus {
  const { service, ...rest } = overrides;
  const serviceStatus = service ?? {
    label: "systemd user",
    loadState: { status: "not-loaded" as const },
    loadedText: "enabled",
    notLoadedText: "disabled",
    command: null,
    runtime: { status: "stopped" },
  };
  return {
    service: {
      ...serviceStatus,
      loaded:
        serviceStatus.loadState.status === "unknown"
          ? null
          : serviceStatus.loadState.status === "loaded",
    },
    gateway: {
      bindMode: "loopback",
      bindHost: "127.0.0.1",
      port,
      portSource: "env/config",
      probeUrl: `ws://127.0.0.1:${port}`,
    },
    port: {
      port,
      status: "free",
      listeners: [],
      hints: [],
    },
    rpc: {
      ok: false,
      error: `connect ECONNREFUSED 127.0.0.1:${port}`,
    },
    extraServices: [],
    ...rest,
  };
}

const runtime = createTestRuntime();
const tty = createCliTtyMock();
afterEach(() => tty.restore());
const output = () => runtime.log.mock.calls.flat().join("\n");
const check = (options: { yes?: boolean } = {}) =>
  dashboardCommand(runtime, { noOpen: true, ...options });
const installedService = (
  overrides: Partial<NonNullable<StatusOverrides["service"]>> = {},
): NonNullable<StatusOverrides["service"]> => ({
  label: "systemd user",
  loadState: { status: "loaded" },
  loadedText: "enabled",
  notLoadedText: "disabled",
  command: { programArguments: ["openclaw", "gateway", "run"] },
  runtime: { status: "running" },
  ...overrides,
});
const runningStatus = () =>
  createStatus({
    service: installedService(),
    port: { port: 18789, status: "busy", listeners: [], hints: [] },
    rpc: { ok: true },
  });

describe("dashboard Gateway readiness", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("does not start over a busy listener after an inconclusive timeout probe", async () => {
    const status = createStatus({
      port: { port: 18789, status: "busy", listeners: [], hints: [] },
      rpc: { ok: false, error: "timeout" },
    });
    gatherStatus.mockResolvedValue(status);

    await check();

    expect(output()).not.toContain("Dashboard URL:");
    expectNoCalls(confirm, installGateway, startGateway);
    expect(output()).toContain("Gateway check failed:");
    expect(output()).not.toContain("Gateway is not running");
    expect(output()).not.toContain("gateway start");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("prints diagnosis and skips recovery when an interactive user declines", async () => {
    tty.set(true);
    gatherStatus.mockResolvedValue(createStatus());
    confirm.mockResolvedValue(false);

    await check();

    expect(output()).not.toContain("Dashboard URL:");
    expect(confirm).toHaveBeenCalledWith(
      "No background Gateway service was detected for this profile. Install and start one to open the dashboard?",
      true,
    );
    expect(output()).toContain("Gateway is not running.");
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it.each([false, true])("recovers a stopped gateway (installed=%s)", async (installed) => {
    const stopped = installed
      ? createStatus({
          service: installedService({
            loadState: { status: "not-loaded" },
            runtime: { status: "stopped" },
          }),
        })
      : createStatus();
    gatherStatus.mockResolvedValueOnce(stopped).mockResolvedValueOnce(runningStatus());

    await check({ yes: true });

    expect(output()).toContain("Dashboard URL: http://127.0.0.1:18789/");
    expect(installGateway).toHaveBeenCalledTimes(installed ? 0 : 1);
    expect(startGateway).toHaveBeenCalledTimes(installed ? 1 : 0);
  });

  it("does not recover a diagnostic-only native service for an active external target", async () => {
    const status = createStatus(
      {
        service: installedService({
          targetRole: "diagnostic-only",
          command: { programArguments: ["openclaw", "gateway", "run", "--port", "18789"] },
        }),
        rpc: {
          ok: false,
          error: "connect ECONNREFUSED 127.0.0.1:18900",
          url: "ws://127.0.0.1:18900",
        },
      },
      18900,
    );

    gatherStatus.mockResolvedValue(status);

    await check();

    expect(output()).not.toContain("Dashboard URL:");
    expectNoCalls(confirm, installGateway, startGateway);
    expect(output()).toContain("owning environment or supervisor to start or repair");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("can accept a reachable dashboard listener when authenticated RPC fails", async () => {
    const status = createStatus({
      service: installedService({
        command: { programArguments: ["openclaw", "gateway", "run", "--port", "18789"] },
      }),
      port: { port: 18789, status: "free", listeners: [], hints: [] },
      portCli: { port: 49876, status: "busy", listeners: [], hints: [] },
      rpc: {
        ok: false,
        error: "gateway closed (1008): auth failed",
        gatewayReached: true,
        url: "ws://127.0.0.1:49876",
      },
    });

    gatherStatus.mockResolvedValue(status);

    await check();

    expect(output()).toContain("Dashboard URL: http://127.0.0.1:18789/");
    expect(confirm).not.toHaveBeenCalled();
    expect(installGateway).not.toHaveBeenCalled();
    expect(startGateway).not.toHaveBeenCalled();
    expect(output()).not.toContain("Gateway check failed:");
  });
});
