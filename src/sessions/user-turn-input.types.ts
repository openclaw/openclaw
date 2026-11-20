import type { HumanMention } from "@openclaw/gateway-protocol";
import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import type { ChatAppContextAttachment } from "../../packages/gateway-protocol/src/chat-app-context.js";
import type { ParticipationCeiling } from "../agents/participation-ceiling.js";
import type { RequesterOrigin } from "../agents/requester-origin.js";
import type { MessageClientSource } from "../chat/message-client-source.js";
import type { TranscriptSenderIdentity } from "../chat/sender-identity.js";
import type { AttachedChatWorkContext } from "../chat/work-context.js";
import type { MediaFactInput } from "../media/media-facts.js";
import type { SubagentCompletion } from "../shared/subagent-completion.js";
import type { InputProvenance } from "./input-provenance.js";

export type PersistedUserTurnMediaInput = Pick<
  MediaFactInput,
  | "contentType"
  | "durationMs"
  | "fileName"
  | "origin"
  | "height"
  | "hydrationSuppressed"
  | "messageId"
  | "path"
  | "sizeBytes"
  | "transcribed"
  | "url"
  | "width"
> & {
  kind?: string | null;
  workspaceDir?: string | null;
};

export type PersistedUserTurnMessage = Extract<AgentMessage, { role: "user" }> & {
  display?: false;
  excludeFromContext?: true;
  /** Private transcript correlation; never authorizes an execution. */
  idempotencyKey?: string;
  provenance?: InputProvenance;
  __openclaw?: Record<string, unknown> & {
    /** Host-captured input ceiling; recovery still re-admits the sender. */
    participationCeiling?: ParticipationCeiling;
    humanMentions?: readonly HumanMention[];
    /** Addressed to the selected people: no agent turn, and transparent to an active turn. */
    humanAddressed?: true;
    /** Accepted delivery intent; readmission still checks the sender's current authority. */
    chatSendDelivery?: {
      deliver?: boolean;
      originatingChannel?: string;
      originatingTo?: string;
      originatingAccountId?: string;
      originatingThreadId?: string;
    };
    chatSendRuntime?: {
      thinking?: string;
      fastMode?: FastMode;
      fastAutoOnSeconds?: number;
      timeoutMs?: number;
    };
    requesterOrigin?: RequesterOrigin;
  };
};

export type UserTurnInput = Pick<PersistedUserTurnMessage, "display" | "excludeFromContext"> & {
  subagentCompletions?: readonly SubagentCompletion[];
  text?: string | null;
  /** Display receipt of shared App references; never added to model text. */
  appContext?: ChatAppContextAttachment[];
  /** Authored text and its captured reference; model content stays unchanged. */
  workContext?: AttachedChatWorkContext;
  /** Explicit human selections bound to UTF-16 offsets in text. */
  mentions?: readonly HumanMention[];
  /** The selected people are the recipients; no agent turn runs for this input. */
  humanAddressed?: true;
  media?: readonly PersistedUserTurnMediaInput[] | null;
  /** Restart-safe native image placement; model-visible prompt bytes remain separate. */
  mediaImageLayout?: {
    slots: readonly {
      kind: "inline" | "offloaded";
      factIndex?: number;
    }[];
    suppressedFactIndexes?: readonly number[];
  } | null;
  timestamp?: number;
  idempotencyKey?: string;
  /** Durable transcript message reference used to render and hydrate replies. */
  replyToId?: string;
  /** Bounded display fallback for replies whose target is outside loaded history. */
  replyToPreview?: { text: string; senderLabel?: string | null } | null;
  senderIsOwner?: boolean;
  /** Host-captured requester facts; recovery still requires exact accepted-input custody. */
  requesterOrigin?: RequesterOrigin;
  provenance?: InputProvenance;
  /** Identity is producer-owned attribution; labels remain editable display metadata. */
  sender?: {
    id?: string | null;
    name?: string | null;
    username?: string | null;
    identity?: TranscriptSenderIdentity;
    /** The platform marked the message as a forward; its text is not the sender's own words. */
    forwarded?: boolean;
  } | null;
  /** Durable transport correlation; stored privately and never rendered into model input. */
  transport?: {
    /** Reported client sources retained through collection; never sender authority. */
    clients?: readonly MessageClientSource[];
    channel?: string;
    conversationRef?: string;
    messageId?: string;
    replyToId?: string;
    threadId?: string;
  };
};
