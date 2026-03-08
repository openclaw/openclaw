import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayService } from "../../daemon/service.js";
import type { PortListenerKind, PortUsage } from "../../infra/ports.js";

const inspectPortUsage = vi.hoisted(() => vi.fn<(port: number) => Promise<PortUsage>>());
const classifyPortListener = vi.hoisted(() =>
  vi.fn<(_listener: unknown, _port: number) => PortListenerKind>(() => "gateway"),
);
const probeGateway = vi.hoisted(() => vi.fn());

vi.mock("../../infra/ports.js", () => ({
  classifyPortListener: (listener: unknown, port: number) => classifyPortListener(listener, port),
  formatPortDiagnostics: vi.fn(() => []),
  inspectPortUsage: (port: number) => inspectPortUsage(port),
}));

vi.mock("../../gateway/probe.js", () => ({
  probeGateway: (opts: unknown) => probeGateway(opts),
}));

const originalPlatform = process.platform;

async function inspectUnknownListenerFallback(params: {
  runtime: { status: "running"; pid: number } | { status: "stopped" };
  includeUnknownListenersAsStale: boolean;
}) {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  classifyPortListener.mockReturnValue("unknown");

  const service = {
    readRuntime: vi.fn(async () => params.runtime),
  } as unknown as GatewayService;

  inspectPortUsage.mockResolvedValue({
    port: 18789,
    status: "busy",
    listeners: [{ pid: 10920, command: "unknown" }],
    hints: [],
  });

  const { inspectGatewayRestart } = await import("./restart-health.js");
  return inspectGatewayRestart({
    service,
    port: 18789,
    includeUnknownListenersAsStale: params.includeUnknownListenersAsStale,
  });
}

describe("inspectGatewayRestart", () => {
  beforeEach(() => {
    inspectPortUsage.mockReset();
    inspectPortUsage.mockResolvedValue({
      port: 0,
      status: "free",
      listeners: [],
      hints: [],
    });
    classifyPortListener.mockReset();
    classifyPortListener.mockReturnValue("gateway");
    probeGateway.mockReset();
    probeGateway.mockResolvedValue({
      ok: false,
      close: null,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("treats a gateway listener child pid as healthy ownership", async () => {
    const service = {
      readRuntime: vi.fn(async () => ({ status: "running", pid: 7000 })),
    } as unknown as GatewayService;

    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 7001, ppid: 7000, commandLine: "openclaw-gateway" }],
      hints: [],
    });

    const { inspectGatewayRestart } = await import("./restart-health.js");
    const snapshot = await inspectGatewayRestart({ service, port: 18789 });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.staleGatewayPids).toEqual([]);
  });

  it("marks non-owned gateway listener pids as stale while runtime is running", async () => {
    const service = {
      readRuntime: vi.fn(async () => ({ status: "running", pid: 8000 })),
    } as unknown as GatewayService;

    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 9000, ppid: 8999, commandLine: "openclaw-gateway" }],
      hints: [],
    });

    const { inspectGatewayRestart } = await import("./restart-health.js");
    const snapshot = await inspectGatewayRestart({ service, port: 18789 });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.staleGatewayPids).toEqual([9000]);
  });

  it("treats unknown listeners as stale on Windows when enabled", async () => {
    const snapshot = await inspectUnknownListenerFallback({
      runtime: { status: "stopped" },
      includeUnknownListenersAsStale: true,
    });

    expect(snapshot.staleGatewayPids).toEqual([10920]);
  });

  it("does not treat unknown listeners as stale when fallback is disabled", async () => {
    const snapshot = await inspectUnknownListenerFallback({
      runtime: { status: "stopped" },
      includeUnknownListenersAsStale: false,
    });

    expect(snapshot.staleGatewayPids).toEqual([]);
  });

  it("does not apply unknown-listener fallback while runtime is running", async () => {
    const snapshot = await inspectUnknownListenerFallback({
      runtime: { status: "running", pid: 10920 },
      includeUnknownListenersAsStale: true,
    });

    expect(snapshot.staleGatewayPids).toEqual([]);
  });

  it("does not treat known non-gateway listeners as stale in fallback mode", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    classifyPortListener.mockReturnValue("ssh");

    const service = {
      readRuntime: vi.fn(async () => ({ status: "stopped" })),
    } as unknown as GatewayService;

    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 22001, command: "nginx.exe" }],
      hints: [],
    });

    const { inspectGatewayRestart } = await import("./restart-health.js");
    const snapshot = await inspectGatewayRestart({
      service,
      port: 18789,
      includeUnknownListenersAsStale: true,
    });

    expect(snapshot.staleGatewayPids).toEqual([]);
  });

  it("uses a local gateway probe when ownership is ambiguous", async () => {
    const service = {
      readRuntime: vi.fn(async () => ({ status: "running", pid: 8000 })),
    } as unknown as GatewayService;

    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ commandLine: "" }],
      hints: [],
    });
    classifyPortListener.mockReturnValue("unknown");
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
    });

    const { inspectGatewayRestart } = await import("./restart-health.js");
    const snapshot = await inspectGatewayRestart({ service, port: 18789 });

    expect(snapshot.healthy).toBe(true);
    expect(probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://127.0.0.1:18789" }),
    );
  });

  it("treats auth-closed probe as healthy gateway reachability", async () => {
    const service = {
      readRuntime: vi.fn(async () => ({ status: "running", pid: 8000 })),
    } as unknown as GatewayService;

    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ commandLine: "" }],
      hints: [],
    });
    classifyPortListener.mockReturnValue("unknown");
    probeGateway.mockResolvedValue({
      ok: false,
      close: { code: 1008, reason: "auth required" },
    });

    const { inspectGatewayRestart } = await import("./restart-health.js");
    const snapshot = await inspectGatewayRestart({ service, port: 18789 });

    expect(snapshot.healthy).toBe(true);
  });

  it("passes env with the expected wrapper to service.isLoaded", async () => {
    const env = { OPENCLAW_PROFILE: "ziggy" } as NodeJS.ProcessEnv;
    const service = {
      isLoaded: vi.fn(async () => true),
      readRuntime: vi.fn(async () => ({ status: "running", pid: 4242 })),
    } as unknown as GatewayService;

    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 4242, ppid: 1, commandLine: "openclaw-gateway" }],
      hints: [],
    });

    const { inspectGatewayRestart } = await import("./restart-health.js");
    await inspectGatewayRestart({ service, port: 18789, env });

    expect((service as { isLoaded: ReturnType<typeof vi.fn> }).isLoaded).toHaveBeenCalledWith({
      env,
    });
  });
});

describe("waitForGatewayHealthyRestart", () => {
  beforeEach(() => {
    inspectPortUsage.mockReset();
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 4242, ppid: 1, commandLine: "openclaw-gateway" }],
      hints: [],
    });
    classifyPortListener.mockReset();
    classifyPortListener.mockReturnValue("gateway");
    probeGateway.mockReset();
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("does not stop on a single transient unloaded snapshot", async () => {
    const service = {
      isLoaded: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      readRuntime: vi.fn(async () => ({ status: "running", state: "running", pid: 4242 })),
    } as unknown as GatewayService;

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      attempts: 2,
      delayMs: 0,
    });

    expect((service as { isLoaded: ReturnType<typeof vi.fn> }).isLoaded).toHaveBeenCalledTimes(2);
    expect(snapshot.serviceLoaded).toBe(true);
    expect(snapshot.healthy).toBe(true);
  });
});
