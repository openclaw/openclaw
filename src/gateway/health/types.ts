import type { Snapshot } from "../../../packages/gateway-protocol/src/schema/snapshot.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import type { ChildRuntimeViability } from "../../infra/child-runtime-viability.js";
import type { AgentDatabaseAdmissionRefusal } from "../../state/agent-database-admission.js";
import type { GatewayPluginReloadStatus } from "../server-plugin-reload-status.types.js";
import type { GatewayEventLoopHealth } from "../server/event-loop-health.js";

type ProtocolHealth = Snapshot["health"];
type ProtocolPlugin = NonNullable<ProtocolHealth["plugins"]>;
type UnavailablePlugin = NonNullable<ProtocolPlugin["unavailable"]>[number];

export type ChannelAccountHealthSummary = ChannelAccountSnapshot & {
  authAgeMs?: number | null;
  [key: string]: unknown;
};

export type ChannelHealthSummary = ChannelAccountHealthSummary & {
  accounts?: Record<string, ChannelAccountHealthSummary>;
};

export type AgentHealthSummary = NonNullable<ProtocolHealth["agents"]>[number];

export type PluginHealthErrorSummary = ProtocolPlugin["errors"][number];

export type PluginHealthSummary = Omit<ProtocolPlugin, "unavailable"> & {
  unavailable?: Array<
    Omit<UnavailablePlugin, "diagnostic"> & {
      diagnostic: Omit<UnavailablePlugin["diagnostic"], "reason"> & {
        reason: import("../../plugins/runtime-degraded-state.js").PluginVerificationFailureReason;
      };
    }
  >;
};

/** Full gateway health payload consumed by `openclaw health`. */
export type HealthSummary = ProtocolHealth & {
  recentCrashes?: readonly import("../../infra/gateway-crash.js").GatewayCrashRecord[];
  modelRuntime?: import("../../agents/prepared-model-runtime.startup-status.js").PreparedModelRuntimeStartupStatus;
  ok: true;
  ts: number;
  durationMs: number;
  plugins?: PluginHealthSummary;
  channels: Record<string, ChannelHealthSummary>;
  channelOrder: string[];
  channelLabels: Record<string, string>;
  heartbeatSeconds: number;
  agents: AgentHealthSummary[];
  sessions: NonNullable<ProtocolHealth["sessions"]>;
};

export type ReadinessResult = {
  ready: boolean;
  coreReady: boolean;
  failing: string[];
  degraded?: string[];
  suppressed?: string[];
  uptimeMs: number;
  eventLoop?: GatewayEventLoopHealth;
  pluginReload?: GatewayPluginReloadStatus;
  agentDatabases?: readonly AgentDatabaseAdmissionRefusal[];
  agentDeletions?: readonly AgentDatabaseAdmissionRefusal[];
  stateDatabase?: { reason: string };
};

export type ReadinessChecker = (childRuntime?: ChildRuntimeViability) => ReadinessResult;
