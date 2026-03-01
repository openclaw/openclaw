import type { AcpRuntimeEvent, AcpSessionUpdateTag } from "../../acp/runtime/types.js";
import { EmbeddedBlockChunker } from "../../agents/pi-embedded-block-chunker.js";
import { formatToolSummary, resolveToolDisplay } from "../../agents/tool-display.js";
import type { OpenClawConfig } from "../../config/config.js";
import { prefixSystemMessage } from "../../infra/system-message.js";
import type { ReplyPayload } from "../types.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { resolveEffectiveBlockStreamingConfig } from "./block-streaming.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.js";

const DEFAULT_ACP_STREAM_COALESCE_IDLE_MS = 350;
const DEFAULT_ACP_STREAM_MAX_CHUNK_CHARS = 1800;
const DEFAULT_ACP_META_MODE = "minimal";
const DEFAULT_ACP_SHOW_USAGE = false;
const DEFAULT_ACP_DELIVERY_MODE = "live";
const DEFAULT_ACP_MAX_TURN_CHARS = 24_000;
const DEFAULT_ACP_MAX_TOOL_SUMMARY_CHARS = 320;
const DEFAULT_ACP_MAX_STATUS_CHARS = 320;
const DEFAULT_ACP_MAX_META_EVENTS_PER_TURN = 64;
const ACP_BLOCK_REPLY_TIMEOUT_MS = 15_000;

const ACP_TAG_VISIBILITY_DEFAULTS: Record<string, boolean> = {
  agent_message_chunk: true,
  tool_call: true,
  tool_call_update: true,
  usage_update: false,
  available_commands_update: false,
  current_mode_update: false,
  config_option_update: false,
  session_info_update: false,
  plan: false,
  agent_thought_chunk: false,
};

const TERMINAL_TOOL_STATUSES = new Set(["completed", "failed", "cancelled", "done", "error"]);

export type AcpProjectedDeliveryMeta = {
  tag?: AcpSessionUpdateTag;
  toolCallId?: string;
  toolStatus?: string;
  allowEdit?: boolean;
};

type AcpDeliveryMode = "live" | "final_only";
type AcpMetaMode = "off" | "minimal" | "verbose";

type AcpProjectionSettings = {
  deliveryMode: AcpDeliveryMode;
  metaMode: AcpMetaMode;
  showUsage: boolean;
  maxTurnChars: number;
  maxToolSummaryChars: number;
  maxStatusChars: number;
  maxMetaEventsPerTurn: number;
  tagVisibility: Partial<Record<AcpSessionUpdateTag, boolean>>;
};

type ToolLifecycleState = {
  started: boolean;
  terminal: boolean;
  lastRenderedHash?: string;
};

function clampPositiveInteger(
  value: unknown,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  if (rounded < bounds.min) {
    return bounds.min;
  }
  if (rounded > bounds.max) {
    return bounds.max;
  }
  return rounded;
}

function clampBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resolveAcpDeliveryMode(value: unknown): AcpDeliveryMode {
  return value === "final_only" ? "final_only" : DEFAULT_ACP_DELIVERY_MODE;
}

function resolveAcpMetaMode(value: unknown): AcpMetaMode {
  if (value === "off" || value === "minimal" || value === "verbose") {
    return value;
  }
  return DEFAULT_ACP_META_MODE;
}

function resolveAcpStreamCoalesceIdleMs(cfg: OpenClawConfig): number {
  return clampPositiveInteger(
    cfg.acp?.stream?.coalesceIdleMs,
    DEFAULT_ACP_STREAM_COALESCE_IDLE_MS,
    {
      min: 0,
      max: 5_000,
    },
  );
}

function resolveAcpStreamMaxChunkChars(cfg: OpenClawConfig): number {
  return clampPositiveInteger(cfg.acp?.stream?.maxChunkChars, DEFAULT_ACP_STREAM_MAX_CHUNK_CHARS, {
    min: 50,
    max: 4_000,
  });
}

function resolveAcpProjectionSettings(cfg: OpenClawConfig): AcpProjectionSettings {
  const stream = cfg.acp?.stream;
  return {
    deliveryMode: resolveAcpDeliveryMode(stream?.deliveryMode),
    metaMode: resolveAcpMetaMode(stream?.metaMode),
    showUsage: clampBoolean(stream?.showUsage, DEFAULT_ACP_SHOW_USAGE),
    maxTurnChars: clampPositiveInteger(stream?.maxTurnChars, DEFAULT_ACP_MAX_TURN_CHARS, {
      min: 1,
      max: 500_000,
    }),
    maxToolSummaryChars: clampPositiveInteger(
      stream?.maxToolSummaryChars,
      DEFAULT_ACP_MAX_TOOL_SUMMARY_CHARS,
      {
        min: 64,
        max: 8_000,
      },
    ),
    maxStatusChars: clampPositiveInteger(stream?.maxStatusChars, DEFAULT_ACP_MAX_STATUS_CHARS, {
      min: 64,
      max: 8_000,
    }),
    maxMetaEventsPerTurn: clampPositiveInteger(
      stream?.maxMetaEventsPerTurn,
      DEFAULT_ACP_MAX_META_EVENTS_PER_TURN,
      {
        min: 1,
        max: 2_000,
      },
    ),
    tagVisibility: stream?.tagVisibility ?? {},
  };
}

function resolveAcpStreamingConfig(params: {
  cfg: OpenClawConfig;
  provider?: string;
  accountId?: string;
}) {
  return resolveEffectiveBlockStreamingConfig({
    cfg: params.cfg,
    provider: params.provider,
    accountId: params.accountId,
    maxChunkChars: resolveAcpStreamMaxChunkChars(params.cfg),
    coalesceIdleMs: resolveAcpStreamCoalesceIdleMs(params.cfg),
  });
}

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

function isTagVisible(
  settings: AcpProjectionSettings,
  tag: AcpSessionUpdateTag | undefined,
): boolean {
  if (!tag) {
    return true;
  }
  const override = settings.tagVisibility[tag];
  if (typeof override === "boolean") {
    return override;
  }
  if (Object.prototype.hasOwnProperty.call(ACP_TAG_VISIBILITY_DEFAULTS, tag)) {
    return ACP_TAG_VISIBILITY_DEFAULTS[tag];
  }
  return true;
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
  const toolLifecycleById = new Map<string, ToolLifecycleState>();

  const resetTurnState = () => {
    emittedTurnChars = 0;
    emittedMetaEvents = 0;
    truncationNoticeEmitted = false;
    lastStatusHash = undefined;
    lastToolHash = undefined;
    lastUsageTuple = undefined;
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

  const flush = async (force = false): Promise<void> => {
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
    if (settings.metaMode === "off" && opts?.force !== true) {
      return;
    }
    const bounded = truncateText(text.trim(), settings.maxStatusChars);
    if (!bounded) {
      return;
    }
    const formatted = prefixSystemMessage(bounded);
    const hash = hashText(formatted);
    const shouldDedupe = opts?.dedupe !== false;
    if (shouldDedupe && lastStatusHash === hash) {
      return;
    }
    if (!consumeMetaQuota(opts?.force === true)) {
      return;
    }
    if (settings.deliveryMode === "live") {
      await flush(true);
    }
    await params.deliver("tool", { text: formatted }, meta);
    lastStatusHash = hash;
  };

  const emitToolSummary = async (
    event: Extract<AcpRuntimeEvent, { type: "tool_call" }>,
    opts?: { force?: boolean },
  ) => {
    if (!params.shouldSendToolSummaries || settings.metaMode === "off") {
      return;
    }
    if (!isTagVisible(settings, event.tag)) {
      return;
    }

    const toolSummary = truncateText(renderToolSummaryText(event), settings.maxToolSummaryChars);
    const hash = hashText(toolSummary);
    const toolCallId = event.toolCallId?.trim() || undefined;
    const status = normalizeToolStatus(event.status);
    const isTerminal = status ? TERMINAL_TOOL_STATUSES.has(status) : false;
    const isStart = status === "in_progress" || event.tag === "tool_call";

    if (settings.metaMode === "verbose") {
      if (lastToolHash === hash) {
        return;
      }
    } else if (settings.metaMode === "minimal") {
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
    if (settings.deliveryMode === "live") {
      await flush(true);
    }
    await params.deliver(
      "tool",
      { text: toolSummary },
      {
        ...(event.tag ? { tag: event.tag } : {}),
        ...(toolCallId ? { toolCallId } : {}),
        ...(status ? { toolStatus: status } : {}),
        allowEdit: Boolean(toolCallId && event.tag === "tool_call_update"),
      },
    );
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
      if (!isTagVisible(settings, event.tag)) {
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
      if (!isTagVisible(settings, event.tag)) {
        return;
      }
      if (event.tag === "usage_update") {
        if (!settings.showUsage) {
          return;
        }
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
