import type { AcpRuntimeEvent, AcpSessionUpdateTag } from "../../acp/runtime/types.js";
import { EmbeddedBlockChunker } from "../../agents/pi-embedded-block-chunker.js";
import { formatToolSummary, resolveToolDisplay } from "../../agents/tool-display.js";
import type { OpenClawConfig } from "../../config/config.js";
import { prefixSystemMessage } from "../../infra/system-message.js";
import type { ReplyPayload } from "../types.js";
import {
  isAcpTagVisible,
  resolveAcpProjectionSettings,
  resolveAcpStreamingConfig,
} from "./acp-stream-settings.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.js";

const ACP_BLOCK_REPLY_TIMEOUT_MS = 15_000;

const TERMINAL_TOOL_STATUSES = new Set(["completed", "failed", "cancelled", "done", "error"]);

export type AcpProjectedDeliveryMeta = {
  tag?: AcpSessionUpdateTag;
  toolCallId?: string;
  toolStatus?: string;
  allowEdit?: boolean;
};

type ToolLifecycleState = {
  started: boolean;
  terminal: boolean;
  lastRenderedHash?: string;
};

type BufferedToolDelivery = {
  payload: ReplyPayload;
  meta?: AcpProjectedDeliveryMeta;
};

function truncateText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  if (maxChars <= 1) {
    return input.slice(0, maxChars);
  }
  return `${input.slice(0, maxChars - 1)}…`;
}

function hashText(text: string): string {
  return text.trim();
}

function normalizeToolStatus(status: string | undefined): string | undefined {
  if (!status) {
    return undefined;
  }
  const normalized = status.trim().toLowerCase();
  return normalized || undefined;
}

function renderToolSummaryText(event: Extract<AcpRuntimeEvent, { type: "tool_call" }>): string {
  const detailParts: string[] = [];
  const title = event.title?.trim();
  if (title) {
    detailParts.push(title);
  }
  const status = event.status?.trim();
  if (status) {
    detailParts.push(`status=${status}`);
  }
  const fallback = event.text?.trim();
  if (detailParts.length === 0 && fallback) {
    detailParts.push(fallback);
  }
  const display = resolveToolDisplay({
    name: "tool_call",
    meta: detailParts.join(" · ") || "tool call",
  });
  return formatToolSummary(display);
}

export type AcpReplyProjector = {
  onEvent: (event: AcpRuntimeEvent) => Promise<void>;
  flush: (force?: boolean) => Promise<void>;
};

export function createAcpReplyProjector(params: {
  cfg: OpenClawConfig;
  shouldSendToolSummaries: boolean;
  deliver: (
    kind: ReplyDispatchKind,
    payload: ReplyPayload,
    meta?: AcpProjectedDeliveryMeta,
  ) => Promise<boolean>;
  provider?: string;
  accountId?: string;
}): AcpReplyProjector {
  const settings = resolveAcpProjectionSettings(params.cfg);
  const streaming = resolveAcpStreamingConfig({
    cfg: params.cfg,
    provider: params.provider,
    accountId: params.accountId,
  });
  const blockReplyPipeline = createBlockReplyPipeline({
    onBlockReply: async (payload) => {
      await params.deliver("block", payload);
    },
    timeoutMs: ACP_BLOCK_REPLY_TIMEOUT_MS,
    coalescing: streaming.coalescing,
  });
  const chunker = new EmbeddedBlockChunker(streaming.chunking);

  let emittedTurnChars = 0;
  let emittedMetaEvents = 0;
  let truncationNoticeEmitted = false;
  let lastStatusHash: string | undefined;
  let lastToolHash: string | undefined;
  let lastUsageTuple: string | undefined;
  const pendingToolDeliveries: BufferedToolDelivery[] = [];
  const toolLifecycleById = new Map<string, ToolLifecycleState>();

  const resetTurnState = () => {
    emittedTurnChars = 0;
    emittedMetaEvents = 0;
    truncationNoticeEmitted = false;
    lastStatusHash = undefined;
    lastToolHash = undefined;
    lastUsageTuple = undefined;
    pendingToolDeliveries.length = 0;
    toolLifecycleById.clear();
  };

  const drainChunker = (force: boolean) => {
    if (settings.deliveryMode === "final_only" && !force) {
      return;
    }
    chunker.drain({
      force,
      emit: (chunk) => {
        blockReplyPipeline.enqueue({ text: chunk });
      },
    });
  };

  const flushBufferedToolDeliveries = async (force: boolean) => {
    if (!(settings.deliveryMode === "final_only" && force)) {
      return;
    }
    for (const entry of pendingToolDeliveries.splice(0, pendingToolDeliveries.length)) {
      await params.deliver("tool", entry.payload, entry.meta);
    }
  };

  const flush = async (force = false): Promise<void> => {
    await flushBufferedToolDeliveries(force);
    drainChunker(force);
    await blockReplyPipeline.flush({ force });
  };

  const consumeMetaQuota = (force: boolean): boolean => {
    if (force) {
      return true;
    }
    if (emittedMetaEvents >= settings.maxMetaEventsPerTurn) {
      return false;
    }
    emittedMetaEvents += 1;
    return true;
  };

  const emitSystemStatus = async (
    text: string,
    meta?: AcpProjectedDeliveryMeta,
    opts?: { force?: boolean; dedupe?: boolean },
  ) => {
    if (!params.shouldSendToolSummaries) {
      return;
    }
    const bounded = truncateText(text.trim(), settings.maxStatusChars);
    if (!bounded) {
      return;
    }
    const formatted = prefixSystemMessage(bounded);
    const hash = hashText(formatted);
    const shouldDedupe = settings.repeatSuppression && opts?.dedupe !== false;
    if (shouldDedupe && lastStatusHash === hash) {
      return;
    }
    if (!consumeMetaQuota(opts?.force === true)) {
      return;
    }
    if (settings.deliveryMode === "final_only") {
      pendingToolDeliveries.push({
        payload: { text: formatted },
        meta,
      });
    } else {
      await flush(true);
      await params.deliver("tool", { text: formatted }, meta);
    }
    lastStatusHash = hash;
  };

  const emitToolSummary = async (
    event: Extract<AcpRuntimeEvent, { type: "tool_call" }>,
    opts?: { force?: boolean },
  ) => {
    if (!params.shouldSendToolSummaries) {
      return;
    }
    if (!isAcpTagVisible(settings, event.tag)) {
      return;
    }

    const toolSummary = truncateText(renderToolSummaryText(event), settings.maxToolSummaryChars);
    const hash = hashText(toolSummary);
    const toolCallId = event.toolCallId?.trim() || undefined;
    const status = normalizeToolStatus(event.status);
    const isTerminal = status ? TERMINAL_TOOL_STATUSES.has(status) : false;
    const isStart = status === "in_progress" || event.tag === "tool_call";

    if (settings.repeatSuppression) {
      if (toolCallId) {
        const state = toolLifecycleById.get(toolCallId) ?? {
          started: false,
          terminal: false,
        };
        if (isTerminal && state.terminal) {
          return;
        }
        if (isStart && state.started) {
          return;
        }
        if (state.lastRenderedHash === hash) {
          return;
        }
        if (isStart) {
          state.started = true;
        }
        if (isTerminal) {
          state.terminal = true;
        }
        state.lastRenderedHash = hash;
        toolLifecycleById.set(toolCallId, state);
      } else if (lastToolHash === hash) {
        return;
      }
    }

    if (!consumeMetaQuota(opts?.force === true)) {
      return;
    }
    const deliveryMeta: AcpProjectedDeliveryMeta = {
      ...(event.tag ? { tag: event.tag } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(status ? { toolStatus: status } : {}),
      allowEdit: Boolean(toolCallId && event.tag === "tool_call_update"),
    };
    if (settings.deliveryMode === "final_only") {
      pendingToolDeliveries.push({
        payload: { text: toolSummary },
        meta: deliveryMeta,
      });
    } else {
      await flush(true);
      await params.deliver("tool", { text: toolSummary }, deliveryMeta);
    }
    lastToolHash = hash;
  };

  const emitTruncationNotice = async () => {
    if (truncationNoticeEmitted) {
      return;
    }
    truncationNoticeEmitted = true;
    await emitSystemStatus(
      "output truncated",
      {
        tag: "session_info_update",
      },
      {
        force: true,
        dedupe: false,
      },
    );
  };

  const onEvent = async (event: AcpRuntimeEvent): Promise<void> => {
    if (event.type === "text_delta") {
      if (event.stream && event.stream !== "output") {
        return;
      }
      if (!isAcpTagVisible(settings, event.tag)) {
        return;
      }
      const text = event.text;
      if (!text) {
        return;
      }
      if (emittedTurnChars >= settings.maxTurnChars) {
        await emitTruncationNotice();
        return;
      }
      const remaining = settings.maxTurnChars - emittedTurnChars;
      const accepted = remaining < text.length ? text.slice(0, remaining) : text;
      if (accepted.length > 0) {
        chunker.append(accepted);
        emittedTurnChars += accepted.length;
        drainChunker(false);
      }
      if (accepted.length < text.length) {
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
            : hashText(event.text);
        if (usageTuple === lastUsageTuple) {
          return;
        }
        lastUsageTuple = usageTuple;
      }
      await emitSystemStatus(event.text, event.tag ? { tag: event.tag } : undefined, {
        dedupe: true,
      });
      return;
    }

    if (event.type === "tool_call") {
      await emitToolSummary(event);
      return;
    }

    if (event.type === "done" || event.type === "error") {
      await flush(true);
      resetTurnState();
    }
  };

  return {
    onEvent,
    flush,
  };
}
