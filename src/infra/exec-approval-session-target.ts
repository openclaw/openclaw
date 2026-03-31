import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { normalizeOptionalAccountId } from "../routing/account-id.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import { resolveSessionDeliveryTarget } from "./outbound/targets.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

export type ExecApprovalSessionTarget = {
  channel?: string;
  to: string;
  accountId?: string;
  threadId?: number;
};

type ApprovalRequestSessionBinding = {
  channel?: string;
  accountId?: string;
};

type ApprovalRequestLike = ExecApprovalRequest | PluginApprovalRequest;

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

function resolveApprovalRequestSessionBinding(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
}): ApprovalRequestSessionBinding | null {
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
  return {
    channel: normalizeOptionalChannel(entry.origin?.provider ?? entry.lastChannel),
    accountId: normalizeOptionalAccountId(entry.origin?.accountId ?? entry.lastAccountId),
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

export function resolveApprovalRequestAccountId(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel?: string | null;
}): string | null {
  const expectedChannel = normalizeOptionalChannel(params.channel);
  const turnSourceChannel = normalizeOptionalChannel(params.request.request.turnSourceChannel);
  if (expectedChannel && turnSourceChannel && turnSourceChannel !== expectedChannel) {
    return null;
  }

  const turnSourceAccountId = normalizeOptionalAccountId(
    params.request.request.turnSourceAccountId,
  );
  if (turnSourceAccountId) {
    return turnSourceAccountId;
  }

  const sessionTarget = resolveApprovalRequestSessionTarget(params);
  const sessionBinding = resolveApprovalRequestSessionBinding(params);
  const sessionChannel = normalizeOptionalChannel(
    sessionTarget?.channel ?? sessionBinding?.channel,
  );
  if (expectedChannel && sessionChannel && sessionChannel !== expectedChannel) {
    return null;
  }

  const sessionAccountId = normalizeOptionalAccountId(
    sessionTarget?.accountId ?? sessionBinding?.accountId,
  );
  return sessionAccountId ?? null;
}

export function doesApprovalRequestMatchChannelAccount(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel: string;
  accountId?: string | null;
}): boolean {
  const expectedChannel = normalizeOptionalChannel(params.channel);
  if (!expectedChannel) {
    return false;
  }

  const turnSourceChannel = normalizeOptionalChannel(params.request.request.turnSourceChannel);
  if (turnSourceChannel && turnSourceChannel !== expectedChannel) {
    return false;
  }

  const turnSourceAccountId = normalizeOptionalAccountId(
    params.request.request.turnSourceAccountId,
  );
  const expectedAccountId = normalizeOptionalAccountId(params.accountId);
  if (turnSourceAccountId) {
    return !expectedAccountId || expectedAccountId === turnSourceAccountId;
  }

  const sessionTarget = resolveApprovalRequestSessionTarget(params);
  const sessionBinding = resolveApprovalRequestSessionBinding(params);
  const sessionChannel = normalizeOptionalChannel(
    sessionTarget?.channel ?? sessionBinding?.channel,
  );
  if (sessionChannel && sessionChannel !== expectedChannel) {
    return false;
  }

  const sessionAccountId = normalizeOptionalAccountId(
    sessionTarget?.accountId ?? sessionBinding?.accountId,
  );
  const boundAccountId = sessionAccountId;
  return !expectedAccountId || !boundAccountId || expectedAccountId === boundAccountId;
}
