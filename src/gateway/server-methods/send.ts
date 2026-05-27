import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { sendDurableMessageBatch } from "../../channels/message/runtime.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import { createOutboundSendDeps } from "../../cli/deps.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveChannelNativeApprovalDeliveryPlan } from "../../infra/approval-native-delivery.js";
import {
  resolveApprovalDeliveryFailedNoticeText,
  resolveApprovalRoutedElsewhereNoticeText,
} from "../../infra/approval-native-route-notice.js";
import { resolveApprovalRequestSessionTarget } from "../../infra/exec-approval-session-target.js";
import type { ExecApprovalRequest } from "../../infra/exec-approvals.js";
import { resolveOutboundChannelPlugin } from "../../infra/outbound/channel-resolution.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import {
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
} from "../../infra/outbound/outbound-session.js";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForMirror,
} from "../../infra/outbound/payloads.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { mirrorDeliveredSourceReplyToTranscript } from "../../infra/outbound/source-reply-mirror.js";
import { maybeResolveIdLikeTarget } from "../../infra/outbound/target-resolver.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.js";
import { extractToolPayload } from "../../infra/outbound/tool-payload.js";
import type { PluginApprovalRequest } from "../../infra/plugin-approvals.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { normalizePollInput } from "../../polls.js";
import { parseThreadSessionSuffix } from "../../sessions/session-key-utils.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readStringValue,
} from "../../shared/string-coerce.js";
import type { ExecApprovalRecord } from "../exec-approval-manager.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE } from "../operator-scopes.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateMessageActionParams,
  validatePollParams,
  validateSendParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import { isApprovalDecision, isApprovalRecordVisibleToClient } from "./approval-shared.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";

type InflightResult = {
  ok: boolean;
  payload?: unknown;
  error?: ReturnType<typeof errorShape>;
  meta?: Record<string, unknown>;
};

const inflightByContext = new WeakMap<
  GatewayRequestContext,
  Map<string, Promise<InflightResult>>
>();
const MAX_ROUTE_NOTICE_DESTINATIONS = 4;
const MAX_ROUTE_NOTICE_DESTINATION_LENGTH = 48;
const ROUTE_NOTICE_DESTINATION_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._#@()/-]*$/;

const getInflightMap = (context: GatewayRequestContext) => {
  let inflight = inflightByContext.get(context);
  if (!inflight) {
    inflight = new Map();
    inflightByContext.set(context, inflight);
  }
  return inflight;
};

function resolveGatewayInflightMap(params: { context: GatewayRequestContext; dedupeKey: string }):
  | {
      kind: "cached";
      cached: NonNullable<ReturnType<GatewayRequestContext["dedupe"]["get"]>>;
    }
  | {
      kind: "inflight";
      inflight: Promise<InflightResult>;
    }
  | {
      kind: "ready";
      inflightMap: Map<string, Promise<InflightResult>>;
    } {
  const cached = params.context.dedupe.get(params.dedupeKey);
  if (cached) {
    return { kind: "cached", cached };
  }
  const inflightMap = getInflightMap(params.context);
  const inflight = inflightMap.get(params.dedupeKey);
  if (inflight) {
    return { kind: "inflight", inflight };
  }
  return { kind: "ready", inflightMap };
}

async function runGatewayInflightWork(params: {
  inflightMap: Map<string, Promise<InflightResult>>;
  dedupeKey: string;
  work: Promise<InflightResult>;
  respond: RespondFn;
}) {
  params.inflightMap.set(params.dedupeKey, params.work);
  try {
    const result = await params.work;
    params.respond(result.ok, result.payload, result.error, result.meta);
  } finally {
    params.inflightMap.delete(params.dedupeKey);
  }
}

async function resolveRequestedChannel(params: {
  requestChannel: unknown;
  unsupportedMessage: (input: string) => string;
  context: GatewayRequestContext;
  rejectWebchatAsInternalOnly?: boolean;
}): Promise<
  | {
      cfg: OpenClawConfig;
      channel: string;
    }
  | {
      error: ReturnType<typeof errorShape>;
    }
> {
  const channelInput = readStringValue(params.requestChannel);
  const normalizedChannel = channelInput ? normalizeChannelId(channelInput) : null;
  if (channelInput && !normalizedChannel) {
    const normalizedInput = normalizeOptionalLowercaseString(channelInput) ?? "";
    if (params.rejectWebchatAsInternalOnly && normalizedInput === "webchat") {
      return {
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          "unsupported channel: webchat (internal-only). Use `chat.send` for WebChat UI messages or choose a deliverable channel.",
        ),
      };
    }
    return {
      error: errorShape(ErrorCodes.INVALID_REQUEST, params.unsupportedMessage(channelInput)),
    };
  }
  const runtimeConfig = params.context.getRuntimeConfig();
  const currentSnapshot = getCurrentPluginMetadataSnapshot({
    config: runtimeConfig,
    env: process.env,
  });
  const cfg = applyPluginAutoEnable({
    config: runtimeConfig,
    env: process.env,
    manifestRegistry: currentSnapshot?.manifestRegistry,
    discovery: currentSnapshot?.discovery,
  }).config;
  let channel = normalizedChannel;
  if (!channel) {
    try {
      channel = (await resolveMessageChannelSelection({ cfg })).channel;
    } catch (err) {
      return { error: errorShape(ErrorCodes.INVALID_REQUEST, String(err)) };
    }
  }
  return { cfg, channel };
}

function resolveGatewayOutboundTarget(params: {
  channel: string;
  to: string;
  cfg: OpenClawConfig;
  accountId?: string;
}):
  | {
      ok: true;
      to: string;
    }
  | {
      ok: false;
      error: ReturnType<typeof errorShape>;
    } {
  const resolved = resolveOutboundTarget({
    channel: params.channel,
    to: params.to,
    cfg: params.cfg,
    accountId: params.accountId,
    mode: "explicit",
  });
  if (!resolved.ok) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, String(resolved.error)),
    };
  }
  return { ok: true, to: resolved.to };
}

function buildGatewayDeliveryPayload(params: {
  runId: string;
  channel: string;
  result: Record<string, unknown>;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    runId: params.runId,
    messageId: params.result.messageId,
    channel: params.channel,
  };
  if ("chatId" in params.result) {
    payload.chatId = params.result.chatId;
  }
  if ("channelId" in params.result) {
    payload.channelId = params.result.channelId;
  }
  if ("toJid" in params.result) {
    payload.toJid = params.result.toJid;
  }
  if ("conversationId" in params.result) {
    payload.conversationId = params.result.conversationId;
  }
  if ("pollId" in params.result) {
    payload.pollId = params.result.pollId;
  }
  return payload;
}

function cacheGatewayDedupeSuccess(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  payload: unknown;
}) {
  params.context.dedupe.set(params.dedupeKey, {
    ts: Date.now(),
    ok: true,
    payload: params.payload,
  });
}

function cacheGatewayDedupeFailure(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  error: ReturnType<typeof errorShape>;
}) {
  params.context.dedupe.set(params.dedupeKey, {
    ts: Date.now(),
    ok: false,
    error: params.error,
  });
}

function createGatewayInflightSuccess(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  payload: unknown;
  channel: string;
}): InflightResult {
  cacheGatewayDedupeSuccess({
    context: params.context,
    dedupeKey: params.dedupeKey,
    payload: params.payload,
  });
  return {
    ok: true,
    payload: params.payload,
    meta: { channel: params.channel },
  };
}

function createGatewayInflightUnavailableFailure(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  channel: string;
  err: unknown;
}): InflightResult {
  const error = errorShape(ErrorCodes.UNAVAILABLE, String(params.err));
  cacheGatewayDedupeFailure({
    context: params.context,
    dedupeKey: params.dedupeKey,
    error,
  });
  return {
    ok: false,
    error,
    meta: { channel: params.channel, error: formatForLog(params.err) },
  };
}

async function mirrorDeliveredSourceReplyToTranscriptBestEffort(params: {
  context: GatewayRequestContext;
  mirror: Parameters<typeof mirrorDeliveredSourceReplyToTranscript>[0];
}) {
  try {
    await mirrorDeliveredSourceReplyToTranscript(params.mirror);
  } catch (err) {
    params.context.logGateway?.warn?.("Source reply transcript mirror failed after delivery.", {
      error: formatForLog(err),
      channel: params.mirror.channel,
      sessionKey: params.mirror.sessionKey,
    });
  }
}

type GatewaySendRequest = {
  to: string;
  message?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  asVoice?: boolean;
  gifPlayback?: boolean;
  channel?: string;
  accountId?: string;
  agentId?: string;
  replyToId?: string;
  threadId?: string;
  forceDocument?: boolean;
  silent?: boolean;
  parseMode?: "HTML";
  sessionKey?: string;
  idempotencyKey: string;
};

type ApprovalRouteNoticeSpec =
  | {
      kind: "routed-elsewhere";
      destinations: string[];
    }
  | {
      kind: "delivery-failed";
    };

type ApprovalRouteNoticeTarget = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string;
};

type ApprovalRouteNoticeRequest = {
  approvalId: string;
  approvalKind: "exec" | "plugin";
  target?: ApprovalRouteNoticeTarget;
  notice: ApprovalRouteNoticeSpec;
};

type ApprovalRequestLike = ExecApprovalRequest | PluginApprovalRequest;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizeRouteNoticeThreadId(value?: string | number | null): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  return normalizeOptionalString(value);
}

function normalizeRouteNoticeDestinationList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: string[] = [];
  for (const entry of value) {
    const label = normalizeOptionalString(entry);
    if (
      !label ||
      label.length > MAX_ROUTE_NOTICE_DESTINATION_LENGTH ||
      /[\r\n\t]/.test(label) ||
      !ROUTE_NOTICE_DESTINATION_LABEL_PATTERN.test(label)
    ) {
      continue;
    }
    if (!normalized.includes(label)) {
      normalized.push(label);
    }
    if (normalized.length >= MAX_ROUTE_NOTICE_DESTINATIONS) {
      break;
    }
  }
  return normalized.length > 0 ? normalized : undefined;
}

function parseApprovalRouteNoticeTarget(value: unknown): ApprovalRouteNoticeTarget | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ["channel", "to", "accountId", "threadId"])) {
    return undefined;
  }
  const channel = normalizeOptionalString(value.channel);
  const to = normalizeOptionalString(value.to);
  if (!channel || !to) {
    return undefined;
  }
  return {
    channel,
    to,
    accountId: normalizeOptionalString(value.accountId),
    threadId: normalizeRouteNoticeThreadId(value.threadId as string | number | null | undefined),
  };
}

function parseApprovalRouteNoticeRequest(value: unknown): ApprovalRouteNoticeRequest | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["approvalId", "approvalKind", "target", "notice"])) {
    return null;
  }
  const approvalId = normalizeOptionalString(value.approvalId);
  const approvalKind = normalizeOptionalString(value.approvalKind);
  const notice = value.notice;
  if (
    !approvalId ||
    (approvalKind !== "exec" && approvalKind !== "plugin") ||
    !isRecord(notice) ||
    typeof notice.kind !== "string"
  ) {
    return null;
  }
  const target = parseApprovalRouteNoticeTarget(value.target);
  if (value.target !== undefined && !target) {
    return null;
  }
  if (notice.kind === "routed-elsewhere") {
    if (!hasOnlyKeys(notice, ["kind", "destinations"])) {
      return null;
    }
    const destinations = normalizeRouteNoticeDestinationList(notice.destinations);
    return destinations
      ? {
          approvalId,
          approvalKind,
          target,
          notice: { kind: "routed-elsewhere", destinations },
        }
      : null;
  }
  if (notice.kind === "delivery-failed") {
    if (!hasOnlyKeys(notice, ["kind"])) {
      return null;
    }
    return {
      approvalId,
      approvalKind,
      target,
      notice: { kind: "delivery-failed" },
    };
  }
  return null;
}

function approvalRequestFromSnapshot(params: {
  approvalId: string;
  snapshot: {
    request: unknown;
    createdAtMs: number;
    expiresAtMs: number;
  };
}): ApprovalRequestLike {
  return {
    id: params.approvalId,
    request: params.snapshot.request as ApprovalRequestLike["request"],
    createdAtMs: params.snapshot.createdAtMs,
    expiresAtMs: params.snapshot.expiresAtMs,
  } as ApprovalRequestLike;
}

function resolveApprovalRouteNoticeTarget(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
}): ApprovalRouteNoticeTarget | null {
  const directChannel = normalizeOptionalString(params.request.request.turnSourceChannel);
  const directTo = normalizeOptionalString(params.request.request.turnSourceTo);
  if (directChannel && directTo) {
    return {
      channel: directChannel,
      to: directTo,
      accountId: normalizeOptionalString(params.request.request.turnSourceAccountId),
      threadId: normalizeRouteNoticeThreadId(params.request.request.turnSourceThreadId),
    };
  }

  const sessionTarget = resolveApprovalRequestSessionTarget({
    cfg: params.cfg,
    request: params.request,
  });
  const sessionChannel = normalizeOptionalString(sessionTarget?.channel);
  const sessionTo = normalizeOptionalString(sessionTarget?.to);
  return sessionChannel && sessionTo
    ? {
        channel: sessionChannel,
        to: sessionTo,
        accountId: normalizeOptionalString(sessionTarget?.accountId),
        threadId: normalizeRouteNoticeThreadId(sessionTarget?.threadId),
      }
    : null;
}

async function resolveApprovalRouteNoticeNativeTarget(params: {
  cfg: OpenClawConfig;
  routeNotice: ApprovalRouteNoticeRequest;
  request: ApprovalRequestLike;
}): Promise<ApprovalRouteNoticeTarget | null> {
  const channelInput = normalizeOptionalString(params.routeNotice.target?.channel);
  const channel = channelInput ? normalizeChannelId(channelInput) : null;
  if (!channel) {
    return null;
  }
  const accountId = normalizeOptionalString(params.routeNotice.target?.accountId);
  const plugin = resolveOutboundChannelPlugin({ channel, cfg: params.cfg });
  const nativeAdapter = plugin?.approvalCapability?.native;
  if (!nativeAdapter) {
    return null;
  }
  const deliveryPlan = await resolveChannelNativeApprovalDeliveryPlan({
    cfg: params.cfg,
    accountId,
    approvalKind: params.routeNotice.approvalKind,
    request: params.request,
    adapter: nativeAdapter,
  });
  const originTarget = deliveryPlan.originTarget;
  const to = normalizeOptionalString(originTarget?.to);
  return to
    ? {
        channel,
        to,
        accountId,
        threadId: normalizeRouteNoticeThreadId(originTarget?.threadId),
      }
    : null;
}

function approvalRouteNoticeTargetsMatch(params: {
  cfg: OpenClawConfig;
  snapshotTarget: ApprovalRouteNoticeTarget;
  nativeTarget: ApprovalRouteNoticeTarget;
}): boolean {
  if (params.snapshotTarget.channel !== params.nativeTarget.channel) {
    return false;
  }
  if (
    params.nativeTarget.accountId !== undefined &&
    params.snapshotTarget.accountId !== undefined &&
    params.snapshotTarget.accountId !== params.nativeTarget.accountId
  ) {
    return false;
  }
  const snapshotTarget = resolveGatewayOutboundTarget({
    channel: params.snapshotTarget.channel,
    to: params.snapshotTarget.to,
    cfg: params.cfg,
    accountId: params.snapshotTarget.accountId,
  });
  const nativeTarget = resolveGatewayOutboundTarget({
    channel: params.nativeTarget.channel,
    to: params.nativeTarget.to,
    cfg: params.cfg,
    accountId: params.nativeTarget.accountId,
  });
  if (snapshotTarget.ok && nativeTarget.ok) {
    return snapshotTarget.to === nativeTarget.to;
  }
  return params.snapshotTarget.to === params.nativeTarget.to;
}

function mergeApprovalRouteNoticeTargets(params: {
  cfg: OpenClawConfig;
  snapshotTarget: ApprovalRouteNoticeTarget | null;
  nativeTarget: ApprovalRouteNoticeTarget | null;
}): ApprovalRouteNoticeTarget | null {
  if (!params.snapshotTarget) {
    return params.nativeTarget;
  }
  if (
    !params.nativeTarget ||
    !approvalRouteNoticeTargetsMatch({
      cfg: params.cfg,
      snapshotTarget: params.snapshotTarget,
      nativeTarget: params.nativeTarget,
    })
  ) {
    return params.snapshotTarget;
  }
  return {
    ...params.snapshotTarget,
    accountId: params.snapshotTarget.accountId ?? params.nativeTarget.accountId,
    threadId: params.snapshotTarget.threadId ?? params.nativeTarget.threadId,
  };
}

function isTrustedApprovalRouteNoticeClient(client: GatewayClient | null | undefined): boolean {
  return (
    client?.internal?.approvalRuntime === true &&
    Array.isArray(client.connect?.scopes) &&
    client.connect.scopes.includes(APPROVALS_SCOPE)
  );
}

function sameApprovalIdentity(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeOptionalString(a);
  const right = normalizeOptionalString(b);
  return Boolean(left && right && left === right);
}

function isApprovalRecordRequestedByClient(params: {
  record: {
    requestedByConnId?: string | null;
    requestedByDeviceId?: string | null;
  };
  client: GatewayClient | null | undefined;
}): boolean {
  // Client ids describe roles such as "gateway-client"; only connection and
  // device ids identify a concrete requester instance for this self-check.
  return (
    sameApprovalIdentity(params.record.requestedByConnId, params.client?.connId) ||
    sameApprovalIdentity(params.record.requestedByDeviceId, params.client?.connect?.device?.id)
  );
}

function canClientSendApprovalRouteNotice(params: {
  record: ExecApprovalRecord<unknown>;
  client: GatewayClient | null | undefined;
}): boolean {
  return (
    isTrustedApprovalRouteNoticeClient(params.client) &&
    isApprovalRecordVisibleToClient({
      record: params.record,
      client: params.client ?? null,
    }) &&
    !isApprovalRecordRequestedByClient(params)
  );
}

function readAllowedApprovalDecisions(request: ApprovalRequestLike): string[] | undefined {
  const raw = request.request.allowedDecisions;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const decisions = raw.filter(isApprovalDecision);
  return decisions.length > 0 ? decisions : undefined;
}

function buildApprovalRouteNoticeText(params: {
  routeNotice: ApprovalRouteNoticeRequest;
  request: ApprovalRequestLike;
}): string | null {
  if (params.routeNotice.notice.kind === "routed-elsewhere") {
    return resolveApprovalRoutedElsewhereNoticeText(params.routeNotice.notice.destinations);
  }
  return resolveApprovalDeliveryFailedNoticeText({
    approvalId: params.routeNotice.approvalId,
    approvalKind: params.routeNotice.approvalKind,
    allowedDecisions: readAllowedApprovalDecisions(params.request),
  });
}

const sourceReplyTranscriptMirrorQueues = new Map<string, Promise<void>>();

function resolveSourceReplyTranscriptMirrorQueueKey(
  mirror: Parameters<typeof mirrorDeliveredSourceReplyToTranscript>[0],
): string {
  return mirror.sessionKey?.trim() || "__global__";
}

function scheduleDeliveredSourceReplyTranscriptMirror(params: {
  context: GatewayRequestContext;
  mirror: Parameters<typeof mirrorDeliveredSourceReplyToTranscript>[0];
}): Promise<void> {
  const queueKey = resolveSourceReplyTranscriptMirrorQueueKey(params.mirror);
  const previous = sourceReplyTranscriptMirrorQueues.get(queueKey);
  // Queue per session so current-conversation source replies are visible before
  // a following turn can read the transcript.
  const queued = (async () => {
    await previous?.catch(() => undefined);
    await mirrorDeliveredSourceReplyToTranscriptBestEffort(params);
  })();
  sourceReplyTranscriptMirrorQueues.set(queueKey, queued);
  void queued
    .finally(() => {
      if (sourceReplyTranscriptMirrorQueues.get(queueKey) === queued) {
        sourceReplyTranscriptMirrorQueues.delete(queueKey);
      }
    })
    .catch(() => undefined);
  return queued;
}

async function handleGatewaySendRequest(params: {
  request: GatewaySendRequest;
  respond: RespondFn;
  context: GatewayRequestContext;
  client: GatewayClient | null | undefined;
}): Promise<void> {
  const { request, respond, context, client } = params;
  const idem = request.idempotencyKey;
  const dedupeKey = `send:${idem}`;
  const inflight = resolveGatewayInflightMap({ context, dedupeKey });
  if (inflight.kind === "cached") {
    respond(inflight.cached.ok, inflight.cached.payload, inflight.cached.error, {
      cached: true,
    });
    return;
  }
  if (inflight.kind === "inflight") {
    const result = await inflight.inflight;
    const meta = result.meta ? { ...result.meta, cached: true } : { cached: true };
    respond(result.ok, result.payload, result.error, meta);
    return;
  }
  const inflightMap = inflight.inflightMap;
  const to = normalizeOptionalString(request.to) ?? "";
  const message = normalizeOptionalString(request.message) ?? "";
  const mediaUrl = normalizeOptionalString(request.mediaUrl);
  const mediaUrls = Array.isArray(request.mediaUrls)
    ? request.mediaUrls
        .map((entry) => normalizeOptionalString(entry))
        .filter((entry): entry is string => Boolean(entry))
    : undefined;
  if (!message && !mediaUrl && (mediaUrls?.length ?? 0) === 0) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "invalid send params: text or media is required"),
    );
    return;
  }
  const accountId = normalizeOptionalString(request.accountId);
  const replyToId = normalizeOptionalString(request.replyToId);
  const threadId = normalizeOptionalString(request.threadId);

  const work = (async (): Promise<InflightResult> => {
    const resolvedChannel = await resolveRequestedChannel({
      requestChannel: request.channel,
      unsupportedMessage: (input) => `unsupported channel: ${input}`,
      context,
      rejectWebchatAsInternalOnly: true,
    });
    if ("error" in resolvedChannel) {
      return { ok: false, error: resolvedChannel.error };
    }
    const { cfg, channel } = resolvedChannel;
    const outboundChannel = channel;
    const plugin = resolveOutboundChannelPlugin({ channel, cfg });
    if (!plugin) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, `unsupported channel: ${channel}`),
      };
    }

    try {
      const resolvedTarget = resolveGatewayOutboundTarget({
        channel: outboundChannel,
        to,
        cfg,
        accountId,
      });
      if (!resolvedTarget.ok) {
        return {
          ok: false,
          error: resolvedTarget.error,
          meta: { channel },
        };
      }
      const idLikeTarget = await maybeResolveIdLikeTarget({
        cfg,
        channel,
        input: resolvedTarget.to,
        accountId,
      });
      const deliveryTarget = idLikeTarget?.to ?? resolvedTarget.to;
      const outboundDeps = context.deps ? createOutboundSendDeps(context.deps) : undefined;
      const outboundPayloads = [
        {
          text: message,
          mediaUrl,
          mediaUrls,
          ...(request.asVoice === true ? { audioAsVoice: true } : {}),
        },
      ];
      const outboundPayloadPlan = createOutboundPayloadPlan(outboundPayloads);
      const mirrorProjection = projectOutboundPayloadPlanForMirror(outboundPayloadPlan);
      const mirrorText = mirrorProjection.text;
      const mirrorMediaUrls = mirrorProjection.mediaUrls;
      const providedSessionKey = normalizeOptionalLowercaseString(request.sessionKey);
      const explicitAgentId = normalizeOptionalString(request.agentId);
      const sessionAgentId = providedSessionKey
        ? resolveSessionAgentId({ sessionKey: providedSessionKey, config: cfg })
        : undefined;
      const defaultAgentId = resolveSessionAgentId({ config: cfg });
      const effectiveAgentId = explicitAgentId ?? sessionAgentId ?? defaultAgentId;
      const derivedRoute = await resolveOutboundSessionRoute({
        cfg,
        channel,
        agentId: effectiveAgentId,
        accountId,
        target: deliveryTarget,
        currentSessionKey: providedSessionKey,
        resolvedTarget: idLikeTarget,
        replyToId,
        threadId,
      });
      const providedSessionBaseKey =
        parseThreadSessionSuffix(providedSessionKey).baseSessionKey ?? providedSessionKey;
      const shouldUseDerivedThreadSessionKey =
        channel === "slack" &&
        !!providedSessionKey &&
        !!normalizeOptionalString(derivedRoute?.threadId) &&
        normalizeOptionalLowercaseString(derivedRoute?.baseSessionKey) ===
          normalizeOptionalLowercaseString(providedSessionBaseKey) &&
        normalizeOptionalLowercaseString(derivedRoute?.sessionKey) !== providedSessionKey;
      const outboundRoute = derivedRoute
        ? providedSessionKey
          ? shouldUseDerivedThreadSessionKey
            ? {
                ...derivedRoute,
                baseSessionKey: derivedRoute.baseSessionKey ?? providedSessionKey,
              }
            : {
                ...derivedRoute,
                sessionKey: providedSessionKey,
                baseSessionKey: providedSessionKey,
              }
          : derivedRoute
        : null;
      if (outboundRoute) {
        await ensureOutboundSessionEntry({
          cfg,
          channel,
          accountId,
          route: outboundRoute,
        });
      }
      const outboundSessionKey = outboundRoute?.sessionKey ?? providedSessionKey;
      const outboundSession = buildOutboundSessionContext({
        cfg,
        agentId: effectiveAgentId,
        sessionKey: outboundSessionKey,
        conversationType: outboundRoute?.chatType,
      });
      const send = await sendDurableMessageBatch({
        cfg,
        channel: outboundChannel,
        to: deliveryTarget,
        accountId,
        payloads: outboundPayloads,
        replyToId: replyToId ?? null,
        session: outboundSession,
        gifPlayback: request.gifPlayback,
        forceDocument: request.forceDocument,
        threadId: outboundRoute?.threadId ?? threadId ?? null,
        deps: outboundDeps,
        gatewayClientScopes: client?.connect?.scopes ?? [],
        silent: request.silent,
        formatting: request.parseMode ? { parseMode: request.parseMode } : undefined,
        mirror: outboundSessionKey
          ? {
              sessionKey: outboundSessionKey,
              agentId: effectiveAgentId,
              text: mirrorText || message,
              mediaUrls: mirrorMediaUrls.length > 0 ? mirrorMediaUrls : undefined,
              idempotencyKey: idem,
            }
          : undefined,
      });
      if (send.status === "failed" || send.status === "partial_failed") {
        throw send.error;
      }
      const results = send.status === "sent" ? send.results : [];

      const result = results.at(-1);
      if (!result) {
        throw new Error("No delivery result");
      }
      const payload = buildGatewayDeliveryPayload({ runId: idem, channel, result });
      return createGatewayInflightSuccess({ context, dedupeKey, payload, channel });
    } catch (err) {
      return createGatewayInflightUnavailableFailure({ context, dedupeKey, channel, err });
    }
  })();

  await runGatewayInflightWork({ inflightMap, dedupeKey, work, respond });
}

export const sendHandlers: GatewayRequestHandlers = {
  "message.action": async ({ params, respond, context, client }) => {
    const p = params;
    if (!validateMessageActionParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid message.action params: ${formatValidationErrors(validateMessageActionParams.errors)}`,
        ),
      );
      return;
    }
    const request = p as {
      channel: string;
      action: string;
      params: Record<string, unknown>;
      accountId?: string;
      requesterSenderId?: string;
      senderIsOwner?: boolean;
      sessionKey?: string;
      sessionId?: string;
      inboundTurnKind?: "user_request" | "room_event";
      agentId?: string;
      toolContext?: {
        currentChannelId?: string;
        currentChannelProvider?: string;
        currentThreadTs?: string;
        currentMessageId?: string | number;
      };
      idempotencyKey: string;
    };
    const idem = request.idempotencyKey;
    const dedupeKey = `message.action:${idem}`;
    const inflight = resolveGatewayInflightMap({ context, dedupeKey });
    if (inflight.kind === "cached") {
      respond(inflight.cached.ok, inflight.cached.payload, inflight.cached.error, {
        cached: true,
      });
      return;
    }
    if (inflight.kind === "inflight") {
      const result = await inflight.inflight;
      const meta = result.meta ? { ...result.meta, cached: true } : { cached: true };
      respond(result.ok, result.payload, result.error, meta);
      return;
    }
    if (inflight.kind !== "ready") {
      return;
    }
    const inflightMap = inflight.inflightMap;
    const work = (async (): Promise<InflightResult> => {
      const resolvedChannel = await resolveRequestedChannel({
        requestChannel: request.channel,
        unsupportedMessage: (input) => `unsupported channel: ${input}`,
        context,
        rejectWebchatAsInternalOnly: true,
      });
      if ("error" in resolvedChannel) {
        return { ok: false, error: resolvedChannel.error };
      }
      const { cfg, channel } = resolvedChannel;
      const plugin = resolveOutboundChannelPlugin({ channel, cfg });
      if (!plugin?.actions?.handleAction) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Channel ${channel} does not support action ${request.action}.`,
          ),
        };
      }

      try {
        const gatewayClientScopes = client?.connect?.scopes ?? [];
        const handled = await dispatchChannelMessageAction({
          channel,
          action: request.action as never,
          cfg,
          params: request.params,
          accountId: normalizeOptionalString(request.accountId) ?? undefined,
          requesterSenderId: normalizeOptionalString(request.requesterSenderId) ?? undefined,
          senderIsOwner: gatewayClientScopes.includes(ADMIN_SCOPE)
            ? request.senderIsOwner === true
            : false,
          sessionKey: normalizeOptionalString(request.sessionKey) ?? undefined,
          sessionId: normalizeOptionalString(request.sessionId) ?? undefined,
          inboundEventKind: request.inboundTurnKind,
          agentId: normalizeOptionalString(request.agentId) ?? undefined,
          mediaLocalRoots: getAgentScopedMediaLocalRoots(
            cfg,
            normalizeOptionalString(request.agentId) ?? undefined,
          ),
          toolContext: request.toolContext,
          dryRun: false,
          gatewayClientScopes,
        });
        if (!handled) {
          const error = errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Message action ${request.action} not supported for channel ${channel}.`,
          );
          cacheGatewayDedupeFailure({ context, dedupeKey, error });
          return { ok: false, error, meta: { channel } };
        }
        const payload = extractToolPayload(handled);
        const sessionKey = normalizeOptionalString(request.sessionKey) ?? undefined;
        const agentId =
          normalizeOptionalString(request.agentId) ??
          (sessionKey ? resolveSessionAgentId({ sessionKey, config: cfg }) : undefined);
        await scheduleDeliveredSourceReplyTranscriptMirror({
          context,
          mirror: {
            action: request.action,
            channel,
            actionParams: request.params,
            cfg,
            sessionKey,
            agentId,
            toolContext: request.toolContext,
            idempotencyKey: request.idempotencyKey,
            deliveredPayload: payload,
          },
        });
        return createGatewayInflightSuccess({ context, dedupeKey, payload, channel });
      } catch (err) {
        return createGatewayInflightUnavailableFailure({ context, dedupeKey, channel, err });
      }
    })();

    await runGatewayInflightWork({ inflightMap, dedupeKey, work, respond });
  },
  "approval.routeNotice.send": async ({ params, respond, context, client }) => {
    const routeNotice = parseApprovalRouteNoticeRequest(params);
    if (!routeNotice) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid approval route notice request"),
      );
      return;
    }
    const manager =
      routeNotice.approvalKind === "plugin"
        ? context.pluginApprovalManager
        : context.execApprovalManager;
    const snapshot = manager?.getSnapshot(routeNotice.approvalId);
    if (
      !snapshot ||
      snapshot.resolvedAtMs !== undefined ||
      !canClientSendApprovalRouteNotice({
        record: snapshot,
        client,
      })
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "unknown or expired approval route notice"),
      );
      return;
    }
    const cfg = context.getRuntimeConfig();
    const approvalRequest = approvalRequestFromSnapshot({
      approvalId: routeNotice.approvalId,
      snapshot,
    });
    const snapshotTarget = resolveApprovalRouteNoticeTarget({ cfg, request: approvalRequest });
    const nativeTarget = await resolveApprovalRouteNoticeNativeTarget({
      cfg,
      routeNotice,
      request: approvalRequest,
    });
    const target = mergeApprovalRouteNoticeTargets({
      cfg,
      snapshotTarget,
      nativeTarget,
    });
    const message = buildApprovalRouteNoticeText({
      routeNotice,
      request: approvalRequest,
    });
    if (!target || !message) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "approval route notice target unavailable"),
      );
      return;
    }
    await handleGatewaySendRequest({
      request: {
        channel: target.channel,
        to: target.to,
        accountId: target.accountId,
        threadId: target.threadId,
        message,
        idempotencyKey: `approval-route-notice:${routeNotice.approvalId}`,
      },
      respond,
      context,
      client,
    });
  },
  send: async ({ params, respond, context, client }) => {
    const p = params;
    if (!validateSendParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid send params: ${formatValidationErrors(validateSendParams.errors)}`,
        ),
      );
      return;
    }
    await handleGatewaySendRequest({
      request: p as GatewaySendRequest,
      respond,
      context,
      client,
    });
  },
  poll: async ({ params, respond, context, client }) => {
    const p = params;
    if (!validatePollParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid poll params: ${formatValidationErrors(validatePollParams.errors)}`,
        ),
      );
      return;
    }
    const request = p as {
      to: string;
      question: string;
      options: string[];
      maxSelections?: number;
      durationSeconds?: number;
      durationHours?: number;
      silent?: boolean;
      isAnonymous?: boolean;
      threadId?: string;
      channel?: string;
      accountId?: string;
      idempotencyKey: string;
    };
    const idem = request.idempotencyKey;
    const dedupeKey = `poll:${idem}`;
    const inflight = resolveGatewayInflightMap({ context, dedupeKey });
    if (inflight.kind === "cached") {
      respond(inflight.cached.ok, inflight.cached.payload, inflight.cached.error, {
        cached: true,
      });
      return;
    }
    if (inflight.kind === "inflight") {
      const result = await inflight.inflight;
      const meta = result.meta ? { ...result.meta, cached: true } : { cached: true };
      respond(result.ok, result.payload, result.error, meta);
      return;
    }
    if (inflight.kind !== "ready") {
      return;
    }
    const inflightMap = inflight.inflightMap;
    const work = (async (): Promise<InflightResult> => {
      const resolvedChannel = await resolveRequestedChannel({
        requestChannel: request.channel,
        unsupportedMessage: (input) => `unsupported poll channel: ${input}`,
        context,
      });
      if ("error" in resolvedChannel) {
        return { ok: false, error: resolvedChannel.error };
      }
      const { cfg, channel } = resolvedChannel;
      const plugin = resolveOutboundChannelPlugin({ channel, cfg });
      const outbound = plugin?.outbound;
      if (
        typeof request.durationSeconds === "number" &&
        outbound?.supportsPollDurationSeconds !== true
      ) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            `durationSeconds is not supported for ${channel} polls`,
          ),
        };
      }
      if (typeof request.isAnonymous === "boolean" && outbound?.supportsAnonymousPolls !== true) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            `isAnonymous is not supported for ${channel} polls`,
          ),
        };
      }
      const poll = {
        question: request.question,
        options: request.options,
        maxSelections: request.maxSelections,
        durationSeconds: request.durationSeconds,
        durationHours: request.durationHours,
      };
      const threadId = normalizeOptionalString(request.threadId);
      const accountId = normalizeOptionalString(request.accountId);
      try {
        if (!outbound?.sendPoll) {
          const error = errorShape(
            ErrorCodes.INVALID_REQUEST,
            `unsupported poll channel: ${channel}`,
          );
          return { ok: false, error };
        }
        const resolvedTarget = resolveGatewayOutboundTarget({
          channel: channel,
          to: request.to.trim(),
          cfg,
          accountId,
        });
        if (!resolvedTarget.ok) {
          return { ok: false, error: resolvedTarget.error };
        }
        const normalized = outbound.pollMaxOptions
          ? normalizePollInput(poll, { maxOptions: outbound.pollMaxOptions })
          : normalizePollInput(poll);
        const result = await outbound.sendPoll({
          cfg,
          to: resolvedTarget.to,
          poll: normalized,
          accountId,
          threadId,
          silent: request.silent,
          isAnonymous: request.isAnonymous,
          gatewayClientScopes: client?.connect?.scopes ?? [],
        });
        const payload = buildGatewayDeliveryPayload({ runId: idem, channel, result });
        cacheGatewayDedupeSuccess({
          context,
          dedupeKey,
          payload,
        });
        return { ok: true, payload, meta: { channel } };
      } catch (err) {
        const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
        cacheGatewayDedupeFailure({
          context,
          dedupeKey,
          error,
        });
        return { ok: false, error, meta: { channel, error: formatForLog(err) } };
      }
    })();

    await runGatewayInflightWork({ inflightMap, dedupeKey, work, respond });
  },
};
