import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import type {
  countActiveRunsForSession,
  registerSubagentRun,
} from "../subagents/registry/subagent-registry.js";
import type { InProcessGatewayCaller } from "./in-process-gateway.js";

export type SessionsSpawnToolOptions = {
  callGateway?: InProcessGatewayCaller;
  registerRun?: typeof registerSubagentRun;
  countActiveRuns?: typeof countActiveRunsForSession;
  agentSessionKey?: string;
  /** Trusted parent invocation fact, not a model-facing spawn parameter. */
  senderIsOwner?: boolean;
  requesterTurnRunId?: string;
  /** Separate key used only for completion routing (registerSubagentRun requesterSessionKey). */
  completionOwnerKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  /** Host-minted provenance of the ambient current conversation for thread binding. */
  currentConversationOrigin?: import("../../gateway/mcp-grant-store.js").McpCurrentConversationOrigin;
  currentMessageId?: string | number;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
  requesterAgentIdOverride?: string;
  requesterRunId?: string;
  swarmCollector?: boolean;
  /** Backend-derived parent incarnation; never sourced from model arguments. */
  expectedParentSessionId?: string;
  signal?: AbortSignal;
} & SpawnedToolContext;
