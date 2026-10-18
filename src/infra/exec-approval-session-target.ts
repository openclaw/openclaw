// Resolves approval delivery targets from sessions and turn sources.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionConversationRef } from "../channels/plugins/session-conversation.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import {
  doesApprovalRequestMatchChannelAccountFromDelivery,
  resolveApprovalRequestSessionDeliveryAsync,
  type ApprovalRequestSessionDelivery,
  resolveApprovalRequestSessionDelivery,
} from "./approval-request-account-binding.js";
import { normalizeApprovalRequest, type ApprovalRequestInput } from "./approval-types.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import { resolveSessionDeliveryTarget } from "./outbound/targets-session.js";

/** Delivery target recovered from an approval request's live turn-source or stored session. */
export type ExecApprovalSessionTarget = {
  channel?: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
};

/** Parsed session conversation metadata used by channel-native approval routing. */
export type ApprovalRequestSessionConversation = {
  channel: string;
  kind: "group" | "channel";
  id: string;
  rawId: string;
  threadId?: string;
  baseSessionKey: string;
  baseConversationId: string;
  parentConversationCandidates: string[];
};

type ApprovalRequestLike = ApprovalRequestInput;
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

function normalizeExecApprovalThreadValue(
  value?: string | number | null,
): string | number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  return normalizeOptionalString(value);
}

function toExecLikeApprovalRequest(request: ApprovalRequestLike): ExecApprovalRequest {
  const normalizedRequest = normalizeApprovalRequest(request);
  if (normalizedRequest.approvalKind === "exec") {
    return normalizedRequest;
  }
  return {
    approvalKind: "exec",
    id: normalizedRequest.id,
    request: {
      command: normalizedRequest.request.title,
      sessionKey: normalizedRequest.request.sessionKey ?? undefined,
      turnSourceChannel: normalizedRequest.request.turnSourceChannel ?? undefined,
      turnSourceTo: normalizedRequest.request.turnSourceTo ?? undefined,
      turnSourceAccountId: normalizedRequest.request.turnSourceAccountId ?? undefined,
      turnSourceThreadId: normalizedRequest.request.turnSourceThreadId ?? undefined,
    },
    createdAtMs: normalizedRequest.createdAtMs,
    expiresAtMs: normalizedRequest.expiresAtMs,
  };
}

/** Resolves the conversation encoded in an approval request session key for an optional channel. */
export function resolveApprovalRequestSessionConversation(params: {
  request: ApprovalRequestLike;
  channel?: string | null;
  bundledFallback?: boolean;
}): ApprovalRequestSessionConversation | null {
  const sessionKey = normalizeOptionalString(params.request.request.sessionKey);
  if (!sessionKey) {
    return null;
  }
  const resolved = resolveSessionConversationRef(sessionKey, {
    bundledFallback: params.bundledFallback,
  });
  if (!resolved) {
    return null;
  }
  const expectedChannel = normalizeMessageChannel(params.channel);
  if (expectedChannel && normalizeMessageChannel(resolved.channel) !== expectedChannel) {
    return null;
  }
  return resolved;
}

/** Resolves the best known message target for an exec approval request. */
function resolveExecApprovalSessionTargetFromDelivery(
  params: {
    cfg: OpenClawConfig;
    request: ExecApprovalRequest;
    turnSourceChannel?: string | null;
    turnSourceTo?: string | null;
    turnSourceAccountId?: string | null;
    turnSourceThreadId?: string | number | null;
  },
  entry: ApprovalRequestSessionDelivery | null,
): ExecApprovalSessionTarget | null {
  if (!entry) {
    return null;
  }

  const target = resolveSessionDeliveryTarget({
    entry,
    requestedChannel: "last",
    turnSourceChannel: normalizeOptionalString(params.turnSourceChannel),
    turnSourceTo: normalizeOptionalString(params.turnSourceTo),
    turnSourceAccountId: normalizeOptionalString(params.turnSourceAccountId),
    turnSourceThreadId: normalizeExecApprovalThreadValue(params.turnSourceThreadId),
  });
  if (!target.to) {
    return null;
  }

  return {
    channel: normalizeOptionalString(target.channel),
    to: target.to,
    accountId: normalizeOptionalString(target.accountId),
    threadId: normalizeExecApprovalThreadValue(target.threadId),
  };
}

/** Resolves the best known message target for either exec or plugin approval requests. */
function resolveApprovalRequestSessionTargetFromDelivery(
  params: {
    cfg: OpenClawConfig;
    request: ApprovalRequestLike;
  },
  sessionDelivery: ApprovalRequestSessionDelivery | null,
): ExecApprovalSessionTarget | null {
  const execLikeRequest = toExecLikeApprovalRequest(params.request);
  return resolveExecApprovalSessionTargetFromDelivery(
    {
      cfg: params.cfg,
      request: execLikeRequest,
      turnSourceChannel: execLikeRequest.request.turnSourceChannel ?? undefined,
      turnSourceTo: execLikeRequest.request.turnSourceTo ?? undefined,
      turnSourceAccountId: execLikeRequest.request.turnSourceAccountId ?? undefined,
      turnSourceThreadId: execLikeRequest.request.turnSourceThreadId ?? undefined,
    },
    sessionDelivery,
  );
}

function resolveApprovalRequestStoredSessionTarget(
  params: {
    cfg: OpenClawConfig;
    request: ApprovalRequestLike;
  },
  sessionDelivery: ApprovalRequestSessionDelivery | null,
): ExecApprovalSessionTarget | null {
  const execLikeRequest = toExecLikeApprovalRequest(params.request);
  return resolveExecApprovalSessionTargetFromDelivery(
    {
      cfg: params.cfg,
      request: execLikeRequest,
    },
    sessionDelivery,
  );
}

/** Resolves a channel-specific origin target only when live and stored bindings are consistent. */
function resolveApprovalRequestOriginTargetFromDelivery<TTarget>(
  params: ApprovalRequestOriginTargetResolver<TTarget>,
  sessionDelivery: ApprovalRequestSessionDelivery | null,
): TTarget | null {
  if (
    !doesApprovalRequestMatchChannelAccountFromDelivery(
      {
        cfg: params.cfg,
        request: params.request,
        channel: params.channel,
        accountId: params.accountId,
      },
      sessionDelivery,
    )
  ) {
    return null;
  }

  const turnSourceTarget = params.resolveTurnSourceTarget(params.request);
  const expectedChannel = normalizeMessageChannel(params.channel);
  const sessionTargetBinding = resolveApprovalRequestStoredSessionTarget(
    {
      cfg: params.cfg,
      request: params.request,
    },
    sessionDelivery,
  );
  const sessionTarget =
    sessionTargetBinding &&
    normalizeMessageChannel(sessionTargetBinding.channel) === expectedChannel
      ? params.resolveSessionTarget(sessionTargetBinding)
      : null;

  if (turnSourceTarget && sessionTarget && !params.targetsMatch(turnSourceTarget, sessionTarget)) {
    // Avoid routing to an origin when live turn metadata disagrees with persisted session state.
    return null;
  }

  return (
    turnSourceTarget ?? sessionTarget ?? params.resolveFallbackTarget?.(params.request) ?? null
  );
}

function warnLegacyTarget(name: string): void {
  warnPluginSdkDeprecation({
    family: "approval-session-routing",
    method: name,
    replacement: `${name}Async`,
  });
}

/** @deprecated Use resolveExecApprovalSessionTargetAsync; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
export function resolveExecApprovalSessionTarget(
  params: Parameters<typeof resolveExecApprovalSessionTargetFromDelivery>[0],
): ExecApprovalSessionTarget | null {
  warnLegacyTarget("resolveExecApprovalSessionTarget");
  return resolveExecApprovalSessionTargetFromDelivery(
    params,
    resolveApprovalRequestSessionDelivery(params),
  );
}
export async function resolveExecApprovalSessionTargetAsync(
  params: Parameters<typeof resolveExecApprovalSessionTargetFromDelivery>[0] & {
    sessionDelivery?: ApprovalRequestSessionDelivery | null;
  },
): Promise<ExecApprovalSessionTarget | null> {
  return resolveExecApprovalSessionTargetFromDelivery(
    params,
    await resolveApprovalRequestSessionDeliveryAsync(params),
  );
}

/** @deprecated Use resolveApprovalRequestSessionTargetAsync; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
export function resolveApprovalRequestSessionTarget(
  params: Parameters<typeof resolveApprovalRequestSessionTargetFromDelivery>[0],
): ExecApprovalSessionTarget | null {
  warnLegacyTarget("resolveApprovalRequestSessionTarget");
  return resolveApprovalRequestSessionTargetFromDelivery(
    params,
    resolveApprovalRequestSessionDelivery(params),
  );
}
export async function resolveApprovalRequestSessionTargetAsync(
  params: Parameters<typeof resolveApprovalRequestSessionTargetFromDelivery>[0] & {
    sessionDelivery?: ApprovalRequestSessionDelivery | null;
  },
): Promise<ExecApprovalSessionTarget | null> {
  return resolveApprovalRequestSessionTargetFromDelivery(
    params,
    await resolveApprovalRequestSessionDeliveryAsync(params),
  );
}

/** @deprecated Use resolveApprovalRequestOriginTargetAsync; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
export function resolveApprovalRequestOriginTarget<TTarget>(
  params: ApprovalRequestOriginTargetResolver<TTarget>,
): TTarget | null {
  warnLegacyTarget("resolveApprovalRequestOriginTarget");
  return resolveApprovalRequestOriginTargetFromDelivery(
    params,
    resolveApprovalRequestSessionDelivery(params),
  );
}
export async function resolveApprovalRequestOriginTargetAsync<TTarget>(
  params: ApprovalRequestOriginTargetResolver<TTarget> & {
    sessionDelivery?: ApprovalRequestSessionDelivery | null;
  },
): Promise<TTarget | null> {
  return resolveApprovalRequestOriginTargetFromDelivery(
    params,
    await resolveApprovalRequestSessionDeliveryAsync(params),
  );
}
