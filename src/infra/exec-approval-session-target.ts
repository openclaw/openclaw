import type { OpenClawConfig } from "../config/config.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { doesApprovalRequestMatchChannelAccount } from "./approval-request-account-binding.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import { resolveSessionDeliveryTarget } from "./outbound/targets.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

export {
  doesApprovalRequestMatchChannelAccount,
  resolveApprovalRequestAccountId,
  resolveApprovalRequestChannelAccountId,
} from "./approval-request-account-binding.js";

export type ExecApprovalSessionTarget = {
  channel?: string;
  to: string;
  accountId?: string;
  threadId?: number;
};

type ApprovalRequestLike = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalRequestOriginTargetResolver<TTarget> = {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel: string;
  accountId?: string | null;
  resolveTurnSourceTarget: (request: ApprovalRequestLike) => TTarget | null;
  resolveSessionTarget: (sessionTarget: ExecApprovalSessionTarget) => TTarget | null;
  targetsMatch: (a: TTarget, b: TTarget) => boolean;
  resolveFallbackTarget?: (request: ApprovalRequestLike) => TTarget | null;
};

function normalizeOptionalString(value?: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeOptionalThreadId(value?: string | number | null): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = Number.parseInt(value, 10);
  return Number.isFinite(normalized) ? normalized : undefined;
}

function isExecApprovalRequest(request: ApprovalRequestLike): request is ExecApprovalRequest {
  return "command" in request.request;
}

function toExecLikeApprovalRequest(request: ApprovalRequestLike): ExecApprovalRequest {
  if (isExecApprovalRequest(request)) {
    return request;
  }
  return {
    id: request.id,
    request: {
      command: request.request.title,
      sessionKey: request.request.sessionKey ?? undefined,
      turnSourceChannel: request.request.turnSourceChannel ?? undefined,
      turnSourceTo: request.request.turnSourceTo ?? undefined,
      turnSourceAccountId: request.request.turnSourceAccountId ?? undefined,
      turnSourceThreadId: request.request.turnSourceThreadId ?? undefined,
    },
    createdAtMs: request.createdAtMs,
    expiresAtMs: request.expiresAtMs,
  };
}

function normalizeOptionalChannel(value?: string | null): string | undefined {
  return normalizeMessageChannel(value);
}

export function resolveExecApprovalSessionTarget(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
}): ExecApprovalSessionTarget | null {
  const sessionKey = normalizeOptionalString(params.request.request.sessionKey);
  if (!sessionKey) {
    return null;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  const agentId = parsed?.agentId ?? params.request.request.agentId ?? "main";
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry) {
    return null;
  }

  const target = resolveSessionDeliveryTarget({
    entry,
    requestedChannel: "last",
    turnSourceChannel: normalizeOptionalString(params.turnSourceChannel),
    turnSourceTo: normalizeOptionalString(params.turnSourceTo),
    turnSourceAccountId: normalizeOptionalString(params.turnSourceAccountId),
    turnSourceThreadId: normalizeOptionalThreadId(params.turnSourceThreadId),
  });
  if (!target.to) {
    return null;
  }

  return {
    channel: normalizeOptionalString(target.channel),
    to: target.to,
    accountId: normalizeOptionalString(target.accountId),
    threadId: normalizeOptionalThreadId(target.threadId),
  };
}

export function resolveApprovalRequestSessionTarget(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
}): ExecApprovalSessionTarget | null {
  const execLikeRequest = toExecLikeApprovalRequest(params.request);
  return resolveExecApprovalSessionTarget({
    cfg: params.cfg,
    request: execLikeRequest,
    turnSourceChannel: execLikeRequest.request.turnSourceChannel ?? undefined,
    turnSourceTo: execLikeRequest.request.turnSourceTo ?? undefined,
    turnSourceAccountId: execLikeRequest.request.turnSourceAccountId ?? undefined,
    turnSourceThreadId: execLikeRequest.request.turnSourceThreadId ?? undefined,
  });
}

function resolveApprovalRequestStoredSessionTarget(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
}): ExecApprovalSessionTarget | null {
  const execLikeRequest = toExecLikeApprovalRequest(params.request);
  return resolveExecApprovalSessionTarget({
    cfg: params.cfg,
    request: execLikeRequest,
  });
}

export function resolveApprovalRequestOriginTarget<TTarget>(
  params: ApprovalRequestOriginTargetResolver<TTarget>,
): TTarget | null {
  if (
    !doesApprovalRequestMatchChannelAccount({
      cfg: params.cfg,
      request: params.request,
      channel: params.channel,
      accountId: params.accountId,
    })
  ) {
    return null;
  }

  const turnSourceTarget = params.resolveTurnSourceTarget(params.request);
  const expectedChannel = normalizeOptionalChannel(params.channel);
  const sessionTargetBinding = resolveApprovalRequestStoredSessionTarget({
    cfg: params.cfg,
    request: params.request,
  });
  const sessionTarget =
    sessionTargetBinding &&
    normalizeOptionalChannel(sessionTargetBinding.channel) === expectedChannel
      ? params.resolveSessionTarget(sessionTargetBinding)
      : null;

  if (turnSourceTarget && sessionTarget && !params.targetsMatch(turnSourceTarget, sessionTarget)) {
    return null;
  }

  return (
    turnSourceTarget ?? sessionTarget ?? params.resolveFallbackTarget?.(params.request) ?? null
  );
}
