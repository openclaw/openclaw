import type { HumanMention } from "@openclaw/gateway-protocol";
import type { MediaKind } from "@openclaw/media-core/constants";
import type { ChatWorkContext } from "../../../../packages/gateway-protocol/src/chat-work-context.js";
/**
 * Chat message types for the UI layer.
 */
import type {
  AgentActivityItem,
  ChatSendIntent,
  QueueMode,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { extractCanvasFromText } from "../../../../src/chat/canvas-render.js";
import type { MessageClientSource } from "../../../../src/chat/message-client-source.js";
import type { ClawHubRecommendation } from "../../../../src/shared/clawhub-recommendations.js";
import type { BrowserTabTarget } from "../../components/browser/browser-target.ts";
import type { toolIcons } from "../../components/icons-tools.ts";
import type { SenderIdentity } from "./sender-label.ts";

export type { HumanMention };

export type BrowserAnnotationAttachment = {
  modelContext: string;
  title: string;
  displayUrl: string;
  markedRegionCount: number;
  inspectedElement: boolean;
};

export type ChatSelectionSource = {
  text: string;
  messageId?: string;
  entryId?: string;
  /** UTF-16 offsets in the source bubble’s concatenated DOM text nodes. */
  start: number;
  end: number;
};

export type ChatSelectionAnnotation = ChatSelectionSource & {
  comment: string;
  sessionKey: string;
};

export type ChatAttachment = {
  id: string;
  dataUrl?: string;
  previewUrl?: string;
  mimeType: string;
  origin?: "paste" | "file";
  fileName?: string;
  sizeBytes?: number;
  /** UI-local context that must remain coupled to its annotated screenshot. */
  browserAnnotation?: BrowserAnnotationAttachment;
  selectionAnnotation?: ChatSelectionAnnotation;
};

// Shared payload contract: draft and outbox storage must not import each other's runtime.
export type DurableComposerDraftAttachment = Omit<
  ChatAttachment,
  "id" | "dataUrl" | "previewUrl"
> & {
  blob: Blob;
};

export type ChatComposerDraftRetry = {
  expectedDraftRevision: number;
  draftRevision: number;
};

export type ChatReplyTarget = {
  messageId: string;
  text: string;
  senderLabel?: string | null;
  sourceMessageId?: string | null;
};

export type ChatGoalDraftMode = { sessionId?: string } & (
  | { action: "start" }
  | { action: "edit"; goalId: string; previousDraft: string }
);

export type ChatGoalDraft = { sessionId?: string } & (
  | { action: "start"; objective: string }
  | { action: "edit"; goalId: string; objective: string }
);

export type ChatGoalAction = "pause" | "resume" | "clear";

export type ChatGoalRecovery = {
  pending: boolean;
  retired?: "expired" | "invalid";
  onCheck: () => Promise<boolean>;
};

export type ChatComposerMemoryFallback = {
  incognito?: boolean;
  awaitingDefaults?: true;
  goalMode?: ChatGoalDraftMode;
  replyTarget?: ChatReplyTarget;
  message: string;
  mentions?: readonly HumanMention[];
  attachments: ChatAttachment[];
  storageFailed: boolean;
  draftRetry?: ChatComposerDraftRetry;
  sequence: number;
};

export type ChatGuardianNotice = {
  key: string;
  runId: string;
  timestamp: number;
  kind: "approved" | "denied" | "reviewing" | "strict-review-required" | "warning";
  source?: "system";
  command?: string;
  riskLevel?: string;
  rationale?: string;
  message?: string;
};

export type ToolApprovalReview = {
  id: string;
  label: string;
  status: "in_progress" | "approved" | "denied" | "timed_out" | "aborted";
  riskLevel?: string;
  userAuthorization?: string;
  rationale?: string;
};

export type ChatQueueDisplayItem = ChatQueueItem & { serverQueued?: true };

export type ChatQueueItem = {
  id: string;
  /** UI question associated with this input; delivery and retry stay outbox-owned. */
  asyncQuestionItemId?: string;
  workContext?: ChatWorkContext;
  workContextUnavailable?: true;
  text: string;
  mentions?: readonly HumanMention[];
  createdAt: number;
  /** Stable arrival position; only an explicit reorder moves an existing input. */
  orderKey?: number;
  /** Immutable bytes belong to this queued input; routing belongs to the outbox metadata. */
  attachmentPayload?: { key: string; recoveryScope: string; tabId: string };
  attachmentStorageError?: "capacity" | "unavailable" | "missing";
  attachments?: ChatAttachment[];
  refreshSessions?: boolean;
  /** Transcript id of the replied-to message; Gateway hydrates reply context. */
  replyToId?: string;
  localCommandArgs?: string;
  localCommandName?: string;
  pendingRunId?: string;
  sendAttempts?: number;
  sendError?: string;
  sendRunId?: string;
  /** One-send override retained with the durable row for reconnect and retry. */
  queueMode?: QueueMode;
  /** Admission intent and its original issue time survive transport retries together. */
  intent?: ChatSendIntent;
  /** For structured admissions, preserve the originally selected session incarnation. */
  sessionId?: string;
  expectedLeafEntryId?: string | null;
  sendState?:
    // Process-local submission handoff; durable custody remains waiting-idle.
    | "submitting"
    | "waiting-model"
    | "waiting-idle"
    | "executing-command"
    | "sending"
    | "waiting-reconnect"
    | "unconfirmed"
    // Provider review requires a new operator decision even if delivery has prior attempts.
    | "held"
    | "failed";
  sendSubmittedAtMs?: number;
  sendRequestStartedAtMs?: number;
  sessionKey?: string;
  agentId?: string;
  sender?: SenderIdentity;
};

/** Union type for items in the chat thread */
export type ChatItem =
  | {
      kind: "message";
      key: string;
      message: unknown;
      duplicateCount?: number;
      /** A distinct input remains a presentation boundary before execution starts. */
      startsTurn?: true;
    }
  | {
      kind: "notice";
      key: string;
      text: string;
      timestamp: number;
      icon?: keyof typeof toolIcons;
      label?: string;
      startsTurn?: true;
      boundaryId?: string;
      tone?: "danger";
      /** Collapse the body behind a disclosure; the label line stays visible. */
      collapsedBody?: true;
    }
  | {
      kind: "divider";
      key: string;
      compaction?: "active" | "complete";
      compactionId?: string;
      label: string;
      icon?: keyof typeof toolIcons;
      metric?: string;
      description?: string;
      timestamp: number;
    }
  | {
      kind: "stream";
      key: string;
      text: string;
      startedAt: number;
      isStreaming: boolean;
      replyToSender?: SenderIdentity;
      replyToMessage?: MessageGroup["replyToMessage"];
      runId?: string;
      boundaryId?: string;
    }
  | {
      kind: "reading-indicator";
      key: string;
      startedAt: number;
      runId?: string;
      boundaryId?: string;
    }
  | { kind: "question"; key: string; questionId: string; startedAt: number };

export type ChatStreamSegment = {
  text: string;
  ts: number;
  runId?: string;
  /** Persisted user send that causally precedes this transient output. */
  afterBoundaryRunId?: string;
  /** Persisted user send that causally follows this transient output. */
  boundaryRunId?: string;
  /** Ordering-only boundary with no renderable assistant text. */
  boundaryMarker?: true;
  /** Hidden durable replacement; cumulative text still owns the prefix baseline. */
  persisted?: true;
  /** Keyed item that consumed this cumulative occurrence; late updates cannot consume another. */
  retiredItemId?: string;
  /** In-flight handoff owned by the retired cumulative prefix, not its live display. */
  pendingCommentary?: { text: string; prefixLength: number };
  toolCallId?: string;
  itemId?: string;
};

export function streamSegmentHasItemId(segment: { itemId?: unknown }): boolean {
  return typeof segment.itemId === "string" && segment.itemId.trim().length > 0;
}

export function streamSegmentUsesAccumulatedText(segment: {
  itemId?: unknown;
  boundaryMarker?: unknown;
}): boolean {
  return segment.boundaryMarker !== true && !streamSegmentHasItemId(segment);
}

/** Advance the accumulated-text tracker only when the segment genuinely
    extends it. A standalone (itemId-less) preamble whose text is not part of
    the cumulative run text must not become the prefix baseline: the next
    cumulative snapshot would fail the startsWith check and re-render every
    earlier segment's text. */
export function advanceAccumulatedStreamText(
  previousText: string | null,
  text: string,
): string | null {
  if (!text.trim()) {
    return previousText;
  }
  return previousText === null || text.startsWith(previousText) ? text : previousText;
}

export function trimAccumulatedStreamPrefix(text: string, previousText: string | null): string {
  if (!previousText || !text.startsWith(previousText)) {
    return text;
  }
  return text.slice(previousText.length).trimStart();
}

export function accumulatedStreamText(
  segments: readonly ChatStreamSegment[],
  normalize: (text: string) => string = (text) => text,
): string | null {
  let accumulated: string | null = null;
  for (const segment of segments) {
    if (streamSegmentUsesAccumulatedText(segment)) {
      accumulated = advanceAccumulatedStreamText(accumulated, normalize(segment.text));
    }
  }
  return accumulated;
}

/** A group of consecutive messages from the same role (Slack-style layout) */
export type MessageGroup = {
  kind: "group";
  key: string;
  role: string;
  senderLabel?: string | null;
  senderSession?: { sessionKey?: string; agentId?: string; label?: string } | null;
  sender?: SenderIdentity;
  sourceClients?: MessageClientSource[];
  replyToSender?: SenderIdentity;
  replyToMessage?: { message: unknown; key: string };
  /** Assistant reply context: more than one person speaks in the conversation. */
  replyShared?: true;
  /** Assistant reply context: the user prompt that opened this turn. */
  replyTurnSource?: { message: unknown; key: string };
  /** Assistant reply context: the prompt that started this run, resolving reply_to_current. */
  replyCurrentSource?: { message: unknown; key: string };
  messages: Array<{
    message: unknown;
    key: string;
    duplicateCount?: number;
    replyTarget?: NormalizedMessage["replyTarget"];
    /** Rendered reply content, excluding assistant thinking tags. */
    hasVisibleContent: boolean;
  }>;
  visibleContent: "none" | "text" | "non-text";
  timestamp: number;
  isStreaming: boolean;
  runId?: string;
};

export type MessageImageSource = {
  url?: string;
  dataUrl?: string;
  preferData?: true;
  mimeType?: string;
  artifactId?: string;
  fileName?: string;
  openUrl?: string;
  alt?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
};

/** Content item types in a normalized message */
export type MessageContentItem =
  | ClawHubRecommendation
  | {
      type: "image";
      sources: MessageImageSource[];
      /** Canonical image blocks consume a persisted inline-layout slot, even if empty. */
      inlineSlot?: true;
      expiresAtMs?: number;
    }
  | {
      type: "text" | "tool_call" | "tool_result";
      text?: string;
      name?: string;
      args?: unknown;
    }
  | {
      type: "thinking";
      thinking: string;
    }
  | {
      type: "omitted_media";
      media: {
        kind: "image";
        sizeBytes?: number;
      };
    }
  | {
      type: "attachment";
      attachment: {
        url: string;
        kind: Exclude<MediaKind, "sticker" | "unknown">;
        label: string;
        mimeType?: string;
        origin?: "paste" | "file";
        isVoiceNote?: boolean;
        artifactId?: string;
        playback?: "native" | "transcode";
        sizeBytes?: number;
        durationMs?: number;
        width?: number;
        height?: number;
      };
    }
  | {
      type: "attachment_error";
      attachment: {
        code: "file-not-found" | "unsupported-format" | "delivery-failed";
        kind: Exclude<MediaKind, "sticker" | "unknown">;
        label: string;
        mimeType?: string;
      };
    }
  | {
      type: "canvas";
      preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>;
      rawText?: string | null;
    };

/** Normalized message structure for rendering */
export type NormalizedMessage = {
  role: string;
  content: MessageContentItem[];
  timestamp: number;
  id?: string;
  senderLabel?: string | null;
  senderSession?: { sessionKey?: string; agentId?: string; label?: string } | null;
  sender?: SenderIdentity;
  sourceClients?: MessageClientSource[];
  audioAsVoice?: boolean;
  replyPreview?: { text: string; senderLabel?: string | null };
  replyTarget?:
    | {
        kind: "current";
      }
    | {
        kind: "id";
        id: string;
      }
    | null;
};

export type ToolOutputMetadata = {
  source: "provider-response" | "execution";
  modelInput: "unverified";
  outcome?: "unknown";
  captureTruncated?: true;
};

/** Tool card representation for inline tool call/result rendering */
export type ToolCard = {
  id: string;
  callId?: string;
  runId?: string;
  parentToolCallId?: string;
  name: string;
  args?: unknown;
  inputText?: string;
  outputText?: string;
  /** Result identity stays distinct from the assistant call after presentation grouping. */
  resultMessageId?: string;
  /** Gateway display projection omitted content; the durable result may still be complete. */
  outputTruncated?: boolean;
  toolOutput?: ToolOutputMetadata;
  /** Structured tool result details (e.g. the edit tool's precomputed diff). */
  details?: unknown;
  /** Monotonic edit counts while a live tool call is still receiving input. */
  liveDiffStat?: { added: number; removed: number };
  /** Producer-reported process exit code, when the result supplies one. */
  exitCode?: number;
  isError?: boolean;
  /** Prepared presentation facts; never replace the raw execution fields above. */
  activity?: AgentActivityItem;
  /** True when the card comes from the live tool stream of the current run. */
  live?: boolean;
  /** True once a result landed, including historical results with empty output. */
  completed?: boolean;
  messageId?: string;
  /** UI-local preview identity for results without a call or transcript id. */
  previewRevision?: string;
  /** Tab actions can identify a route without a previewable page URL. */
  browserTab?: BrowserTabTarget;
  preview?:
    | (NonNullable<ReturnType<typeof extractCanvasFromText>> & { surface: "assistant_message" })
    | (BrowserTabTarget & { kind: "browser-tab"; url: string; title?: string });
};

export type ToolCardOutcome =
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "skipped"
  | "unknown";
