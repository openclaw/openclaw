export type SystemdSystemUnitRuntime = {
  unitName: string;
  activeState?: string;
  subState?: string;
  mainPid?: number;
  cgroup?: string;
  loaded?: boolean;
};

export type GatewayServiceRuntime = {
  status?: string;
  state?: string;
  subState?: string;
  pid?: number;
  lastExitStatus?: number;
  lastExitReason?: string;
  lastRunResult?: string;
  lastRunTime?: string;
  detail?: string;
  cachedLabel?: boolean;
  missingUnit?: boolean;
  /**
   * Which systemd scope produced this runtime snapshot. When the user bus is
   * unavailable but the host runs OpenClaw under system-level systemd units,
   * we fall back to probing the system bus and record the scope here so the
   * UI can differentiate.
   */
  scope?: "user" | "system";
  /** Systemd unit name this runtime snapshot was read from, when known. */
  unitName?: string;
  /** `/proc/<pid>/cgroup` service attribution for `pid`, when known. */
  cgroup?: string;
  /**
   * When the system-bus probe ran, optionally the full list of OpenClaw
   * system-level units it observed (gateway + node host, etc.). The first
   * entry is typically the one that sets the top-level fields.
   */
  systemUnits?: SystemdSystemUnitRuntime[];
};
