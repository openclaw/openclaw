import type { AgentInternalEvent } from "../../agents/internal-events.js";
import type { ClientToolDefinition } from "../../agents/pi-embedded-runner/run/params.js";
import type { SpawnedRunMetadata } from "../../agents/spawned-context.js";
import type { ReasoningLevel } from "../../auto-reply/thinking.js";
import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";

/** Image content block for Claude API multimodal messages. */
export type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

export type AgentStreamParams = {
  /** Provider stream params override (best-effort). */
  temperature?: number;
  maxTokens?: number;
  /** Provider fast-mode override (best-effort). */
  fastMode?: boolean;
};

export type AgentRunContext = {
  messageChannel?: string;
  accountId?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  currentChannelId?: string;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all";
  hasRepliedRef?: { value: boolean };
};

export type AgentCommandOpts = {
  message: string;
  /** Optional image attachments for multimodal messages. */
  images?: ImageContent[];
  /** Optional client-provided tools (OpenResponses hosted tools). */
  clientTools?: ClientToolDefinition[];
  /** Agent id override (must exist in config). */
  agentId?: string;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  thinking?: string;
  thinkingOnce?: string;
  verbose?: string;
  /** Optional reasoning stream level for this run. */
  reasoningLevel?: ReasoningLevel;
  json?: boolean;
  timeout?: string;
  deliver?: boolean;
  /** Override delivery target (separate from session routing). */
  replyTo?: string;
  /** Override delivery channel (separate from session routing). */
  replyChannel?: string;
  /** Override delivery account id (separate from session routing). */
  replyAccountId?: string;
  /** Override delivery thread/topic id (separate from session routing). */
  threadId?: string | number;
  /** Message channel context (webchat|voicewake|whatsapp|...). */
  messageChannel?: string;
  channel?: string; // delivery channel (whatsapp|telegram|...)
  /** Account ID for multi-account channel routing (e.g., WhatsApp account). */
  accountId?: string;
  /** Context for embedded run routing (channel/account/thread). */
  runContext?: AgentRunContext;
  /** Whether this caller is authorized for owner-only tools (defaults true for local CLI calls). */
  senderIsOwner?: boolean;
  /** Group/spawn metadata for subagent policy inheritance and routing context. */
  groupId?: SpawnedRunMetadata["groupId"];
  groupChannel?: SpawnedRunMetadata["groupChannel"];
  groupSpace?: SpawnedRunMetadata["groupSpace"];
  spawnedBy?: SpawnedRunMetadata["spawnedBy"];
  deliveryTargetMode?: ChannelOutboundTargetMode;
  bestEffortDeliver?: boolean;
  abortSignal?: AbortSignal;
  lane?: string;
  runId?: string;
  extraSystemPrompt?: string;
  internalEvents?: AgentInternalEvent[];
  inputProvenance?: InputProvenance;
  /** Per-call stream param overrides (best-effort). */
  streamParams?: AgentStreamParams;
  /** Explicit workspace directory override (for subagents to inherit parent workspace). */
  workspaceDir?: SpawnedRunMetadata["workspaceDir"];
  /** Optional max decoded bytes to include for base64 data in tool results. */
  toolResultMaxDataBytes?: number;
  /** Optional reasoning stream callback for hosted integrations (e.g. OpenResponses). */
  onReasoningStream?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
};

export type AgentCommandIngressOpts = Omit<AgentCommandOpts, "senderIsOwner"> & {
  /** Ingress callsites must always pass explicit owner authorization state. */
  senderIsOwner: boolean;
};
