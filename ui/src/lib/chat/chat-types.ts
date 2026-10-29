import type { HumanMention } from "@openclaw/gateway-protocol";
import type { MediaKind } from "@openclaw/media-core/constants";
import type { ChatWorkContext } from "../../../../packages/gateway-protocol/src/chat-work-context.js";
import type { NodePermissionRequest } from "../../../../packages/gateway-protocol/src/node-permissions.js";
import type {
  AgentActivityItem,
  ChatSendIntent,
  QueueMode,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { extractCanvasFromText } from "../../../../src/chat/canvas-render.js";
import type { MessageClientSource } from "../../../../src/chat/message-client-source.js";
import type { ClawHubRecommendation } from "../../../../src/shared/clawhub-recommendations.js";
import type { RunFailureNotice } from "../../../../src/shared/run-failure-notice.js";
import type { SkillWorkshopChangeNotice } from "../../../../src/shared/skill-workshop-change-notice.js";
import type { CyberAccessProgram } from "../../api/types.ts";
import type { BrowserTabTarget } from "../../components/browser/browser-target.ts";
import type { IconName } from "../../components/icon-data.ts";
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

export type DurableComposerDraftScope = {
  gatewayOwner: string;
  recoveryScope: string;
  scopeKey: string;
};

export type DurableChatDraftPresence = { revision: number; active: boolean };

export type DurableQuestionDraft = {
  itemId: string;
  signature: string;
  edited: boolean;
  dismissed?: boolean;
  answers: { selected: string[]; freeText: string }[];
  reopenedAfterBoundary?: string;
};

export type DurableDraftModelSelection = {
  agentId: string;
  model: string;
  agentRuntime?: string;
  thinkingLevel: string;
  cyberAccessProgram?: CyberAccessProgram;
  daybreakAccessProgram?: Exclude<CyberAccessProgram, "standard">;
};

export type DurableComposerDraft = {
  revision: number;
  text: string;
  mentions?: readonly HumanMention[];
  goalMode?: ChatGoalDraftMode;
  replyTarget?: ChatReplyTarget;
  modelSelection?: DurableDraftModelSelection;
  attachments: DurableComposerDraftAttachment[];
  questionDrafts?: DurableQuestionDraft[];
  /** Context-only comments have no uploaded file payload. */
  selectionAnnotations?: ChatSelectionAnnotation[];
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
  goalId?: string;
  action?: ChatGoalAction | "edit" | "replace" | "complete" | "block";
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
  permissionMissing?: NodePermissionRequest;
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

export type { ToolApprovalReview } from "../../../../src/shared/tool-approval-reviews.js";

export type ChatQueueDisplayItem = ChatQueueItem & { serverQueued?: true };

export type ChatQueueItem = {
  id: string;
  /** Captured local storage identity; never a server credential. */
  storageScope?: string;
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
    // Provider review requires a new operator decision even if delivery has prior attempts.
    | "held"
    | "failed";
  sendSubmittedAtMs?: number;
  sendRequestStartedAtMs?: number;
  sessionKey?: string;
  agentId?: string;
  sender?: SenderIdentity;
};

export type ChatItem =
  | {
      kind: "message";
      key: string;
      message: unknown;
      /** A distinct input remains a presentation boundary before execution starts. */
      startsTurn?: true;
    }
  | {
      kind: "notice";
      key: string;
      text: string;
      timestamp: number;
      icon?: IconName;
      label?: string;
      modelChange?: { from: string; to: string };
      startsTurn?: true;
      boundaryId?: string;
      tone?: "danger";
      /** Informational source-owned event eligible for timeline folding. */
      systemEvent?: "info";
      /** Collapse the body behind a disclosure; the label line stays visible. */
      collapsedBody?: true;
      showTimestamp?: true;
      /** Structural only: separates a handed-off run from its resumption. Never rendered. */
      handoffBoundary?: true;
      /** A background skill review's changes; rendered as a native row instead of `text`. */
      skillChanges?: SkillWorkshopChangeNotice;
      runError?: RunFailureNotice;
      /** Total identical failures represented by the latest display notice. */
      repeatCount?: number;
      permissionMissing?: NodePermissionRequest;
      /** Retained cancelled input that may be dismissed. */
      retiredPendingInput?: { id: string; preview: string };
    }
  | {
      kind: "divider";
      key: string;
      compaction?: "active" | "complete";
      compactionId?: string;
      systemEvent?: "info";
      label: string;
      icon?: IconName;
      metric?: string;
      description?: string;
      timestamp: number;
    }
  | {
      kind: "stream";
      key: string;
      text: string;
      thinking?: string;
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
      /** When this status began on the browser clock; no later than `request.askedAt`. */
      startedAt: number;
      /** The run handed off and is idle; its subagents are what is still working. */
      waitingOn?: "subagents";
      /**
       * Set while waiting on or resuming a handoff: when its request was asked,
       * on the transcript's clock, and its handed-off runs, oldest first.
       */
      request?: { askedAt: number; runIds: readonly string[] };
      runId?: string;
      boundaryId?: string;
    }
  | { kind: "question"; key: string; questionId: string; startedAt: number };

export type SystemEventItem = Extract<ChatItem, { kind: "notice" | "divider" }>;
export type SystemEventGroup = {
  kind: "system-event-group";
  key: string;
  events: SystemEventItem[];
};

export type ChatStreamSegment = {
  /** Input observed when live commentary first arrived; omitted for history replay. */
  afterUserSendId?: string;
  text: string;
  ts: number;
  runId?: string;
  /** Hidden durable replacement; cumulative text still owns the prefix baseline. */
  persisted?: true;
  toolCallId?: string;
  itemId?: string;
};

export function streamSegmentHasItemId(segment: Pick<ChatStreamSegment, "itemId">): boolean {
  return Boolean(segment.itemId?.trim());
}

export function streamSegmentUsesAccumulatedText(
  segment: Pick<ChatStreamSegment, "itemId">,
): boolean {
  return !streamSegmentHasItemId(segment);
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
  /** Reply context: more than one person speaks in the conversation. */
  replyShared?: true;
  /** Assistant reply context: the user prompt that opened this turn. */
  replyTurnSource?: { message: unknown; key: string };
  /** Assistant reply context: the prompt that started this run, resolving reply_to_current. */
  replyCurrentSource?: { message: unknown; key: string };
  messages: Array<{
    message: unknown;
    key: string;
    /** Source row for actions when presentation splits a mixed envelope. */
    actionKey?: string;
    /** Original envelope supplies copy/reply/reaction/full-message actions. */
    actionMessage?: unknown;
    /** Only the last visible part of a split envelope owns its source footer. */
    presentationOwnsFooter?: boolean;
    /** Only the last split part publishes the original terminal status. */
    presentationOwnsTerminalStatus?: boolean;
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

export type MessageContentItem =
  | import("../../../../src/shared/plugin-inline-view.js").PluginInlineViewBlock
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
        code: "file-not-found" | "unsupported-format" | "delivery-failed" | "invalid-reference";
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
  /** Bounded external preview; does not authorize full-message recovery. */
  catalogTruncated?: boolean;
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
  | "unrecorded"
  | "unknown";

export type ChatGoalMutationAction = { goalId: string } & (
  | { action: ChatGoalAction }
  | { action: "edit"; objective: string }
  | { action: "replace"; objective: string; expectedRunId: string; expectedGoalUpdatedAt: number }
);
