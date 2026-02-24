import type { MeshConfig } from "../config/types.mesh.js";
import type { GatewayRequestHandlers } from "../gateway/server-methods/types.js";
import type { GatewayBonjourBeacon } from "../infra/bonjour-discovery.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { MeshCapabilityRegistry } from "./capabilities.js";
import { MeshDiscovery, type MeshDiscoveredPeer } from "./discovery.js";
import { MeshPeerClient } from "./peer-client.js";
import { PeerRegistry } from "./peer-registry.js";
import { createMeshServerHandlers } from "./peer-server.js";
import { isTrustedPeer } from "./peer-trust.js";
import type { PeerSession } from "./types.js";

export type MeshManagerOptions = {
  identity: DeviceIdentity;
  config: MeshConfig;
  displayName?: string;
  discoverFn: () => Promise<GatewayBonjourBeacon[]>;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
};

export class MeshManager {
  readonly peerRegistry: PeerRegistry;
  readonly capabilityRegistry: MeshCapabilityRegistry;
  private discovery: MeshDiscovery;
  private outboundClients = new Map<string, MeshPeerClient>();
  private identity: DeviceIdentity;
  private config: MeshConfig;
  private displayName?: string;
  private log: MeshManagerOptions["log"];
  private handlers: GatewayRequestHandlers;

  constructor(opts: MeshManagerOptions) {
    this.identity = opts.identity;
    this.config = opts.config;
    this.displayName = opts.displayName;
    this.log = opts.log;
    this.peerRegistry = new PeerRegistry();
    this.capabilityRegistry = new MeshCapabilityRegistry();
    this.discovery = new MeshDiscovery({
      localDeviceId: opts.identity.deviceId,
      scanIntervalMs: opts.config.scanIntervalMs,
      discoverFn: opts.discoverFn,
    });

    // Create server-side handlers for inbound mesh connections.
    this.handlers = createMeshServerHandlers({
      identity: this.identity,
      peerRegistry: this.peerRegistry,
      displayName: this.displayName,
      capabilities: this.config.capabilities,
      onPeerConnected: (session) => this.onPeerConnected(session),
    });
  }

  /**
   * Start discovery and connect to static peers.
   */
  start() {
    // Listen for discovered peers.
    this.discovery.on("peer-discovered", (peer) => {
      void this.onPeerDiscovered(peer);
    });
    this.discovery.on("peer-lost", (deviceId) => {
      this.log.info(`mesh: peer lost via mDNS: ${deviceId.slice(0, 12)}…`);
    });

    this.discovery.start();
    this.log.info(
      `mesh: started (deviceId=${this.identity.deviceId.slice(0, 12)}…, scanInterval=${this.config.scanIntervalMs ?? 30000}ms)`,
    );

    // Connect to statically configured peers.
    for (const staticPeer of this.config.peers ?? []) {
      this.connectToPeer({
        deviceId: staticPeer.deviceId,
        url: staticPeer.url,
        tlsFingerprint: staticPeer.tlsFingerprint,
      });
    }
  }

  stop() {
    this.discovery.stop();
    for (const client of this.outboundClients.values()) {
      client.stop();
    }
    this.outboundClients.clear();
  }

  /**
   * Get the gateway request handlers for mesh methods.
   */
  getHandlers(): GatewayRequestHandlers {
    return this.handlers;
  }

  private async onPeerDiscovered(peer: MeshDiscoveredPeer) {
    const trusted = await isTrustedPeer(peer.deviceId);
    if (!trusted) {
      this.log.info(
        `mesh: discovered untrusted peer ${peer.deviceId.slice(0, 12)}… (${peer.displayName ?? "unknown"}), ignoring`,
      );
      return;
    }

    // Already connected?
    if (this.peerRegistry.get(peer.deviceId)) {
      return;
    }

    // Deterministic connection direction: lower deviceId initiates.
    if (this.identity.deviceId > peer.deviceId) {
      return;
    }

    const port = peer.gatewayPort ?? peer.port;
    if (!port) {
      return;
    }
    const host = peer.lanHost ?? peer.host ?? "localhost";
    const protocol = peer.gatewayTls ? "wss" : "ws";
    const url = `${protocol}://${host}:${port}`;

    this.log.info(`mesh: connecting to discovered peer ${peer.deviceId.slice(0, 12)}… at ${url}`);
    this.connectToPeer({
      deviceId: peer.deviceId,
      url,
      tlsFingerprint: peer.gatewayTlsFingerprintSha256,
    });
  }

  private connectToPeer(params: { deviceId: string; url: string; tlsFingerprint?: string }) {
    // Don't create duplicate clients.
    if (this.outboundClients.has(params.deviceId)) {
      return;
    }

    const client = new MeshPeerClient({
      url: params.url,
      remoteDeviceId: params.deviceId,
      identity: this.identity,
      peerRegistry: this.peerRegistry,
      tlsFingerprint: params.tlsFingerprint,
      displayName: this.displayName,
      capabilities: this.config.capabilities,
      onConnected: (session) => {
        this.onPeerConnected(session);
        this.log.info(
          `mesh: connected to peer ${session.deviceId.slice(0, 12)}… (${session.displayName ?? "unknown"})`,
        );
      },
      onDisconnected: (deviceId) => {
        this.capabilityRegistry.removePeer(deviceId);
        this.log.info(`mesh: peer disconnected: ${deviceId.slice(0, 12)}…`);
      },
      onError: (err) => {
        this.log.warn(`mesh: peer client error (${params.deviceId.slice(0, 12)}…): ${String(err)}`);
      },
    });
    this.outboundClients.set(params.deviceId, client);
    client.start();
  }

  private onPeerConnected(session: PeerSession) {
    // Register capabilities.
    if (session.capabilities.length > 0) {
      this.capabilityRegistry.updatePeer(session.deviceId, session.capabilities);
    }
  }
}
