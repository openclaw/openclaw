import type { AcpRuntimeEvent, AcpSessionUpdateTag } from "@openclaw/acp-core/runtime/types";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveAcpToolTerminalOutcome } from "../../acp/tool-status.js";
import { EmbeddedBlockChunker } from "../../agents/embedded-agent-block-chunker.js";
import { createVerifiedConversationContextStreamFilter } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import { formatToolSummary, resolveToolDisplay } from "../../agents/tool-display.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prefixSystemMessage } from "../../infra/system-message.js";
import { truncateUtf16WithEllipsis as truncateText } from "../../shared/text-truncate.js";
import type { ReplyPayload } from "../types.js";
import {
  isAcpTagVisible,
  resolveAcpProjectionSettings,
  resolveAcpStreamingConfig,
} from "./acp-stream-settings.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import type { AcpDispatchDeliveryMeta } from "./dispatch-acp-delivery.types.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";

const ACP_BLOCK_REPLY_TIMEOUT_MS = 15_000;
const ACP_LIVE_IDLE_FLUSH_FLOOR_MS = 750;
const ACP_LIVE_IDLE_MIN_CHARS = 80;
const ACP_LIVE_SOFT_FLUSH_CHARS = 220;
const ACP_LIVE_HARD_FLUSH_CHARS = 480;

const HIDDEN_BOUNDARY_TAGS = new Set<AcpSessionUpdateTag>(["tool_call", "tool_call_update"]);

type ToolLifecycleState = {
  started: boolean;
  terminal: boolean;
  lastRenderedHash?: string;
};

type BufferedToolDelivery = {
  payload: ReplyPayload;
  meta?: AcpDispatchDeliveryMeta;
};

function shouldInsertSeparator(params: {
  separator: " " | "\n\n";
  previousTail: string | undefined;
  nextText: string;
}): boolean {
  if (!params.previousTail || /^\s/.test(params.nextText)) {
    return false;
  }
  return params.separator === " "
    ? !/\s$/.test(params.previousTail)
    : !params.previousTail.endsWith("\n");
}

function shouldFlushLiveBufferOnBoundary(text: string): boolean {
  return (
    text.length >= ACP_LIVE_HARD_FLUSH_CHARS ||
    text.endsWith("\n\n") ||
    /[.!?][)"'`]*\s$/.test(text) ||
    (text.length >= ACP_LIVE_SOFT_FLUSH_CHARS && /\s$/.test(text))
  );
}

function shouldFlushLiveBufferOnIdle(text: string): boolean {
  return (
    text.length >= ACP_LIVE_IDLE_MIN_CHARS ||
    /[.!?][)"'`]*$/.test(text.trimEnd()) ||
    text.includes("\n")
  );
}

function renderToolSummaryText(
  event: Extract<AcpRuntimeEvent, { type: "tool_call" }>,
  shouldSendFullToolDetails: boolean,
): string {
  const detailParts: string[] = [];
  const commandBearing = normalizeOptionalLowercaseString(event.kind) === "execute";
  const title =
    shouldSendFullToolDetails || !commandBearing ? normalizeOptionalString(event.title) : undefined;
  if (title) {
    detailParts.push(title);
  }
  const status = normalizeOptionalString(event.status);
  if (status) {
    detailParts.push(`status=${status}`);
  }
  const fallback =
    shouldSendFullToolDetails || !commandBearing ? normalizeOptionalString(event.text) : undefined;
  if (detailParts.length === 0 && fallback) {
    detailParts.push(fallback);
  }
  const display = resolveToolDisplay({
    name: "tool_call",
    meta: detailParts.join(" · ") || "tool call",
  });
  return formatToolSummary(display);
}

export function createAcpReplyProjector(params: {
  cfg: OpenClawConfig;
  shouldSendToolSummaries: boolean;
  shouldSendToolSummariesNow?: () => boolean;
  shouldSendFullToolDetails: boolean;
  deliver: (
    kind: ReplyDispatchKind,
    payload: ReplyPayload,
    meta?: AcpDispatchDeliveryMeta,
  ) => Promise<boolean>;
  getConversationContext?: () => string | undefined;
  onProgress?: () => void;
  provider?: string;
  accountId?: string;
}) {
  const settings = resolveAcpProjectionSettings(params.cfg);
  const hiddenBoundarySeparator = settings.hiddenBoundarySeparator === "space" ? " " : "\n\n";
  const streaming = resolveAcpStreamingConfig({
    cfg: params.cfg,
    provider: params.provider,
    accountId: params.accountId,
    deliveryMode: settings.deliveryMode,
  });
  const blockReplyPipeline = createBlockReplyPipeline({
    onBlockReply: async (payload) => {
      await params.deliver("block", payload);
    },
    timeoutMs: ACP_BLOCK_REPLY_TIMEOUT_MS,
    coalescing: settings.deliveryMode === "live" ? undefined : streaming.coalescing,
  });
  const chunker = new EmbeddedBlockChunker(streaming.chunking);
  const filterConversationContext = createVerifiedConversationContextStreamFilter(
    params.getConversationContext,
  );
  const liveIdleFlushMs = Math.max(streaming.coalescing.idleMs, ACP_LIVE_IDLE_FLUSH_FLOOR_MS);

  let emittedOutputChars = 0;
  let truncationNoticeEmitted = false;
  let lastStatusHash: string | undefined;
  let lastToolHash: string | undefined;
  let lastUsageTuple: string | undefined;
  let lastVisibleOutputTail: string | undefined;
  let pendingHiddenBoundary = false;
  let liveBufferText = "";
  let finalOnlyOutputText = "";
  let liveIdleTimer: NodeJS.Timeout | undefined;
  const pendingToolDeliveries: BufferedToolDelivery[] = [];
  const toolLifecycleById = new Map<string, ToolLifecycleState>();

  const shouldSendToolSummaries = () =>
    params.shouldSendToolSummariesNow?.() ?? params.shouldSendToolSummaries;

  const clearLiveIdleTimer = () => {
    if (!liveIdleTimer) {
      return;
    }
    clearTimeout(liveIdleTimer);
    liveIdleTimer = undefined;
  };

  const drainChunker = () => {
    chunker.drain({
      force: true,
      emit: (chunk) => {
        blockReplyPipeline.enqueue({ text: chunk });
      },
    });
  };

  const flushLiveBuffer = (idle = false) => {
    if (settings.deliveryMode !== "live" || !liveBufferText) {
      return;
    }
    if (idle && !shouldFlushLiveBufferOnIdle(liveBufferText)) {
      return;
    }
    const text = liveBufferText;
    liveBufferText = "";
    chunker.append(text);
    drainChunker();
  };

  const scheduleLiveIdleFlush = () => {
    if (settings.deliveryMode !== "live" || !liveBufferText) {
      return;
    }
    clearLiveIdleTimer();
    liveIdleTimer = setTimeout(() => {
      flushLiveBuffer(true);
      if (liveBufferText) {
        scheduleLiveIdleFlush();
      }
    }, liveIdleFlushMs);
  };

  const flush = async (): Promise<void> => {
    if (settings.deliveryMode === "live") {
      clearLiveIdleTimer();
      flushLiveBuffer();
    }
    if (settings.deliveryMode === "final_only") {
      if (shouldSendToolSummaries()) {
        for (const entry of pendingToolDeliveries.splice(0)) {
          await params.deliver("tool", entry.payload, entry.meta);
        }
      } else {
        pendingToolDeliveries.length = 0;
      }
      if (finalOnlyOutputText.trim().length > 0) {
        const text = finalOnlyOutputText;
        finalOnlyOutputText = "";
        await params.deliver("final", { text });
      }
    } else {
      drainChunker();
    }
    await blockReplyPipeline.flush({ force: true });
  };

  const emitSystemStatus = async (text: string, opts?: { dedupe?: boolean }) => {
    if (!shouldSendToolSummaries()) {
      return;
    }
    const bounded = truncateText(text.trim(), settings.maxSessionUpdateChars);
    if (!bounded) {
      return;
    }
    const formatted = prefixSystemMessage(bounded);
    const hash = formatted.trim();
    const shouldDedupe = settings.repeatSuppression && opts?.dedupe !== false;
    if (shouldDedupe && lastStatusHash === hash) {
      return;
    }
    if (settings.deliveryMode === "final_only") {
      pendingToolDeliveries.push({
        payload: { text: formatted },
      });
    } else {
      await flush();
      await params.deliver("tool", { text: formatted });
    }
    lastStatusHash = hash;
  };

  const markHiddenToolBoundary = (event: Extract<AcpRuntimeEvent, { type: "tool_call" }>) => {
    if (!event.tag || !HIDDEN_BOUNDARY_TAGS.has(event.tag)) {
      return;
    }
    const isTerminal = resolveAcpToolTerminalOutcome(event.status) !== undefined;
    pendingHiddenBoundary = pendingHiddenBoundary || event.tag === "tool_call" || isTerminal;
  };

  const emitToolSummary = async (event: Extract<AcpRuntimeEvent, { type: "tool_call" }>) => {
    if (!shouldSendToolSummaries()) {
      markHiddenToolBoundary(event);
      return;
    }
    const renderedToolSummary = renderToolSummaryText(event, params.shouldSendFullToolDetails);
    const toolSummary = truncateText(renderedToolSummary, settings.maxSessionUpdateChars);
    const hash = renderedToolSummary.trim();
    const toolCallId = normalizeOptionalString(event.toolCallId);
    const status = normalizeOptionalLowercaseString(event.status);
    const isTerminal = resolveAcpToolTerminalOutcome(status) !== undefined;
    const isStart = status === "in_progress" || event.tag === "tool_call";

    if (settings.repeatSuppression) {
      if (toolCallId) {
        const state = toolLifecycleById.get(toolCallId) ?? {
          started: false,
          terminal: false,
        };
        if (
          (isTerminal && state.terminal) ||
          (isStart && state.started) ||
          state.lastRenderedHash === hash
        ) {
          return;
        }
        state.started ||= isStart;
        state.terminal ||= isTerminal;
        state.lastRenderedHash = hash;
        toolLifecycleById.set(toolCallId, state);
      } else if (lastToolHash === hash) {
        return;
      }
    }

    const deliveryMeta: AcpDispatchDeliveryMeta = {
      ...(toolCallId ? { toolCallId } : {}),
      allowEdit: Boolean(toolCallId && event.tag === "tool_call_update"),
    };
    if (settings.deliveryMode === "final_only") {
      pendingToolDeliveries.push({
        payload: { text: toolSummary },
        meta: deliveryMeta,
      });
      markHiddenToolBoundary(event);
    } else {
      await flush();
      await params.deliver("tool", { text: toolSummary }, deliveryMeta);
    }
    lastToolHash = hash;
  };

  const emitTruncationNotice = async () => {
    if (truncationNoticeEmitted) {
      return;
    }
    truncationNoticeEmitted = true;
    await emitSystemStatus("output truncated", { dedupe: false });
  };

  // One projector serves one dispatch; terminal settlement belongs to tryDispatchAcpReply.
  const onEvent = async (event: AcpRuntimeEvent): Promise<void> => {
    params.onProgress?.();
    if (event.type === "text_delta") {
      if (event.stream && event.stream !== "output") {
        return;
      }
      if (!isAcpTagVisible(settings, event.tag)) {
        return;
      }
      let text = event.text;
      if (!text) {
        return;
      }
      if (
        pendingHiddenBoundary &&
        shouldInsertSeparator({
          separator: hiddenBoundarySeparator,
          previousTail: lastVisibleOutputTail,
          nextText: text,
        })
      ) {
        text = `${hiddenBoundarySeparator}${text}`;
      }
      pendingHiddenBoundary = false;
      if (emittedOutputChars >= settings.maxOutputChars) {
        await emitTruncationNotice();
        return;
      }
      const remaining = settings.maxOutputChars - emittedOutputChars;
      const accepted = remaining < text.length ? truncateUtf16Safe(text, remaining) : text;
      if (accepted.length > 0) {
        emittedOutputChars += accepted.length;
        const safeText = filterConversationContext(accepted);
        lastVisibleOutputTail = safeText.slice(-1) || lastVisibleOutputTail;
        if (settings.deliveryMode === "live") {
          liveBufferText += safeText;
          if (shouldFlushLiveBufferOnBoundary(liveBufferText)) {
            clearLiveIdleTimer();
            flushLiveBuffer();
          } else {
            scheduleLiveIdleFlush();
          }
        } else {
          finalOnlyOutputText += safeText;
        }
      }
      if (accepted.length < text.length) {
        // A split code point can leave the accepted prefix shorter than the remaining budget.
        // Exhaust it after any drop so later deltas cannot skip past omitted text.
        emittedOutputChars = settings.maxOutputChars;
        await emitTruncationNotice();
      }
      return;
    }

    if (event.type === "status") {
      if (!isAcpTagVisible(settings, event.tag)) {
        return;
      }
      if (event.tag === "usage_update" && settings.repeatSuppression) {
        const usageTuple =
          typeof event.used === "number" && typeof event.size === "number"
            ? `${event.used}/${event.size}`
            : event.text.trim();
        if (usageTuple === lastUsageTuple) {
          return;
        }
        lastUsageTuple = usageTuple;
      }
      await emitSystemStatus(event.text);
      return;
    }

    if (event.type === "tool_call") {
      if (!isAcpTagVisible(settings, event.tag)) {
        markHiddenToolBoundary(event);
        return;
      }
      await emitToolSummary(event);
    }
  };

  return {
    onEvent,
    flush,
  };
}
