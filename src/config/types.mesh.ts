export type MeshStaticPeer = {
  /** WebSocket URL of the remote gateway (e.g. "wss://jetson.local:18789"). */
  url: string;
  /** Expected device ID (SHA256 of Ed25519 public key) for mutual authentication. */
  deviceId: string;
  /** Optional TLS certificate fingerprint for pinning. */
  tlsFingerprint?: string;
};

export type MeshConfig = {
  /** Enable the Neural Mesh Protocol. Default: false. */
  enabled?: boolean;
  /** mDNS scan interval in milliseconds. Default: 30000. */
  scanIntervalMs?: number;
  /** Capabilities advertised by this gateway (e.g. channel names, skills). */
  capabilities?: string[];
  /** Statically configured peers (for environments without mDNS). */
  peers?: MeshStaticPeer[];
};
