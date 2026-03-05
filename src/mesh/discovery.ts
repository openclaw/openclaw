import { EventEmitter } from "node:events";
import type { GatewayBonjourBeacon } from "../infra/bonjour-discovery.js";

export type MeshDiscoveredPeer = {
  deviceId: string;
  displayName?: string;
  host?: string;
  port?: number;
  gatewayPort?: number;
  lanHost?: string;
  gatewayTls?: boolean;
  gatewayTlsFingerprintSha256?: string;
  discoveredAtMs: number;
};

export type MeshDiscoveryEvents = {
  "peer-discovered": [peer: MeshDiscoveredPeer];
  "peer-lost": [deviceId: string];
};

export class MeshDiscovery extends EventEmitter<MeshDiscoveryEvents> {
  private localDeviceId: string;
  private scanIntervalMs: number;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private knownPeers = new Map<string, MeshDiscoveredPeer>();
  private discoverFn: () => Promise<GatewayBonjourBeacon[]>;

  constructor(opts: {
    localDeviceId: string;
    scanIntervalMs?: number;
    discoverFn: () => Promise<GatewayBonjourBeacon[]>;
  }) {
    super();
    this.localDeviceId = opts.localDeviceId;
    this.scanIntervalMs = opts.scanIntervalMs ?? 30_000;
    this.discoverFn = opts.discoverFn;
  }

  start() {
    if (this.scanTimer) {
      return;
    }
    // Run initial scan immediately.
    void this.scan();
    this.scanTimer = setInterval(() => void this.scan(), this.scanIntervalMs);
    this.scanTimer.unref?.();
  }

  stop() {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  listPeers(): MeshDiscoveredPeer[] {
    return [...this.knownPeers.values()];
  }

  private async scan(): Promise<void> {
    let beacons: GatewayBonjourBeacon[];
    try {
      beacons = await this.discoverFn();
    } catch {
      return;
    }

    const seenDeviceIds = new Set<string>();

    for (const beacon of beacons) {
      const deviceId = beacon.deviceId ?? beacon.txt?.deviceId;
      if (!deviceId || deviceId === this.localDeviceId) {
        continue;
      }
      seenDeviceIds.add(deviceId);

      const existing = this.knownPeers.get(deviceId);
      if (!existing) {
        const peer: MeshDiscoveredPeer = {
          deviceId,
          displayName: beacon.displayName,
          host: beacon.host ?? beacon.lanHost,
          port: beacon.port,
          gatewayPort: beacon.gatewayPort,
          lanHost: beacon.lanHost,
          gatewayTls: beacon.gatewayTls,
          gatewayTlsFingerprintSha256: beacon.gatewayTlsFingerprintSha256,
          discoveredAtMs: Date.now(),
        };
        this.knownPeers.set(deviceId, peer);
        this.emit("peer-discovered", peer);
      }
    }

    // Detect lost peers.
    for (const [deviceId] of this.knownPeers) {
      if (!seenDeviceIds.has(deviceId)) {
        this.knownPeers.delete(deviceId);
        this.emit("peer-lost", deviceId);
      }
    }
  }
}
