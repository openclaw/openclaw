import type { ChildRuntimeViability } from "../../infra/child-runtime-viability.js";
import type { AgentDatabaseAdmissionRefusal } from "../../state/agent-database-admission.js";
import type { GatewayPluginReloadStatus } from "../server-plugin-reload-status.types.js";
import type { GatewayEventLoopHealth } from "./event-loop-health.js";

// Keep readiness consumers independent of the channel-manager implementation graph.
export type ReadinessResult = {
  ready: boolean;
  coreReady: boolean;
  failing: string[];
  suppressed?: string[];
  uptimeMs: number;
  eventLoop?: GatewayEventLoopHealth;
  pluginReload?: GatewayPluginReloadStatus;
  agentDatabases?: readonly AgentDatabaseAdmissionRefusal[];
  stateDatabase?: { reason: string };
};

export type ReadinessChecker = (childRuntime?: ChildRuntimeViability) => ReadinessResult;
export type PreparedReadinessChecker = ReadinessChecker & {
  prepare: () => Promise<{ publish: () => ReadinessResult }>;
};

export type StartupResult =
  | { ok: true; status: "started"; uptimeMs: number }
  | { ok: false; status: "starting"; uptimeMs: number; pendingReason: string }
  | { ok: false; status: "draining"; uptimeMs: number };

export type StartupChecker = () => StartupResult;
