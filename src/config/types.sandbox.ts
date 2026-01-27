export type SandboxDockerSettings = {
  /** Docker image to use for sandbox containers. */
  image?: string;
  /** Prefix for sandbox container names. */
  containerPrefix?: string;
  /** Container workdir mount path (default: /workspace). */
  workdir?: string;
  /** Run container rootfs read-only. */
  readOnlyRoot?: boolean;
  /** Extra tmpfs mounts for read-only containers. */
  tmpfs?: string[];
  /** Container network mode (bridge|none|custom). */
  network?: string;
  /** Container user (uid:gid). */
  user?: string;
  /** Drop Linux capabilities. */
  capDrop?: string[];
  /** Extra environment variables for sandbox exec. */
  env?: Record<string, string>;
  /** Optional setup command run once after container creation. */
  setupCommand?: string;
  /** Limit container PIDs (0 = Docker default). */
  pidsLimit?: number;
  /** Limit container memory (e.g. 512m, 2g, or bytes as number). */
  memory?: string | number;
  /** Limit container memory swap (same format as memory). */
  memorySwap?: string | number;
  /** Limit container CPU shares (e.g. 0.5, 1, 2). */
  cpus?: number;
  /**
   * Set ulimit values by name (e.g. nofile, nproc).
   * Use "soft:hard" string, a number, or { soft, hard }.
   */
  ulimits?: Record<string, string | number | { soft?: number; hard?: number }>;
  /** Seccomp profile (path or profile name). */
  seccompProfile?: string;
  /** AppArmor profile name. */
  apparmorProfile?: string;
  /** DNS servers (e.g. ["1.1.1.1", "8.8.8.8"]). */
  dns?: string[];
  /** Extra host mappings (e.g. ["api.local:10.0.0.2"]). */
  extraHosts?: string[];
  /** Additional bind mounts (host:container:mode format, e.g. ["/host/path:/container/path:rw"]). */
  binds?: string[];
};

/** Browser provider for sandbox sessions. */
export type SandboxBrowserProvider = "docker" | "anchorbrowser";

/** Anchorbrowser proxy configuration. */
export type AnchorBrowserProxySettings = {
  /** Enable proxy. */
  active?: boolean;
  /** Proxy type (anchor_proxy, anchor_residential, anchor_mobile, anchor_gov). */
  type?: "anchor_proxy" | "anchor_residential" | "anchor_mobile" | "anchor_gov";
  /** Country code (ISO 2 lowercase, e.g. "us"). */
  countryCode?: string;
  /** Region code for geographic targeting. */
  region?: string;
  /** City name for precise targeting (requires region). */
  city?: string;
};

/** Anchorbrowser timeout configuration. */
export type AnchorBrowserTimeoutSettings = {
  /** Max session duration in minutes (default: 20). */
  maxDuration?: number;
  /** Idle timeout in minutes before session stops (default: 5). */
  idleTimeout?: number;
};

/** Anchorbrowser-specific settings. */
export type AnchorBrowserSettings = {
  /** API key (prefer env var ANCHORBROWSER_API_KEY). */
  apiKey?: string;
  /** Override API URL (default: https://api.anchorbrowser.io/v1). */
  apiUrl?: string;
  /** Proxy configuration. */
  proxy?: AnchorBrowserProxySettings;
  /** Timeout configuration. */
  timeout?: AnchorBrowserTimeoutSettings;
  /** Enable captcha solving (requires proxy). */
  captchaSolver?: boolean;
  /** Enable ad blocking (default: true). */
  adblock?: boolean;
  /** Enable popup blocking (default: true). */
  popupBlocker?: boolean;
  /** Run browser headless (default: false). */
  headless?: boolean;
  /** Viewport dimensions. */
  viewport?: { width: number; height: number };
  /** Enable session recording (default: true). */
  recording?: boolean;
  /** Enable extra stealth mode (requires proxy). */
  extraStealth?: boolean;
};

export type SandboxBrowserSettings = {
  enabled?: boolean;
  /** Browser provider: "docker" (default) or "anchorbrowser". */
  provider?: SandboxBrowserProvider;

  // Docker-specific settings
  image?: string;
  containerPrefix?: string;
  cdpPort?: number;
  vncPort?: number;
  noVncPort?: number;
  enableNoVnc?: boolean;

  // Anchorbrowser-specific settings
  anchorbrowser?: AnchorBrowserSettings;

  // Common settings
  headless?: boolean;
  /**
   * Allow sandboxed sessions to target the host browser control server.
   * Default: false.
   */
  allowHostControl?: boolean;
  /**
   * When true (default), sandboxed browser control will try to start/reattach to
   * the sandbox browser container when a tool call needs it.
   */
  autoStart?: boolean;
  /** Max time to wait for CDP to become reachable after auto-start (ms). */
  autoStartTimeoutMs?: number;
};

export type SandboxPruneSettings = {
  /** Prune if idle for more than N hours (0 disables). */
  idleHours?: number;
  /** Prune if older than N days (0 disables). */
  maxAgeDays?: number;
};
