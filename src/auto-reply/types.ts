import type { ImageContent } from "@mariozechner/pi-ai";
import type { InteractiveReply } from "../interactive/payload.js";
import type { TypingController } from "./reply/typing.js";

export type BlockReplyContext = {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
};

/** Context passed to onModelSelected callback with actual model used. */
export type ModelSelectedContext = {
  provider: string;
  model: string;
  thinkLevel: string | undefined;
};

export type TypingPolicy =
  | "auto"
  | "user_message"
  | "system_event"
  | "internal_webchat"
  | "heartbeat";

export type GetReplyOptions = {
  /** Override run id for agent events (defaults to random UUID). */
  runId?: string;
  /** Abort signal for the underlying agent run. */
  abortSignal?: AbortSignal;
  /** Optional inbound images (used for webchat attachments). */
  images?: ImageContent[];
  /** Notifies when an agent run actually starts (useful for webchat command handling). */
  onAgentRunStart?: (runId: string) => void;
  onReplyStart?: () => Promise<void> | void;
  /** Called when the typing controller cleans up (e.g., run ended with NO_REPLY). */
  onTypingCleanup?: () => void;
  onTypingController?: (typing: TypingController) => void;
  isHeartbeat?: boolean;
  /** Policy-level typing control for run classes (user/system/internal/heartbeat). */
  typingPolicy?: TypingPolicy;
  /** Force-disable typing indicators for this run (system/internal/cross-channel routes). */
  suppressTyping?: boolean;
  /** Resolved heartbeat model override (provider/model string from merged per-agent config). */
  heartbeatModelOverride?: string;
  /** Controls bootstrap workspace context injection (default: full). */
  bootstrapContextMode?: "full" | "lightweight";
  /** If true, suppress tool error warning payloads for this run. */
  suppressToolErrorWarnings?: boolean;
  onPartialReply?: (payload: ReplyPayload) => Promise<void> | void;
  onReasoningStream?: (payload: ReplyPayload) => Promise<void> | void;
  /** Called when a thinking/reasoning block ends. */
  onReasoningEnd?: () => Promise<void> | void;
  /** Called when a new assistant message starts (e.g., after tool call or thinking block). */
  onAssistantMessageStart?: () => Promise<void> | void;
  onBlockReply?: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void> | void;
  onToolResult?: (payload: ReplyPayload) => Promise<void> | void;
  /** Called when a tool phase starts/updates, before summary payloads are emitted. */
  onToolStart?: (payload: { name?: string; phase?: string }) => Promise<void> | void;
  /** Called when context auto-compaction starts (allows UX feedback during the pause). */
  onCompactionStart?: () => Promise<void> | void;
  /** Called when context auto-compaction completes. */
  onCompactionEnd?: () => Promise<void> | void;
  /** Called when the actual model is selected (including after fallback).
   * Use this to get model/provider/thinkLevel for responsePrefix template interpolation. */
  onModelSelected?: (ctx: ModelSelectedContext) => void;
  disableBlockStreaming?: boolean;
  /** Timeout for block reply delivery (ms). */
  blockReplyTimeoutMs?: number;
  /** If provided, only load these skills for this session (empty = no skills). */
  skillFilter?: string[];
  /** Mutable ref to track if a reply was sent (for Slack "first" threading mode). */
  hasRepliedRef?: { value: boolean };
  /** Override agent timeout in seconds (0 = no timeout). Threads through to resolveAgentTimeoutMs. */
  timeoutOverrideSeconds?: number;
  /** Optional extra system guidance appended to the run prompt. */
  extraSystemPrompt?: string;
  /** Controls whether the chief should create/update tracked work for this turn. */
  chiefTaskTrackingMode?: "tracked" | "skip";
  /** Reuse an existing chief tracked task instead of creating a new one. */
  matchedChiefTaskId?: string;
  /** Explicit Paperclip issue binding for tracked work. */
  paperclipIssueId?: string;
  /** Stable thread key used by continuity evaluation. */
  threadKey?: string;
  /** Stable normalized intent key for tracked work continuity. */
  openIntentKey?: string;
  /** Short tracked-work intent summary. */
  intentSummary?: string;
  /** Short current goal summary for the tracked task. */
  currentGoal?: string;
  /** Stable parent program id for the tracked task graph. */
  programId?: string;
  /** Optional parent task id inside the tracked work graph. */
  parentTaskId?: string;
  /** Role that chief or a worker is fulfilling for this turn. */
  role?: string;
  /** Explicit success criteria for the tracked task. */
  successCriteria?: string;
  /** Evidence gathered for verification and release gating. */
  verificationEvidence?: string[];
  /** Risk level chief currently assigns to the task. */
  riskLevel?: "low" | "medium" | "high" | "critical";
  /** Confidence score from continuity/intake evaluation. */
  confidence?: number;
  /** Latest milestone summary for progress heartbeat reporting. */
  latestMilestone?: string;
  /** Timestamp of the last user-visible progress report. */
  lastUserProgressReportAt?: number;
  /** Current release gate state for this tracked task. */
  releaseGateStatus?: "not_required" | "required" | "reviewing" | "passed" | "blocked";
  /** When true, defer chief task terminalization until the dispatcher confirms outbound delivery. */
  deferChiefTaskResultTracking?: boolean;
  /** Structured continuity decision for the current inbound turn. */
  continuityDecision?: "direct_answer" | "attach_existing_task" | "new_task_candidate";
  /** True when the tracked work was created only after explicit user approval. */
  createdByApproval?: boolean;
};

export type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  interactive?: InteractiveReply;
  btw?: {
    question: string;
  };
  replyToId?: string;
  replyToTag?: boolean;
  /** True when [[reply_to_current]] was present but not yet mapped to a message id. */
  replyToCurrent?: boolean;
  /** Send audio as voice message (bubble) instead of audio file. Defaults to false. */
  audioAsVoice?: boolean;
  isError?: boolean;
  /** Marks this payload as a reasoning/thinking block. Channels that do not
   *  have a dedicated reasoning lane (e.g. WhatsApp, web) should suppress it. */
  isReasoning?: boolean;
  /** Marks this payload as a compaction status notice (start/end).
   *  Should be excluded from TTS transcript accumulation so compaction
   *  status lines are not synthesised into the spoken assistant reply. */
  isCompactionNotice?: boolean;
  /** Channel-specific payload data (per-channel envelope). */
  channelData?: Record<string, unknown>;
};
