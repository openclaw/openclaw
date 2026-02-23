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
  /**
   * Dangerous override: allow bind mounts that target reserved container paths
   * like /workspace or /agent.
   */
  dangerouslyAllowReservedContainerTargets?: boolean;
  /**
   * Dangerous override: allow bind mount sources outside runtime allowlisted roots
   * (workspace + agent workspace roots).
   */
  dangerouslyAllowExternalBindSources?: boolean;
  /**
   * Dangerous override: allow Docker `network: "container:<id>"` namespace joins.
   * Default behavior blocks container namespace joins to preserve sandbox isolation.
   */
  dangerouslyAllowContainerNamespaceJoin?: boolean;
};

export type SandboxBrowserSettings = {
  enabled?: boolean;
  image?: string;
  containerPrefix?: string;
  /** Docker network for sandbox browser containers (default: openclaw-sandbox-browser). */
  network?: string;
  cdpPort?: number;
  /** Optional CIDR allowlist for CDP ingress at the container edge (for example: 172.21.0.1/32). */
  cdpSourceRange?: string;
  vncPort?: number;
  noVncPort?: number;
  headless?: boolean;
  enableNoVnc?: boolean;
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
  /** Additional bind mounts for the browser container only. When set, replaces docker.binds for the browser container. */
  binds?: string[];
};

export type SandboxBwrapSettings = {
  /** Working directory inside the namespace (workspace mount target). */
  workdir?: string;
  /** Mount the root filesystem read-only. Default: true. */
  readOnlyRoot?: boolean;
  /** Paths to mount as tmpfs inside the namespace. Default: ["/tmp", "/var/tmp", "/run"]. */
  tmpfs?: string[];
  /** Disable network access via --unshare-net. Default: true (no network). */
  unshareNet?: boolean;
  /** Unshare PID namespace. Default: true. */
  unsharePid?: boolean;
  /** Unshare IPC namespace. Default: true. */
  unshareIpc?: boolean;
  /** Unshare cgroup namespace. Default: false. */
  unshareCgroup?: boolean;
  /** Use --new-session to prevent TIOCSTI attacks. Default: true. */
  newSession?: boolean;
  /** Use --die-with-parent to kill sandbox when parent exits. Default: true. */
  dieWithParent?: boolean;
  /**
   * Mount a /proc filesystem inside the namespace.
   * Disable for already-containerised environments where /proc is inherited.
   * Default: true.
   */
  mountProc?: boolean;
  /**
   * Additional bind mounts: "hostPath:containerPath" or "hostPath:containerPath:rw".
   */
  extraBinds?: string[];
  /**
   * Host paths to bind read-only into the namespace for a functioning userland.
   * Defaults: /usr, /lib, /lib64, /bin, /sbin, /etc.
   */
  rootBinds?: string[];
  /** Extra environment variables for sandbox exec. */
  env?: Record<string, string>;
};

export type SandboxPruneSettings = {
  /** Prune if idle for more than N hours (0 disables). */
  idleHours?: number;
  /** Prune if older than N days (0 disables). */
  maxAgeDays?: number;
};
