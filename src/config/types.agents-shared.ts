import type {
  SandboxBrowserSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
} from "./types.sandbox.js";

export type PrimaryRecoveryConfig = {
  /**
   * How often (ms) to probe the primary model during fallback to check
   * if it has recovered. Default: 300_000 (5 minutes).
   * Set to 0 to disable periodic probing (only probe near cooldown expiry).
   */
  probeIntervalMs?: number;
  /**
   * Whether to automatically return to the primary model when it recovers
   * from cooldown. Default: true.
   * When false, fallback persists until manually cleared via /model or
   * session_status(model='default').
   */
  autoReturn?: boolean;
};

export type AgentModelConfig =
  | string
  | {
      /** Primary model (provider/model). */
      primary?: string;
      /** Per-agent model fallbacks (provider/model). */
      fallbacks?: string[];
      /** Controls how aggressively the system probes and returns to the primary model after fallback. */
      primaryRecovery?: PrimaryRecoveryConfig;
    };

export type AgentSandboxConfig = {
  mode?: "off" | "non-main" | "all";
  /** Agent workspace access inside the sandbox. */
  workspaceAccess?: "none" | "ro" | "rw";
  /**
   * Session tools visibility for sandboxed sessions.
   * - "spawned": only allow session tools to target sessions spawned from this session (default)
   * - "all": allow session tools to target any session
   */
  sessionToolsVisibility?: "spawned" | "all";
  /** Container/workspace scope for sandbox isolation. */
  scope?: "session" | "agent" | "shared";
  /** Legacy alias for scope ("session" when true, "shared" when false). */
  perSession?: boolean;
  workspaceRoot?: string;
  /** Docker-specific sandbox settings. */
  docker?: SandboxDockerSettings;
  /** Optional sandboxed browser settings. */
  browser?: SandboxBrowserSettings;
  /** Auto-prune sandbox settings. */
  prune?: SandboxPruneSettings;
};
