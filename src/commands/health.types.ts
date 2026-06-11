export type ChannelAccountHealthSummary = {
  accountId: string;
  configured?: boolean;
  linked?: boolean;
  authAgeMs?: number | null;
  probe?: unknown;
  lastProbeAt?: number | null;
  [key: string]: unknown;
};

export type ChannelHealthSummary = ChannelAccountHealthSummary & {
  accounts?: Record<string, ChannelAccountHealthSummary>;
};

export type AgentHealthSummary = {
  agentId: string;
  name?: string;
  isDefault: boolean;
  heartbeat: import("../infra/heartbeat-summary.js").HeartbeatSummary;
  sessions: HealthSummary["sessions"];
};

export type PluginHealthErrorSummary = {
  id: string;
  origin: string;
  activated: boolean;
  activationSource?: string;
  activationReason?: string;
  failurePhase?: string;
  error: string;
};

export type PluginHealthSummary = {
  loaded: string[];
  errors: PluginHealthErrorSummary[];
};

export type GatewayRemoteAccessStatus = "healthy" | "degraded" | "failed";

export type GatewayRemoteAccessHealthSummary = {
  status: GatewayRemoteAccessStatus;
  required: boolean;
  degradedReasons: string[];
  repairCommands: string[];
  tailscale?: {
    mode?: "off" | "serve" | "funnel";
    binary?: string;
    socketPath?: string;
    backendState?: string;
    dnsName?: string;
    ips?: string[];
    installKind?: string;
    serveRouteOk?: boolean;
    funnelRouteOk?: boolean;
    whoisOk?: boolean;
  };
  codexSsh?: {
    target: string;
    configOk: boolean;
    batchOk?: boolean;
    daemonStatus?: string;
    cliVersion?: string;
    appServerVersion?: string;
  };
};

export type HealthSummary = {
  ok: true;
  ts: number;
  durationMs: number;
  eventLoop?: import("../gateway/server/event-loop-health.js").GatewayEventLoopHealth;
  plugins?: PluginHealthSummary;
  remoteAccess?: GatewayRemoteAccessHealthSummary;
  channels: Record<string, ChannelHealthSummary>;
  channelOrder: string[];
  channelLabels: Record<string, string>;
  heartbeatSeconds: number;
  defaultAgentId: string;
  agents: AgentHealthSummary[];
  sessions: {
    path: string;
    count: number;
    recent: Array<{
      key: string;
      updatedAt: number | null;
      age: number | null;
    }>;
  };
};
