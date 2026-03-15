import type { ExecToolDefaults } from "../../../agents/bash-tools.js";
import type { SkillSnapshot } from "../../../agents/skills.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { SessionEntry } from "../../../config/sessions.js";
import type {
  MediaUnderstandingDecision,
  MediaUnderstandingOutput,
} from "../../../media-understanding/types.js";
import type { InputProvenance } from "../../../sessions/input-provenance.js";
import type { OriginatingChannelType } from "../../templating.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../directives.js";

export type QueueMode = "steer" | "followup" | "collect" | "steer-backlog" | "interrupt" | "queue";

export type QueueDropPolicy = "old" | "new" | "summarize";

export type QueueSettings = {
  mode: QueueMode;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
};

export type QueueDedupeMode = "message-id" | "prompt" | "none";

/**
 * Snapshot of media-related context fields carried on a FollowupRun so that
 * the followup runner can apply media understanding (e.g. voice-note
 * transcription) when it was not applied — or failed — in the primary path.
 */
export type FollowupMediaContext = {
  Body?: string;
  CommandBody?: string;
  RawBody?: string;
  Provider?: string;
  Surface?: string;
  MediaPath?: string;
  MediaUrl?: string;
  MediaType?: string;
  MediaDir?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
  MediaRemoteHost?: string;
  Transcript?: string;
  MediaUnderstanding?: MediaUnderstandingOutput[];
  MediaUnderstandingDecisions?: MediaUnderstandingDecision[];
  OriginatingChannel?: OriginatingChannelType;
  OriginatingTo?: string;
  AccountId?: string;
  MessageThreadId?: string | number;
  DeferredMediaApplied?: boolean;
  /**
   * Set when file extraction has already been applied to Body (either in the
   * primary path or by a previous deferred-media run).  Checked instead of
   * scanning body text for `<file` patterns to avoid false-positives on user
   * messages that contain literal XML-like text.
   */
  DeferredFileBlocksExtracted?: boolean;
};

export type FollowupRun = {
  prompt: string;
  /** Provider message ID, when available (for deduplication). */
  messageId?: string;
  summaryLine?: string;
  enqueuedAt: number;
  /**
   * Media context snapshot from the original inbound message.
   * When present and MediaUnderstanding is empty, the followup runner will
   * attempt to apply media understanding (audio transcription, etc.) before
   * passing the prompt to the agent.
   */
  mediaContext?: FollowupMediaContext;
  /**
   * Originating channel for reply routing.
   * When set, replies should be routed back to this provider
   * instead of using the session's lastChannel.
   */
  originatingChannel?: OriginatingChannelType;
  /**
   * Originating destination for reply routing.
   * The chat/channel/user ID where the reply should be sent.
   */
  originatingTo?: string;
  /** Provider account id (multi-account). */
  originatingAccountId?: string;
  /** Thread id for reply routing (Telegram topic id or Matrix thread event id). */
  originatingThreadId?: string | number;
  /** Chat type for context-aware threading (e.g., DM vs channel). */
  originatingChatType?: string;
  run: {
    agentId: string;
    agentDir: string;
    sessionId: string;
    sessionKey?: string;
    messageProvider?: string;
    agentAccountId?: string;
    groupId?: string;
    groupChannel?: string;
    groupSpace?: string;
    senderId?: string;
    senderName?: string;
    senderUsername?: string;
    senderE164?: string;
    senderIsOwner?: boolean;
    sessionFile: string;
    workspaceDir: string;
    config: OpenClawConfig;
    skillsSnapshot?: SkillSnapshot;
    provider: string;
    model: string;
    authProfileId?: string;
    authProfileIdSource?: "auto" | "user";
    thinkLevel?: ThinkLevel;
    verboseLevel?: VerboseLevel;
    reasoningLevel?: ReasoningLevel;
    elevatedLevel?: ElevatedLevel;
    execOverrides?: Pick<ExecToolDefaults, "host" | "security" | "ask" | "node">;
    bashElevated?: {
      enabled: boolean;
      allowed: boolean;
      defaultLevel: ElevatedLevel;
    };
    timeoutMs: number;
    blockReplyBreak: "text_end" | "message_end";
    ownerNumbers?: string[];
    inputProvenance?: InputProvenance;
    extraSystemPrompt?: string;
    enforceFinalTag?: boolean;
  };
};

export type ResolveQueueSettingsParams = {
  cfg: OpenClawConfig;
  channel?: string;
  sessionEntry?: SessionEntry;
  inlineMode?: QueueMode;
  inlineOptions?: Partial<QueueSettings>;
};
