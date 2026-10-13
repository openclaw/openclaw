// Gateway readiness tests cover readiness checks, status details, and failure messages.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatus } from "../cli/daemon-cli/status.gather.js";
import { ensureDashboardGatewayReady } from "./gateway-readiness.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const { gatherStatus, confirm, installGateway, startGateway } = vi.hoisted(() => ({
  gatherStatus: vi.fn(),
  confirm: vi.fn(),
  installGateway: vi.fn(),
  startGateway: vi.fn(),
}));
vi.mock("../cli/daemon-cli/status.gather.js", () => ({ gatherDaemonStatus: gatherStatus }));
vi.mock("../cli/prompt.js", () => ({ promptYesNo: confirm }));
vi.mock("../cli/daemon-cli/install.runtime.js", () => ({ runDaemonInstall: installGateway }));
vi.mock("../cli/daemon-cli/lifecycle.js", () => ({ runDaemonStart: startGateway }));

type StatusOverrides = Omit<Partial<DaemonStatus>, "service"> & {
  service?: Omit<DaemonStatus["service"], "loaded">;
};

function createStatus(overrides: StatusOverrides = {}): DaemonStatus {
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
      port: 18789,
      portSource: "env/config",
      probeUrl: "ws://127.0.0.1:18789",
    },
    port: {
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    },
    rpc: {
      ok: false,
      error: "connect ECONNREFUSED 127.0.0.1:18789",
    },
    extraServices: [],
    ...rest,
  };
}

const runtime = createTestRuntime();

describe("ensureDashboardGatewayReady", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it.each(["timeout"])(
    "does not start over a busy listener after an inconclusive %s probe",
    async (error) => {
      const status = createStatus({
        port: { port: 18789, status: "busy", listeners: [], hints: [] },
        rpc: { ok: false, error },
      });
      confirm.mockResolvedValue(false);
      gatherStatus.mockResolvedValue(status);

      const result = await ensureDashboardGatewayReady({
        runtime,
        interactive: true,
      });

      expect(result).toMatchObject({ ready: false, recoverable: false });
      expect(confirm).not.toHaveBeenCalled();
      expect(installGateway).not.toHaveBeenCalled();
      expect(startGateway).not.toHaveBeenCalled();
      const output = runtime.log.mock.calls.flat().join("\n");
      expect(output).toContain("Gateway check failed:");
      expect(output).not.toContain("Gateway is not running");
      expect(output).not.toContain("gateway start");
    },
  );

  it("prints diagnosis and skips recovery when an interactive user declines", async () => {
    gatherStatus.mockResolvedValue(createStatus());
    confirm.mockResolvedValue(false);

    const result = await ensureDashboardGatewayReady({
      runtime,
      interactive: true,
    });

    expect(result.ready).toBe(false);
    expect(confirm).toHaveBeenCalledWith(
      "No background Gateway service was detected for this profile. Install and start one to open the dashboard?",
      true,
    );
    expect(runtime.log.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
      "Gateway is not running.",
    );
  });

  it("installs a missing service and waits for the gateway before returning ready", async () => {
    const stopped = createStatus();
    const running = createStatus({
      service: {
        label: "systemd user",
        loadState: { status: "loaded" },
        loadedText: "enabled",
        notLoadedText: "disabled",
        command: { programArguments: ["openclaw", "gateway", "run"] },
        runtime: { status: "running" },
      },
      port: { port: 18789, status: "busy", listeners: [], hints: [] },
      rpc: { ok: true },
    });
    gatherStatus.mockResolvedValueOnce(stopped).mockResolvedValueOnce(running);
    installGateway.mockResolvedValue(undefined);
    startGateway.mockResolvedValue(undefined);

    const result = await ensureDashboardGatewayReady({
      runtime,
      yes: true,
    });

    expect(result).toMatchObject({ ready: true, recovered: true });
    expect(installGateway).toHaveBeenCalledTimes(1);
    expect(startGateway).not.toHaveBeenCalled();
  });

  it("starts an installed stopped service instead of reinstalling it", async () => {
    const stopped = createStatus({
      service: {
        label: "systemd user",
        loadState: { status: "not-loaded" },
        loadedText: "enabled",
        notLoadedText: "disabled",
        command: { programArguments: ["openclaw", "gateway", "run"] },
        runtime: { status: "stopped" },
      },
    });
    const running = createStatus({
      service: {
        label: "systemd user",
        loadState: { status: "loaded" },
        loadedText: "enabled",
        notLoadedText: "disabled",
        command: { programArguments: ["openclaw", "gateway", "run"] },
        runtime: { status: "running" },
      },
      port: { port: 18789, status: "busy", listeners: [], hints: [] },
      rpc: { ok: true },
    });
    gatherStatus.mockResolvedValueOnce(stopped).mockResolvedValueOnce(running);
    installGateway.mockResolvedValue(undefined);
    startGateway.mockResolvedValue(undefined);

    const result = await ensureDashboardGatewayReady({
      runtime,
      yes: true,
    });

    expect(result).toMatchObject({ ready: true, recovered: true });
    expect(startGateway).toHaveBeenCalledTimes(1);
    expect(installGateway).not.toHaveBeenCalled();
  });

  it("does not recover a diagnostic-only native service for an active external target", async () => {
    const status = createStatus({
      service: {
        label: "systemd user",
        loadState: { status: "loaded" },
        loadedText: "enabled",
        notLoadedText: "disabled",
        targetRole: "diagnostic-only",
        command: { programArguments: ["openclaw", "gateway", "run", "--port", "18789"] },
        runtime: { status: "running" },
      },
      gateway: {
        bindMode: "loopback",
        bindHost: "127.0.0.1",
        port: 18900,
        portSource: "env/config",
        probeUrl: "ws://127.0.0.1:18900",
      },
      port: { port: 18900, status: "free", listeners: [], hints: [] },
      rpc: {
        ok: false,
        error: "connect ECONNREFUSED 127.0.0.1:18900",
        url: "ws://127.0.0.1:18900",
      },
    });
    confirm.mockResolvedValue(false);

    gatherStatus.mockResolvedValue(status);

    const result = await ensureDashboardGatewayReady({
      runtime,
      interactive: true,
    });

    expect(result).toMatchObject({ ready: false, recoverable: false });
    expect(confirm).not.toHaveBeenCalled();
    expect(installGateway).not.toHaveBeenCalled();
    expect(startGateway).not.toHaveBeenCalled();
    expect(runtime.log.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
      "owning environment or supervisor to start or repair",
    );
  });

  it("can accept a reachable dashboard listener when authenticated RPC fails", async () => {
    const status = createStatus({
      service: {
        label: "systemd user",
        loadState: { status: "loaded" },
        loadedText: "enabled",
        notLoadedText: "disabled",
        command: { programArguments: ["openclaw", "gateway", "run", "--port", "18789"] },
        runtime: { status: "running" },
      },
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

    const result = await ensureDashboardGatewayReady({
      runtime,
      interactive: true,
    });

    expect(result).toMatchObject({ ready: true, recovered: false });
    expect(confirm).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });
});
