/** Process-level listener facts collected from lsof/netstat/PowerShell probes. */
export type PortListener = {
  pid?: number;
  ppid?: number;
  command?: string;
  commandLine?: string;
  user?: string;
  address?: string;
};

/** Direction of a TCP row relative to the inspected port. */
export type PortConnectionDirection = "client" | "server" | "unknown";

/** Connection row with listener metadata plus client/server direction. */
export type PortConnection = PortListener & {
  direction: PortConnectionDirection;
};

/** Coarse availability state for a port probe. */
export type PortUsageStatus = "free" | "busy" | "unknown";

/** Aggregated listener and hint payload used by gateway/daemon port diagnostics. */
export type PortUsage = {
  port: number;
  status: PortUsageStatus;
  listeners: PortListener[];
  hints: string[];
  detail?: string;
  errors?: string[];
};

/** Known listener categories used for restart/daemon health decisions. */
export type PortListenerKind = "gateway" | "ssh" | "unknown";

/** Active TCP connection payload for diagnostics that need peer direction. */
export type PortConnections = {
  port: number;
  connections: PortConnection[];
  detail?: string;
  errors?: string[];
};
