/**
 * Holochain integration types for OpenClaw.
 * Phase 2: Lightweight hybrid mode with DHT session storage.
 */

export type HolochainMode = "disabled" | "hybrid" | "full-p2p";

export type HolochainConductorConfig = {
  /** Path to the Holochain conductor binary (default: auto-detect from PATH). */
  binPath?: string;
  /** Admin port for conductor control (default: 4444). */
  adminPort?: number;
  /** App port for zome calls (default: 4445). */
  appPort?: number;
  /** Auto-start conductor if not running (default: true). */
  autoStart?: boolean;
  /** Conductor data directory (default: ~/.openclaw/holochain). */
  dataDir?: string;
};

export type HolochainSessionStorageConfig = {
  /** Enable DHT-based session storage (default: false in hybrid mode). */
  enabled?: boolean;
  /** Fallback to local storage if Holochain is unavailable (default: true). */
  fallbackToLocal?: boolean;
  /** Session retention period in days (default: 30). */
  retentionDays?: number;
  /** Enable session encryption with AES-256 (default: true). */
  encryption?: boolean;
};

export type HolochainSecurityConfig = {
  /** Enable prompt injection prevention via Holochain validation (default: false). */
  promptValidation?: boolean;
  /** Enable immutable audit logging to DHT (default: false). */
  auditLog?: boolean;
  /** Rate limiting per IP/hour (default: 10). */
  rateLimitPerHour?: number;
  /** Enable AppArmor/seccomp profiles (default: false). */
  sandboxHardening?: boolean;
};

export type HolochainA2AConfig = {
  /** Enable Agent-to-Agent economy features (default: false). */
  enabled?: boolean;
  /** Solana/USDC wallet integration (default: disabled). */
  wallet?: {
    enabled?: boolean;
    /** Managed wallet seed phrase (encrypted, stored in conductor). */
    seedPhrase?: string;
    /** Network: mainnet-beta, devnet, testnet (default: devnet). */
    network?: "mainnet-beta" | "devnet" | "testnet";
  };
  /** Commission rate for verified skills (0.0-1.0, default: 0.05 = 5%). */
  commissionRate?: number;
  /** Max ping-pong turns for A2A sessions (default: 5). */
  maxPingPongTurns?: number;
};

export type HolochainP2PConfig = {
  /** Enable full P2P mode (disables Node.js gateway for routing). */
  enabled?: boolean;
  /** Bootstrap nodes for DHT peer discovery. */
  bootstrapNodes?: string[];
  /** Network identifier (default: openclaw-mainnet). */
  networkId?: string;
  /** Enable Kitsune P2P transport (default: true). */
  kitsuneTransport?: boolean;
};

export type HolochainConfig = {
  /**
   * Holochain integration mode:
   * - disabled: No Holochain (default)
   * - hybrid: Node.js gateway + DHT session storage
   * - full-p2p: Full P2P routing via Holochain
   */
  mode?: HolochainMode;
  /** Conductor configuration. */
  conductor?: HolochainConductorConfig;
  /** Session storage configuration. */
  sessionStorage?: HolochainSessionStorageConfig;
  /** Security features. */
  security?: HolochainSecurityConfig;
  /** Agent-to-Agent economy. */
  a2a?: HolochainA2AConfig;
  /** Full P2P routing. */
  p2p?: HolochainP2PConfig;
};
