import {
  chunkByParagraph,
  chunkMarkdownTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { resolveChannelMediaMaxBytes } from "../../channels/plugins/media-limits.js";
import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import type {
  ChannelOutboundAdapter,
  ChannelOutboundContext,
} from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveMarkdownTableMode } from "../../config/markdown-tables.js";
import {
  appendAssistantMessageToSessionTranscript,
  resolveMirroredTranscriptText,
} from "../../config/sessions.js";
import type { sendMessageDiscord } from "../../discord/send.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import type { sendMessageIMessage } from "../../imessage/send.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { markdownToSignalTextChunks, type SignalTextStyleRange } from "../../signal/format.js";
import { sendMessageSignal } from "../../signal/send.js";
import type { sendMessageSlack } from "../../slack/send.js";
import type { sendMessageTelegram } from "../../telegram/send.js";
import type { sendMessageWhatsApp } from "../../web/outbound.js";
import { throwIfAborted } from "./abort.js";
import { ackDelivery, enqueueDelivery, failDelivery } from "./delivery-queue.js";
import type { OutboundIdentity } from "./identity.js";
import type { NormalizedOutboundPayload } from "./payloads.js";
import { normalizeReplyPayloadsForDelivery } from "./payloads.js";
import type { OutboundChannel } from "./targets.js";

export type { NormalizedOutboundPayload } from "./payloads.js";
export { normalizeOutboundPayloads } from "./payloads.js";

type SendMatrixMessage = (
  to: string,
  text: string,
  opts?: { mediaUrl?: string; replyToId?: string; threadId?: string; timeoutMs?: number },
) => Promise<{ messageId: string; roomId: string }>;

export type OutboundSendDeps = {
  sendWhatsApp?: typeof sendMessageWhatsApp;
  sendTelegram?: typeof sendMessageTelegram;
  sendDiscord?: typeof sendMessageDiscord;
  sendSlack?: typeof sendMessageSlack;
  sendSignal?: typeof sendMessageSignal;
  sendIMessage?: typeof sendMessageIMessage;
  sendMatrix?: SendMatrixMessage;
  sendMSTeams?: (
    to: string,
    text: string,
    opts?: { mediaUrl?: string },
  ) => Promise<{ messageId: string; conversationId: string }>;
};

export type OutboundDeliveryResult = {
  channel: Exclude<OutboundChannel, "none">;
  messageId: string;
  chatId?: string;
  channelId?: string;
  roomId?: string;
  conversationId?: string;
  timestamp?: number;
  toJid?: string;
  pollId?: string;
  // Channel docking: stash channel-specific fields here to avoid core type churn.
  meta?: Record<string, unknown>;
};

type Chunker = (text: string, limit: number) => string[];

type ChannelHandler = {
  chunker: Chunker | null;
  chunkerMode?: "text" | "markdown";
  textChunkLimit?: number;
  sendPayload?: (
    payload: ReplyPayload,
    overrides?: {
      replyToId?: string | null;
      threadId?: string | number | null;
    },
  ) => Promise<OutboundDeliveryResult>;
  sendText: (
    text: string,
    overrides?: {
      replyToId?: string | null;
      threadId?: string | number | null;
    },
  ) => Promise<OutboundDeliveryResult>;
  sendMedia: (
    caption: string,
    mediaUrl: string,
    overrides?: {
      replyToId?: string | null;
      threadId?: string | number | null;
    },
  ) => Promise<OutboundDeliveryResult>;
};

type ChannelHandlerParams = {
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  replyToId?: string | null;
  threadId?: string | number | null;
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
  silent?: boolean;
  mediaLocalRoots?: readonly string[];
};

// Channel docking: outbound delivery delegates to plugin.outbound adapters.
async function createChannelHandler(params: ChannelHandlerParams): Promise<ChannelHandler> {
  const outbound = await loadChannelOutboundAdapter(params.channel);
  const handler = createPluginHandler({ ...params, outbound });
  if (!handler) {
    throw new Error(`Outbound not configured for channel: ${params.channel}`);
  }
  return handler;
}

function createPluginHandler(
  params: ChannelHandlerParams & { outbound?: ChannelOutboundAdapter },
): ChannelHandler | null {
  const outbound = params.outbound;
  if (!outbound?.sendText || !outbound?.sendMedia) {
    return null;
  }
  const baseCtx = createChannelOutboundContextBase(params);
  const sendText = outbound.sendText;
  const sendMedia = outbound.sendMedia;
  const chunker = outbound.chunker ?? null;
  const chunkerMode = outbound.chunkerMode;
  const resolveCtx = (overrides?: {
    replyToId?: string | null;
    threadId?: string | number | null;
  }): Omit<ChannelOutboundContext, "text" | "mediaUrl"> => ({
    ...baseCtx,
    replyToId: overrides?.replyToId ?? baseCtx.replyToId,
    threadId: overrides?.threadId ?? baseCtx.threadId,
  });
  return {
    chunker,
    chunkerMode,
    textChunkLimit: outbound.textChunkLimit,
    sendPayload: outbound.sendPayload
      ? async (payload, overrides) =>
          outbound.sendPayload!({
            ...resolveCtx(overrides),
            text: payload.text ?? "",
            mediaUrl: payload.mediaUrl,
            payload,
          })
      : undefined,
    sendText: async (text, overrides) =>
      sendText({
        ...resolveCtx(overrides),
        text,
      }),
    sendMedia: async (caption, mediaUrl, overrides) =>
      sendMedia({
        ...resolveCtx(overrides),
        text: caption,
        mediaUrl,
      }),
  };
}

function createChannelOutboundContextBase(
  params: ChannelHandlerParams,
): Omit<ChannelOutboundContext, "text" | "mediaUrl"> {
  return {
    cfg: params.cfg,
    to: params.to,
    accountId: params.accountId,
    replyToId: params.replyToId,
    threadId: params.threadId,
    identity: params.identity,
    gifPlayback: params.gifPlayback,
    deps: params.deps,
    silent: params.silent,
    mediaLocalRoots: params.mediaLocalRoots,
  };
}

const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";

const GEC_VERSION = "1.0.0";
const GEC_LEGAL_END_STATES = ["CLOSURE PACKET", "BLOCKED PACKET", "CHECKPOINT PLAN"];
const GEC_HEDGING_RE = /\b(if you want|would you like me to|i can|let me know if)\b/i;
const GEC_PROMISE_RE =
  /\b(i['’]ll\s+do|i\s+will\s+do|i['’]m\s+executing\s+now|i\s+am\s+executing\s+now|running\s+end-to-end)\b/i;
const GEC_DECISION_RE =
  /\b(should i|do you want|would you like|which option|choose one|pick one|confirm)\b|\?/i;

export type GecEnforcementResult = {
  blocked: boolean;
  rewrittenText: string;
  reason:
    | "forbidden_future_tense_execution_promise"
    | "forbidden_hedging_without_decision"
    | "timeline_without_checkpoint"
    | "channel_not_runtime_bound"
    | null;
};

export type ExecutionWatchdogState = {
  active: boolean;
  startedAtMs: number;
  lastProofAtMs: number;
};

export type ExecutionWatchdogResult = {
  state: ExecutionWatchdogState;
  timedOut: boolean;
  rewrittenText: string;
  reason: "execution_window_exceeded" | null;
};

type MissionControlClient = {
  createTask: (params: {
    title: string;
    type: "STORY" | "CHORE";
    ownerAgent: string;
    nextAction: string;
    status: "backlog";
  }) => Promise<{ taskId: string; link: string }>;
  ensureLeaseActive: (params: { taskId: string; agentId: string }) => Promise<{ active: boolean }>;
};

type MissionControlBindingResult = {
  proceed: boolean;
  text: string;
  taskId?: string;
  taskLink?: string;
  createdTask?: boolean;
  blockedReason?: string;
};

const hasGecLegalEndState = (text: string): boolean => {
  const upper = text.toUpperCase();
  return GEC_LEGAL_END_STATES.some((token) => upper.includes(token));
};

const isDecisionRequestText = (text: string): boolean => GEC_DECISION_RE.test(text);
const GEC_EXECUTION_INTENT_RE =
  /\b(i['’]m\s+executing|i\s+am\s+executing|running\s+end-to-end|working\s+on\s+it|executing\s+now|starting\s+execution)\b/i;
const GEC_EXECUTION_WINDOW_DEFAULT_MINS = 10;
const MC_TASK_RE = /\btask(?:[_ -]?id)?\s*[:=]\s*([A-Za-z0-9_-]+)/i;
const MC_TASK_LINK_RE = /https?:\/\/\S+\/tasks\/([A-Za-z0-9_-]+)/i;
const NON_TRIVIAL_RE =
  /\b(code changes?|file writes?|deploy(?:ment)?|multi-step|checkpoint plan|closure packet|blocked packet|running tests?|\bbuild\b|executing now|i['’]ll do this now|implement|patch|commit|pr\b)\b/i;
const TIMELINE_RE =
  /\b(in\s+\d+\s*(minutes?|mins?|m|hours?|hrs?|h)|~\s*\d+\s*(minutes?|mins?|m|hours?|hrs?|h)|quickly|soon|shortly|right away)\b/i;

const resolveExecutionWindowMs = (): number => {
  const raw = process.env.GEC_EXECUTION_WINDOW_MINS;
  const parsed = raw ? Number(raw) : GEC_EXECUTION_WINDOW_DEFAULT_MINS;
  const mins = Number.isFinite(parsed) && parsed > 0 ? parsed : GEC_EXECUTION_WINDOW_DEFAULT_MINS;
  return mins * 60 * 1000;
};

const hasProofSignal = (text: string): boolean => hasGecLegalEndState(text);

const hasExecutionIntent = (text: string): boolean => GEC_EXECUTION_INTENT_RE.test(text);
const isNonTrivialExecution = (text: string): boolean => NON_TRIVIAL_RE.test(text);
const hasTimelineEstimate = (text: string): boolean => TIMELINE_RE.test(text);

const isRuntimeBoundChannel = (
  cfg: OpenClawConfig,
  channel: string,
  accountId?: string,
  chatType?: string | null,
): boolean => {
  const channels = (cfg as OpenClawConfig & { channels?: Record<string, unknown> }).channels;
  const channelCfg = channels?.[channel] as
    | {
        requiresRuntime?: boolean;
        accounts?: Record<string, { requiresRuntime?: boolean }>;
      }
    | undefined;
  if (!channelCfg) {
    return true;
  }
  const accountCfg = accountId ? channelCfg.accounts?.[accountId] : undefined;
  const accountFlag = accountCfg?.requiresRuntime;
  const channelFlag = channelCfg.requiresRuntime;
  const resolved = accountFlag ?? channelFlag;

  if (channel === "slack") {
    const normalized = (chatType ?? "channel").toLowerCase();
    if (normalized === "direct" || normalized === "im" || normalized === "mpim") {
      return false;
    }
    if (normalized === "channel" || normalized === "group") {
      return true;
    }
    return true;
  }

  return resolved !== false;
};

const extractTaskIdFromText = (text: string): string | undefined => {
  const direct = MC_TASK_RE.exec(text)?.[1];
  if (direct) {
    return direct;
  }
  return MC_TASK_LINK_RE.exec(text)?.[1];
};

const chooseDefaultOwnerAgent = (text: string): string =>
  /\b(product|spec|priorit|roadmap|acceptance criteria)\b/i.test(text)
    ? "ava-product-manager"
    : "cb-router";

let mcBindingLogEmitted = false;
const outboundDedupeState = new Map<string, number>();

export function shouldEmitDedup(key: string, windowMs: number, nowMs = Date.now()): boolean {
  const last = outboundDedupeState.get(key) ?? 0;
  if (nowMs - last < windowMs) {
    return false;
  }
  outboundDedupeState.set(key, nowMs);
  return true;
}

const resolveMcTimeoutMs = (): number => {
  const parsed = Number(process.env.MC_TIMEOUT_MS ?? "7000");
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 7000;
  }
  return Math.floor(parsed);
};

const deriveAppBaseFromApiUrl = (apiUrl: string): string => {
  const trimmed = apiUrl.replace(/\/$/, "");
  return trimmed.replace(/\/api$/i, "");
};

const resolveMcBaseUrl = (): string | null => {
  const explicit = process.env.MC_APP_BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/$/, "");
  }
  const api = process.env.MC_API_URL?.trim();
  if (!api) {
    return null;
  }
  return deriveAppBaseFromApiUrl(api);
};

const missingMcVars = (): string[] => {
  const missing: string[] = [];
  if (!process.env.MC_API_URL?.trim()) {
    missing.push("MC_API_URL");
  }
  if (!process.env.MC_API_TOKEN?.trim()) {
    missing.push("MC_API_TOKEN");
  }
  return missing;
};

const buildBlockedPacket = (reason: string): string =>
  `BLOCKED PACKET\nMissing requirement: ${reason}\nRequired next step: set required Mission Control env vars and retry.`;

const ensureMcLinkOnPacket = (text: string, taskLink?: string): string => {
  if (!taskLink) {
    return text;
  }
  if (!hasGecLegalEndState(text)) {
    return text;
  }
  if (text.startsWith("MC Task:")) {
    return text;
  }
  return `MC Task: ${taskLink}\n${text}`;
};

const createMissionControlClient = (): MissionControlClient => {
  const apiBase = process.env.MC_API_URL?.trim().replace(/\/$/, "");
  const token = process.env.MC_API_TOKEN?.trim();
  const appBase = resolveMcBaseUrl();
  const timeoutMs = resolveMcTimeoutMs();
  const missing = missingMcVars();

  if (missing.length === 0 && !mcBindingLogEmitted && apiBase && token) {
    console.log(`[MC_BINDING] enabled url=${apiBase} token=present timeout_ms=${timeoutMs}`);
    mcBindingLogEmitted = true;
  }

  return {
    createTask: async ({ title, type, ownerAgent, nextAction, status }) => {
      if (!apiBase || !token) {
        throw new Error(`Missing required vars: ${missingMcVars().join(", ")}`);
      }
      const res = await fetch(`${apiBase}/tasks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(process.env.MC_TENANT?.trim()
            ? {
                "X-MC-Tenant": process.env.MC_TENANT.trim(),
              }
            : {}),
        },
        body: JSON.stringify({ title, type, ownerAgent, nextAction, status }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`MC task create failed: HTTP ${res.status}`);
      }
      const json = (await res.json()) as { taskId?: string; id?: string; link?: string };
      const taskId = json.taskId ?? json.id;
      if (!taskId) {
        throw new Error("MC task create failed: missing taskId in response");
      }
      const resolvedAppBase = appBase ?? deriveAppBaseFromApiUrl(apiBase);
      return {
        taskId,
        link: json.link ?? `${resolvedAppBase}/tasks/${taskId}`,
      };
    },
    ensureLeaseActive: async ({ taskId, agentId }) => {
      if (!apiBase || !token) {
        throw new Error(`Missing required vars: ${missingMcVars().join(", ")}`);
      }
      const res = await fetch(`${apiBase}/tasks/${taskId}/lease`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(process.env.MC_TENANT?.trim()
            ? {
                "X-MC-Tenant": process.env.MC_TENANT.trim(),
              }
            : {}),
        },
        body: JSON.stringify({ agentId, state: "ACTIVE" }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`MC lease activation failed: HTTP ${res.status}`);
      }
      return { active: true };
    },
  };
};

export async function ensureMissionControlBinding(params: {
  text: string;
  taskId?: string;
  taskLink?: string;
  agentId: string;
  client?: MissionControlClient;
}): Promise<MissionControlBindingResult> {
  const raw = (params.text ?? "").trim();
  if (!raw || !isNonTrivialExecution(raw)) {
    return { proceed: true, text: raw, taskId: params.taskId, taskLink: params.taskLink };
  }
  const client = params.client ?? createMissionControlClient();
  let taskId = params.taskId ?? extractTaskIdFromText(raw);
  let taskLink = params.taskLink;

  if (!taskId) {
    try {
      const created = await client.createTask({
        title: raw.slice(0, 120),
        type: /\bdeploy|infra|ops\b/i.test(raw) ? "CHORE" : "STORY",
        ownerAgent: chooseDefaultOwnerAgent(raw),
        nextAction: "Execute one bounded checkpoint and report proof.",
        status: "backlog",
      });
      taskId = created.taskId;
      taskLink = created.link;
      const checkpoint = `CHECKPOINT PLAN\n1) Task created: ${taskLink}\n2) Acquire ACTIVE lease for executor agent. Proof: lease ACTIVE for ${params.agentId}.\n3) Execute exactly one bounded step and report evidence linked to task ${taskId}.`;
      return {
        proceed: false,
        createdTask: true,
        text: ensureMcLinkOnPacket(checkpoint, taskLink),
        taskId,
        taskLink,
      };
    } catch (err) {
      return {
        proceed: false,
        text: buildBlockedPacket(String(err)),
        blockedReason: String(err),
      };
    }
  }

  if (!taskLink) {
    const appBase = resolveMcBaseUrl();
    if (!appBase) {
      return {
        proceed: false,
        text: buildBlockedPacket(
          "Missing required vars: MC_API_URL (or MC_APP_BASE_URL for link formatting)",
        ),
        taskId,
        blockedReason: "Missing required vars: MC_API_URL (or MC_APP_BASE_URL for link formatting)",
      };
    }
    taskLink = `${appBase}/tasks/${taskId}`;
  }

  try {
    const lease = await client.ensureLeaseActive({ taskId, agentId: params.agentId });
    if (!lease.active) {
      return {
        proceed: false,
        text: buildBlockedPacket("MC lease is not ACTIVE"),
        taskId,
        taskLink,
        blockedReason: "MC lease is not ACTIVE",
      };
    }
  } catch (err) {
    return {
      proceed: false,
      text: buildBlockedPacket(String(err)),
      taskId,
      taskLink,
      blockedReason: String(err),
    };
  }

  return {
    proceed: true,
    text: ensureMcLinkOnPacket(raw, taskLink),
    taskId,
    taskLink,
  };
}

export function buildGecCheckpointPlan(originalText: string): string {
  const objective = (originalText || "Execution update").replace(/\s+/g, " ").trim().slice(0, 220);
  return `CHECKPOINT PLAN\n1) Capture objective + scope from request. Proof: objective statement logged.\n2) Execute exactly one bounded step toward objective. Proof: artifact path/command output.\n3) Return with one legal end state (Closure Packet / Blocked Packet / Checkpoint Plan) and evidence. Proof: end-state packet posted.\n\nObjective: ${objective}`;
}

export function buildTimelineCheckpointPlan(originalText: string): string {
  const objective = (originalText || "Switch storage to persistent option")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
  return `CHECKPOINT PLAN\n1) Switch storage to persistent option (Google Sheets/Airtable/Supabase). Proof: updated code + deploy URL.\n\nObjective: ${objective}`;
}

export function enforceGlobalExecutionConstitution(text: string): GecEnforcementResult {
  const raw = (text ?? "").trim();
  if (!raw) {
    return { blocked: false, rewrittenText: raw, reason: null };
  }
  const hasLegalState = hasGecLegalEndState(raw);
  const promiseViolation = GEC_PROMISE_RE.test(raw);
  const hedgingViolation = GEC_HEDGING_RE.test(raw) && !isDecisionRequestText(raw);
  const timelineViolation = hasTimelineEstimate(raw) && !hasLegalState;
  if (!hasLegalState && (promiseViolation || hedgingViolation || timelineViolation)) {
    return {
      blocked: true,
      rewrittenText: timelineViolation
        ? buildTimelineCheckpointPlan(raw)
        : buildGecCheckpointPlan(raw),
      reason: promiseViolation
        ? "forbidden_future_tense_execution_promise"
        : hedgingViolation
          ? "forbidden_hedging_without_decision"
          : "timeline_without_checkpoint",
    };
  }
  return { blocked: false, rewrittenText: raw, reason: null };
}

export function evaluateExecutionWatchdog(params: {
  text: string;
  state: ExecutionWatchdogState;
  nowMs?: number;
  windowMs?: number;
}): ExecutionWatchdogResult {
  const nowMs = params.nowMs ?? Date.now();
  const windowMs = params.windowMs ?? resolveExecutionWindowMs();
  const raw = (params.text ?? "").trim();
  let state = params.state;

  if (!raw) {
    return { state, timedOut: false, rewrittenText: raw, reason: null };
  }
  if (hasProofSignal(raw)) {
    return {
      state: {
        active: false,
        startedAtMs: state.startedAtMs,
        lastProofAtMs: nowMs,
      },
      timedOut: false,
      rewrittenText: raw,
      reason: null,
    };
  }

  if (!state.active && hasExecutionIntent(raw)) {
    state = {
      active: true,
      startedAtMs: nowMs,
      lastProofAtMs: nowMs,
    };
    return { state, timedOut: false, rewrittenText: raw, reason: null };
  }

  if (state.active && nowMs - state.lastProofAtMs > windowMs) {
    return {
      state: {
        ...state,
        active: false,
      },
      timedOut: true,
      rewrittenText: buildGecCheckpointPlan(raw),
      reason: "execution_window_exceeded",
    };
  }

  return { state, timedOut: false, rewrittenText: raw, reason: null };
}

type DeliverOutboundPayloadsCoreParams = {
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  /** Normalized chat surface from inbound context (direct/mpim/channel/group). */
  chatType?: string | null;
  accountId?: string;
  payloads: ReplyPayload[];
  replyToId?: string | null;
  threadId?: string | number | null;
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
  abortSignal?: AbortSignal;
  bestEffort?: boolean;
  onError?: (err: unknown, payload: NormalizedOutboundPayload) => void;
  onPayload?: (payload: NormalizedOutboundPayload) => void;
  /** Active agent id for media local-root scoping. */
  agentId?: string;
  mirror?: {
    sessionKey: string;
    agentId?: string;
    text?: string;
    mediaUrls?: string[];
  };
  silent?: boolean;
  /** Session key for internal hook dispatch (when `mirror` is not needed). */
  sessionKey?: string;
};

type DeliverOutboundPayloadsParams = DeliverOutboundPayloadsCoreParams & {
  /** @internal Skip write-ahead queue (used by crash-recovery to avoid re-enqueueing). */
  skipQueue?: boolean;
};

export async function deliverOutboundPayloads(
  params: DeliverOutboundPayloadsParams,
): Promise<OutboundDeliveryResult[]> {
  const { channel, to, payloads } = params;

  // Write-ahead delivery queue: persist before sending, remove after success.
  const queueId = params.skipQueue
    ? null
    : await enqueueDelivery({
        channel,
        to,
        accountId: params.accountId,
        payloads,
        threadId: params.threadId,
        replyToId: params.replyToId,
        bestEffort: params.bestEffort,
        gifPlayback: params.gifPlayback,
        silent: params.silent,
        mirror: params.mirror,
      }).catch(() => null); // Best-effort — don't block delivery if queue write fails.

  // Wrap onError to detect partial failures under bestEffort mode.
  // When bestEffort is true, per-payload errors are caught and passed to onError
  // without throwing — so the outer try/catch never fires. We track whether any
  // payload failed so we can call failDelivery instead of ackDelivery.
  let hadPartialFailure = false;
  const wrappedParams = params.onError
    ? {
        ...params,
        onError: (err: unknown, payload: NormalizedOutboundPayload) => {
          hadPartialFailure = true;
          params.onError!(err, payload);
        },
      }
    : params;

  try {
    const results = await deliverOutboundPayloadsCore(wrappedParams);
    if (queueId) {
      if (hadPartialFailure) {
        await failDelivery(queueId, "partial delivery failure (bestEffort)").catch(() => {});
      } else {
        await ackDelivery(queueId).catch(() => {}); // Best-effort cleanup.
      }
    }
    return results;
  } catch (err) {
    if (queueId) {
      if (isAbortError(err)) {
        await ackDelivery(queueId).catch(() => {});
      } else {
        await failDelivery(queueId, err instanceof Error ? err.message : String(err)).catch(
          () => {},
        );
      }
    }
    throw err;
  }
}

/** Core delivery logic (extracted for queue wrapper). */
async function deliverOutboundPayloadsCore(
  params: DeliverOutboundPayloadsCoreParams,
): Promise<OutboundDeliveryResult[]> {
  const { cfg, channel, to, payloads } = params;
  const accountId = params.accountId;
  const deps = params.deps;
  const abortSignal = params.abortSignal;
  const sendSignal = params.deps?.sendSignal ?? sendMessageSignal;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(
    cfg,
    params.agentId ?? params.mirror?.agentId,
  );
  const results: OutboundDeliveryResult[] = [];
  const handler = await createChannelHandler({
    cfg,
    channel,
    to,
    deps,
    accountId,
    replyToId: params.replyToId,
    threadId: params.threadId,
    identity: params.identity,
    gifPlayback: params.gifPlayback,
    silent: params.silent,
    mediaLocalRoots,
  });
  const textLimit = handler.chunker
    ? resolveTextChunkLimit(cfg, channel, accountId, {
        fallbackLimit: handler.textChunkLimit,
      })
    : undefined;
  const chunkMode = handler.chunker ? resolveChunkMode(cfg, channel, accountId) : "length";
  const isSignalChannel = channel === "signal";
  const signalTableMode = isSignalChannel
    ? resolveMarkdownTableMode({ cfg, channel: "signal", accountId })
    : "code";
  const signalMaxBytes = isSignalChannel
    ? resolveChannelMediaMaxBytes({
        cfg,
        resolveChannelLimitMb: ({ cfg, accountId }) =>
          cfg.channels?.signal?.accounts?.[accountId]?.mediaMaxMb ??
          cfg.channels?.signal?.mediaMaxMb,
        accountId,
      })
    : undefined;

  const sendTextChunks = async (
    text: string,
    overrides?: { replyToId?: string | null; threadId?: string | number | null },
  ) => {
    throwIfAborted(abortSignal);
    if (!handler.chunker || textLimit === undefined) {
      results.push(await handler.sendText(text, overrides));
      return;
    }
    if (chunkMode === "newline") {
      const mode = handler.chunkerMode ?? "text";
      const blockChunks =
        mode === "markdown"
          ? chunkMarkdownTextWithMode(text, textLimit, "newline")
          : chunkByParagraph(text, textLimit);

      if (!blockChunks.length && text) {
        blockChunks.push(text);
      }
      for (const blockChunk of blockChunks) {
        const chunks = handler.chunker(blockChunk, textLimit);
        if (!chunks.length && blockChunk) {
          chunks.push(blockChunk);
        }
        for (const chunk of chunks) {
          throwIfAborted(abortSignal);
          results.push(await handler.sendText(chunk, overrides));
        }
      }
      return;
    }
    const chunks = handler.chunker(text, textLimit);
    for (const chunk of chunks) {
      throwIfAborted(abortSignal);
      results.push(await handler.sendText(chunk, overrides));
    }
  };

  const sendSignalText = async (text: string, styles: SignalTextStyleRange[]) => {
    throwIfAborted(abortSignal);
    return {
      channel: "signal" as const,
      ...(await sendSignal(to, text, {
        maxBytes: signalMaxBytes,
        accountId: accountId ?? undefined,
        textMode: "plain",
        textStyles: styles,
      })),
    };
  };

  const sendSignalTextChunks = async (text: string) => {
    throwIfAborted(abortSignal);
    let signalChunks =
      textLimit === undefined
        ? markdownToSignalTextChunks(text, Number.POSITIVE_INFINITY, {
            tableMode: signalTableMode,
          })
        : markdownToSignalTextChunks(text, textLimit, { tableMode: signalTableMode });
    if (signalChunks.length === 0 && text) {
      signalChunks = [{ text, styles: [] }];
    }
    for (const chunk of signalChunks) {
      throwIfAborted(abortSignal);
      results.push(await sendSignalText(chunk.text, chunk.styles));
    }
  };

  const sendSignalMedia = async (caption: string, mediaUrl: string) => {
    throwIfAborted(abortSignal);
    const formatted = markdownToSignalTextChunks(caption, Number.POSITIVE_INFINITY, {
      tableMode: signalTableMode,
    })[0] ?? {
      text: caption,
      styles: [],
    };
    return {
      channel: "signal" as const,
      ...(await sendSignal(to, formatted.text, {
        mediaUrl,
        maxBytes: signalMaxBytes,
        accountId: accountId ?? undefined,
        textMode: "plain",
        textStyles: formatted.styles,
        mediaLocalRoots,
      })),
    };
  };
  const normalizeWhatsAppPayload = (payload: ReplyPayload): ReplyPayload | null => {
    const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
    const rawText = typeof payload.text === "string" ? payload.text : "";
    const normalizedText = rawText.replace(/^(?:[ \t]*\r?\n)+/, "");
    if (!normalizedText.trim()) {
      if (!hasMedia) {
        return null;
      }
      return {
        ...payload,
        text: "",
      };
    }
    return {
      ...payload,
      text: normalizedText,
    };
  };
  const normalizedPayloads = normalizeReplyPayloadsForDelivery(payloads).flatMap((payload) => {
    if (channel !== "whatsapp") {
      return [payload];
    }
    const normalized = normalizeWhatsAppPayload(payload);
    return normalized ? [normalized] : [];
  });
  const hookRunner = getGlobalHookRunner();
  const sessionKeyForInternalHooks = params.mirror?.sessionKey ?? params.sessionKey;
  let watchdogState: ExecutionWatchdogState = {
    active: false,
    startedAtMs: Date.now(),
    lastProofAtMs: Date.now(),
  };
  let boundTaskId: string | undefined;
  let boundTaskLink: string | undefined;
  for (const payload of normalizedPayloads) {
    const payloadSummary: NormalizedOutboundPayload = {
      text: payload.text ?? "",
      mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []),
      channelData: payload.channelData,
    };

    const runtimeBound = isRuntimeBoundChannel(cfg, channel, accountId, params.chatType);
    let mcBinding: MissionControlBindingResult;
    if (!runtimeBound && isNonTrivialExecution(payloadSummary.text)) {
      const rewritten = `CHECKPOINT PLAN\n1) Post this request in a Slack execution lane (# channel) to run through runtime + Mission Control. Proof: execution-lane message link.\n2) If you want this in DM, request task creation only; no execution will run from DM. Proof: MC task link returned.`;
      payloadSummary.text = rewritten;
      mcBinding = {
        proceed: false,
        text: rewritten,
      };
      if (sessionKeyForInternalHooks) {
        void triggerInternalHook(
          createInternalHookEvent("message", "policy_violation", sessionKeyForInternalHooks, {
            policy: "global_execution_constitution",
            gecVersion: GEC_VERSION,
            reason: "POLICY_VIOLATION_CHANNEL",
            channelId: channel,
            accountId: accountId ?? undefined,
            conversationId: to,
            originalContent: payload.text ?? "",
            rewrittenContent: rewritten,
          }),
        ).catch(() => {});
      } else if (shouldEmitDedup(`policy_violation_channel:${channel}`, 5 * 60_000)) {
        console.warn(
          `[POLICY_VIOLATION_CHANNEL] global_execution_constitution gec_version=${GEC_VERSION} channel=${channel}`,
        );
      }
    } else {
      mcBinding = await ensureMissionControlBinding({
        text: payloadSummary.text,
        taskId: boundTaskId,
        taskLink: boundTaskLink,
        agentId: params.agentId ?? "cb-router",
      });
    }
    if (mcBinding.taskId) {
      boundTaskId = mcBinding.taskId;
    }
    if (mcBinding.taskLink) {
      boundTaskLink = mcBinding.taskLink;
    }
    payloadSummary.text = mcBinding.text;

    if (mcBinding.blockedReason) {
      if (sessionKeyForInternalHooks) {
        void triggerInternalHook(
          createInternalHookEvent("message", "policy_violation", sessionKeyForInternalHooks, {
            policy: "global_execution_constitution",
            gecVersion: GEC_VERSION,
            reason: "MISSION_CONTROL_BINDING_FAILED",
            channelId: channel,
            accountId: accountId ?? undefined,
            conversationId: to,
            originalContent: payload.text ?? "",
            rewrittenContent: mcBinding.text,
          }),
        ).catch(() => {});
      }
    }

    const gec = enforceGlobalExecutionConstitution(payloadSummary.text);
    if (gec.blocked) {
      payloadSummary.text = ensureMcLinkOnPacket(gec.rewrittenText, boundTaskLink);
      if (sessionKeyForInternalHooks) {
        void triggerInternalHook(
          createInternalHookEvent("message", "policy_violation", sessionKeyForInternalHooks, {
            policy: "global_execution_constitution",
            gecVersion: GEC_VERSION,
            reason: gec.reason,
            channelId: channel,
            accountId: accountId ?? undefined,
            conversationId: to,
            originalContent: payload.text ?? "",
            rewrittenContent: gec.rewrittenText,
          }),
        ).catch(() => {});
      } else if (shouldEmitDedup(`policy_violation:${channel}:${gec.reason}`, 5 * 60_000)) {
        console.warn(
          `[POLICY_VIOLATION] global_execution_constitution gec_version=${GEC_VERSION} channel=${channel} reason=${gec.reason}`,
        );
      }
    }
    let abortAfterThisPayload = !mcBinding.proceed;
    const emitMessageSent = (params: {
      success: boolean;
      content: string;
      error?: string;
      messageId?: string;
    }) => {
      if (hookRunner?.hasHooks("message_sent")) {
        void hookRunner
          .runMessageSent(
            {
              to,
              content: params.content,
              success: params.success,
              ...(params.error ? { error: params.error } : {}),
            },
            {
              channelId: channel,
              accountId: accountId ?? undefined,
              conversationId: to,
            },
          )
          .catch(() => {});
      }
      if (!sessionKeyForInternalHooks) {
        return;
      }
      void triggerInternalHook(
        createInternalHookEvent("message", "sent", sessionKeyForInternalHooks, {
          to,
          content: params.content,
          success: params.success,
          ...(params.error ? { error: params.error } : {}),
          channelId: channel,
          accountId: accountId ?? undefined,
          conversationId: to,
          messageId: params.messageId,
        }),
      ).catch(() => {});
    };
    try {
      throwIfAborted(abortSignal);

      // Run message_sending plugin hook (may modify content or cancel)
      let effectivePayload: ReplyPayload = gec.blocked
        ? {
            ...payload,
            text: payloadSummary.text,
          }
        : payload;
      if (hookRunner?.hasHooks("message_sending")) {
        try {
          const sendingResult = await hookRunner.runMessageSending(
            {
              to,
              content: payloadSummary.text,
              metadata: { channel, accountId, mediaUrls: payloadSummary.mediaUrls },
            },
            {
              channelId: channel,
              accountId: accountId ?? undefined,
            },
          );
          if (sendingResult?.cancel) {
            continue;
          }
          if (sendingResult?.content != null) {
            effectivePayload = { ...payload, text: sendingResult.content };
            payloadSummary.text = sendingResult.content;
          }
        } catch {
          // Don't block delivery on hook failure
        }
      }

      const watchdog = evaluateExecutionWatchdog({
        text: payloadSummary.text,
        state: watchdogState,
      });
      watchdogState = watchdog.state;
      if (watchdog.timedOut) {
        abortAfterThisPayload = true;
        payloadSummary.text = ensureMcLinkOnPacket(watchdog.rewrittenText, boundTaskLink);
        effectivePayload = {
          ...effectivePayload,
          text: payloadSummary.text,
        };
        if (sessionKeyForInternalHooks) {
          void triggerInternalHook(
            createInternalHookEvent("message", "policy_violation", sessionKeyForInternalHooks, {
              policy: "global_execution_constitution",
              gecVersion: GEC_VERSION,
              reason: "EXECUTION_WINDOW_EXCEEDED",
              channelId: channel,
              accountId: accountId ?? undefined,
              conversationId: to,
              originalContent: payload.text ?? "",
              rewrittenContent: watchdog.rewrittenText,
            }),
          ).catch(() => {});
        } else if (shouldEmitDedup(`execution_window_exceeded:${channel}`, 5 * 60_000)) {
          console.warn(
            `[POLICY_VIOLATION] EXECUTION_WINDOW_EXCEEDED gec_version=${GEC_VERSION} channel=${channel}`,
          );
        }
      }

      params.onPayload?.(payloadSummary);
      const sendOverrides = {
        replyToId: effectivePayload.replyToId ?? params.replyToId ?? undefined,
        threadId: params.threadId ?? undefined,
      };
      if (handler.sendPayload && effectivePayload.channelData) {
        const delivery = await handler.sendPayload(effectivePayload, sendOverrides);
        results.push(delivery);
        emitMessageSent({
          success: true,
          content: payloadSummary.text,
          messageId: delivery.messageId,
        });
        if (abortAfterThisPayload) {
          return results;
        }
        continue;
      }
      if (payloadSummary.mediaUrls.length === 0) {
        const beforeCount = results.length;
        if (isSignalChannel) {
          await sendSignalTextChunks(payloadSummary.text);
        } else {
          await sendTextChunks(payloadSummary.text, sendOverrides);
        }
        const messageId = results.at(-1)?.messageId;
        emitMessageSent({
          success: results.length > beforeCount,
          content: payloadSummary.text,
          messageId,
        });
        if (abortAfterThisPayload) {
          return results;
        }
        continue;
      }

      let first = true;
      let lastMessageId: string | undefined;
      for (const url of payloadSummary.mediaUrls) {
        throwIfAborted(abortSignal);
        const caption = first ? payloadSummary.text : "";
        first = false;
        if (isSignalChannel) {
          const delivery = await sendSignalMedia(caption, url);
          results.push(delivery);
          lastMessageId = delivery.messageId;
        } else {
          const delivery = await handler.sendMedia(caption, url, sendOverrides);
          results.push(delivery);
          lastMessageId = delivery.messageId;
        }
      }
      emitMessageSent({
        success: true,
        content: payloadSummary.text,
        messageId: lastMessageId,
      });
      if (abortAfterThisPayload) {
        return results;
      }
    } catch (err) {
      emitMessageSent({
        success: false,
        content: payloadSummary.text,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!params.bestEffort) {
        throw err;
      }
      params.onError?.(err, payloadSummary);
    }
  }
  if (params.mirror && results.length > 0) {
    const mirrorText = resolveMirroredTranscriptText({
      text: params.mirror.text,
      mediaUrls: params.mirror.mediaUrls,
    });
    if (mirrorText) {
      await appendAssistantMessageToSessionTranscript({
        agentId: params.mirror.agentId,
        sessionKey: params.mirror.sessionKey,
        text: mirrorText,
      });
    }
  }

  return results;
}
