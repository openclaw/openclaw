import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { GatewayBonjourBeacon } from "../infra/bonjour-discovery.js";
import { MeshDiscovery } from "./discovery.js";

function createBeacon(overrides: Partial<GatewayBonjourBeacon> = {}): GatewayBonjourBeacon {
  return {
    deviceId: "peer-a",
    displayName: "Test Peer",
    host: "192.168.1.10",
    port: 3000,
    gatewayPort: 3001,
    lanHost: "192.168.1.10",
    ...overrides,
  } as GatewayBonjourBeacon;
}

describe("MeshDiscovery", () => {
  let discoverFn: ReturnType<typeof vi.fn<() => Promise<GatewayBonjourBeacon[]>>>;
  let discovery: MeshDiscovery;

  beforeEach(() => {
    vi.useFakeTimers();
    discoverFn = vi.fn<() => Promise<GatewayBonjourBeacon[]>>(async () => []);
    discovery = new MeshDiscovery({
      localDeviceId: "local-device",
      scanIntervalMs: 5000,
      discoverFn,
    });
  });

  afterEach(() => {
    discovery.stop();
    vi.useRealTimers();
  });

  it("emits peer-discovered when new peer appears in scan", async () => {
    const peerDiscovered = vi.fn();
    discovery.on("peer-discovered", peerDiscovered);

    discoverFn.mockResolvedValue([createBeacon({ deviceId: "peer-a" })]);
    discovery.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(peerDiscovered).toHaveBeenCalledOnce();
    expect(peerDiscovered.mock.calls[0][0].deviceId).toBe("peer-a");
  });

  it("emits peer-lost when peer disappears", async () => {
    const peerLost = vi.fn();
    discovery.on("peer-lost", peerLost);

    // First scan: peer present
    discoverFn.mockResolvedValue([createBeacon({ deviceId: "peer-a" })]);
    discovery.start();
    await vi.advanceTimersByTimeAsync(0);

    // Second scan: peer gone
    discoverFn.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(5000);

    expect(peerLost).toHaveBeenCalledOnce();
    expect(peerLost.mock.calls[0][0]).toBe("peer-a");
  });

  it("does not emit duplicate peer-discovered for same peer", async () => {
    const peerDiscovered = vi.fn();
    discovery.on("peer-discovered", peerDiscovered);

    discoverFn.mockResolvedValue([createBeacon({ deviceId: "peer-a" })]);
    discovery.start();
    await vi.advanceTimersByTimeAsync(0);

    // Second scan: same peer
    await vi.advanceTimersByTimeAsync(5000);

    expect(peerDiscovered).toHaveBeenCalledOnce();
  });

  it("filters out self (local deviceId)", async () => {
    const peerDiscovered = vi.fn();
    discovery.on("peer-discovered", peerDiscovered);

    discoverFn.mockResolvedValue([createBeacon({ deviceId: "local-device" })]);
    discovery.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(peerDiscovered).not.toHaveBeenCalled();
  });

  it("listPeers() returns known discovered peers", async () => {
    discoverFn.mockResolvedValue([
      createBeacon({ deviceId: "peer-a" }),
      createBeacon({ deviceId: "peer-b", host: "192.168.1.11" }),
    ]);
    discovery.start();
    await vi.advanceTimersByTimeAsync(0);

    const peers = discovery.listPeers();
    expect(peers).toHaveLength(2);
    expect(peers.map((p) => p.deviceId).toSorted()).toEqual(["peer-a", "peer-b"]);
  });

  it("handles discoverFn errors gracefully", async () => {
    const peerDiscovered = vi.fn();
    discovery.on("peer-discovered", peerDiscovered);

    discoverFn.mockRejectedValue(new Error("network error"));
    discovery.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(peerDiscovered).not.toHaveBeenCalled();
  });

  it("stop() halts scanning", async () => {
    discoverFn.mockResolvedValue([]);
    discovery.start();
    await vi.advanceTimersByTimeAsync(0);

    discovery.stop();
    discoverFn.mockClear();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(discoverFn).not.toHaveBeenCalled();
  });
});
