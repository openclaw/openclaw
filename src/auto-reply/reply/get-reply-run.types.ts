import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type { AutoFallbackPrimaryProbe } from "../../agents/agent-scope.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ExplicitSkillSelection } from "../../skills/types.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
import type { buildCommandContext } from "./commands.js";
import type { InlineDirectives } from "./directive-handling.js";
import type { ReplyExecOverrides } from "./get-reply-exec-overrides.js";
import type { InternalGetReplyOptions as BaseInternalGetReplyOptions } from "./get-reply.types.js";
import type { createModelSelectionState } from "./model-selection.js";
import type { PreparedReplyConversation } from "./prompt-session-context.js";
import type { ReplySessionEntryHandle } from "./session-entry-handle.js";
import type { TypingController } from "./typing.js";

export type InternalGetReplyOptions = BaseInternalGetReplyOptions & {
  /**
   * Source-owned abort signal to persist with queued room-event followups. This
   * can differ from abortSignal when dispatch temporarily borrows an active lane.
   */
  queuedFollowupAbortSignal?: AbortSignal;
};

type AgentDefaults = NonNullable<OpenClawConfig["agents"]>["defaults"];

export type RunPreparedReplyParams = {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  conversation: PreparedReplyConversation;
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  agentCfg: AgentDefaults;
  sessionCfg: OpenClawConfig["session"];
  commandAuthorized: boolean;
  command: ReturnType<typeof buildCommandContext>;
  commandSource?: string;
  allowTextCommands: boolean;
  directives: InlineDirectives;
  defaultActivation: "always" | "mention";
  resolvedThinkLevel: ThinkLevel | undefined;
  resolvedFastMode?: FastMode;
  resolvedFastModeAutoOnSeconds?: number;
  resolvedFastModeOverride?: boolean;
  resolvedFastModeAutoOnSecondsOverride?: boolean;
  resolvedVerboseLevel: VerboseLevel | undefined;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel: ElevatedLevel;
  execOverrides?: ReplyExecOverrides;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  modelState: Awaited<ReturnType<typeof createModelSelectionState>>;
  provider: string;
  model: string;
  /** Turn-local account pin from the selected model reference. */
  configuredProfileId?: string;
  requestedRouteResolution?: Awaited<
    ReturnType<typeof createModelSelectionState>
  >["requestedRouteResolution"];
  perMessageQueueMode?: InlineDirectives["queueMode"];
  perMessageQueueOptions?: {
    debounceMs?: number;
    cap?: number;
    dropPolicy?: InlineDirectives["dropPolicy"];
  };
  typing: TypingController;
  opts?: InternalGetReplyOptions;
  defaultModel: string;
  timeoutMs: number;
  isNewSession: boolean;
  resetTriggered: boolean;
  systemSent: boolean;
  sessionEntry?: SessionEntry;
  sessionEntryHandle?: ReplySessionEntryHandle;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  sessionId?: string;
  storePath?: string;
  workspaceDir: string;
  abortedLastRun: boolean;
  explicitSkillSelections?: ExplicitSkillSelection[];
  autoFallbackPrimaryProbe?: AutoFallbackPrimaryProbe;
};
