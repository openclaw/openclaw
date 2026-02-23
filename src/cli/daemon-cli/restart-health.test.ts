import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayService } from "../../daemon/service.js";
import type { PortListenerKind, PortUsage } from "../../infra/ports.js";

const inspectPortUsage = vi.hoisted(() => vi.fn<(port: number) => Promise<PortUsage>>());
const classifyPortListener = vi.hoisted(() =>
  vi.fn<(_listener: unknown, _port: number) => PortListenerKind>(() => "gateway"),
);

vi.mock("../../infra/ports.js", () => ({
  classifyPortListener: (listener: unknown, port: number) => classifyPortListener(listener, port),
  formatPortDiagnostics: vi.fn(() => []),
  inspectPortUsage: (port: number) => inspectPortUsage(port),
}));

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
});
