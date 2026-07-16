import { listRouteBindings } from "../../config/bindings.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isAccountAuthorizedForAgentChannel } from "../../cron/isolated-agent/delivery-target.runtime.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "../../cron/types.js";
import {
  normalizeRouteBindingChannelId,
  resolveNormalizedRouteBindingMatch,
} from "../../routing/binding-scope.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAccountId,
  normalizeAgentId,
} from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import type { GatewayClient } from "./types.js";

export type CronCallerScope = {
  kind: "agentTool";
  agentId: string;
  sessionKey?: string;
};

export function readCronCallerScope(
  client: GatewayClient | null | undefined,
): CronCallerScope | undefined {
  const identity = client?.internal?.agentRuntimeIdentity;
  if (!identity?.agentId) {
    return undefined;
  }
  return {
    kind: "agentTool",
    agentId: normalizeAgentId(identity.agentId),
    sessionKey: identity.sessionKey?.trim() || undefined,
  };
}

function resolveCronJobEffectiveAgentId(job: CronJob, defaultAgentId?: string): string {
  return normalizeAgentId(job.agentId ?? defaultAgentId ?? DEFAULT_AGENT_ID);
}

function parseAgentIdFromSessionRef(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? parseAgentSessionKey(trimmed)?.agentId : undefined;
}

function parseAgentIdFromCronSessionTarget(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed?.startsWith("session:")
    ? parseAgentIdFromSessionRef(trimmed.slice("session:".length))
    : undefined;
}

function cronJobSessionRefsMatchCaller(job: CronJob, callerScope: CronCallerScope): boolean {
  const sessionAgentId = parseAgentIdFromSessionRef(job.sessionKey);
  if (sessionAgentId && normalizeAgentId(sessionAgentId) !== callerScope.agentId) {
    return false;
  }
  const sessionTargetAgentId = parseAgentIdFromCronSessionTarget(job.sessionTarget);
  return !sessionTargetAgentId || normalizeAgentId(sessionTargetAgentId) === callerScope.agentId;
}

function resolveCronJobOwnerAgentId(job: CronJob): string | undefined {
  const ownerAgentId = job.owner?.agentId ?? parseAgentIdFromSessionRef(job.owner?.sessionKey);
  return ownerAgentId ? normalizeAgentId(ownerAgentId) : undefined;
}

function isOperatorCommandCronJob(job: CronJob): boolean {
  return job.payload.kind === "command" || job.schedule.kind === "on-exit";
}

export function cronJobMatchesCallerScope(params: {
  job: CronJob;
  callerScope: CronCallerScope | undefined;
  defaultAgentId?: string;
}): boolean {
  if (!params.callerScope) {
    return true;
  }
  // Command cron is an operator-admin automation surface, not a model-visible
  // agent tool capability. Hide it before owner/routing fallback can expose
  // payload env, watched commands, or manual force-run controls.
  if (isOperatorCommandCronJob(params.job)) {
    return false;
  }
  // Declarative jobs retain their stamped owner when an operator retargets execution.
  // Ownerless jobs predate attribution, so keep their routing-based visibility.
  const ownerAgentId = resolveCronJobOwnerAgentId(params.job);
  if (ownerAgentId) {
    return ownerAgentId === params.callerScope.agentId;
  }
  if (
    resolveCronJobEffectiveAgentId(params.job, params.defaultAgentId) !== params.callerScope.agentId
  ) {
    return false;
  }
  return cronJobSessionRefsMatchCaller(params.job, params.callerScope);
}

export function cronJobMatchesDeclarationScope(params: {
  job: CronJob;
  input: CronJobCreate;
  callerScope: CronCallerScope | undefined;
  defaultAgentId?: string;
}): boolean {
  if (params.callerScope) {
    return cronJobMatchesCallerScope(params);
  }

  const inputOwnerSessionKey = params.input.owner?.sessionKey;
  const inputOwnerAgentId =
    params.input.owner?.agentId ?? parseAgentIdFromSessionRef(inputOwnerSessionKey);
  if (inputOwnerSessionKey && !inputOwnerAgentId) {
    return params.job.owner?.sessionKey === inputOwnerSessionKey;
  }
  const inputAgentId = normalizeAgentId(
    inputOwnerAgentId ?? params.input.agentId ?? params.defaultAgentId ?? DEFAULT_AGENT_ID,
  );
  const jobAgentId = normalizeAgentId(
    resolveCronJobOwnerAgentId(params.job) ??
      params.job.agentId ??
      params.defaultAgentId ??
      DEFAULT_AGENT_ID,
  );
  return jobAgentId === inputAgentId;
}

export function cronCreateMatchesCallerScope(params: {
  job: CronJobCreate;
  callerScope: CronCallerScope | undefined;
  defaultAgentId?: string;
}): boolean {
  if (!params.callerScope) {
    return true;
  }
  const effectiveAgentId = normalizeAgentId(
    params.job.agentId ?? params.defaultAgentId ?? DEFAULT_AGENT_ID,
  );
  if (effectiveAgentId !== params.callerScope.agentId) {
    return false;
  }
  const sessionAgentId = parseAgentIdFromSessionRef(params.job.sessionKey);
  if (sessionAgentId && normalizeAgentId(sessionAgentId) !== params.callerScope.agentId) {
    return false;
  }
  const sessionTargetAgentId = parseAgentIdFromCronSessionTarget(params.job.sessionTarget);
  return (
    !sessionTargetAgentId || normalizeAgentId(sessionTargetAgentId) === params.callerScope.agentId
  );
}

export function applyCronCreateCallerScopeDefault(
  job: CronJobCreate,
  callerScope: CronCallerScope | undefined,
): CronJobCreate {
  if (!callerScope) {
    return job;
  }
  return {
    ...job,
    agentId: job.agentId ?? callerScope.agentId,
    owner: {
      agentId: callerScope.agentId,
      ...(callerScope.sessionKey ? { sessionKey: callerScope.sessionKey } : {}),
    },
  };
}

export function cronPatchSessionRefsMatchCaller(
  patch: CronJobPatch,
  callerScope: CronCallerScope | undefined,
): boolean {
  if (!callerScope) {
    return true;
  }
  const sessionAgentId =
    "sessionKey" in patch && typeof patch.sessionKey === "string"
      ? parseAgentIdFromSessionRef(patch.sessionKey)
      : undefined;
  if (sessionAgentId && normalizeAgentId(sessionAgentId) !== callerScope.agentId) {
    return false;
  }
  const sessionTargetAgentId =
    "sessionTarget" in patch && typeof patch.sessionTarget === "string"
      ? parseAgentIdFromCronSessionTarget(patch.sessionTarget)
      : undefined;
  return !sessionTargetAgentId || normalizeAgentId(sessionTargetAgentId) === callerScope.agentId;
}

// Verifies that an accountId is present in the caller agent's configured
// channel route bindings, scoped to a specific channel when known. Foreign
// accounts that belong to another agent must not be accepted even when the
// agentId/session references are valid.
// When channelId is provided, the check is channel-scoped (concrete binding
// match OR wildcard/default binding on that channel). When channelId is
// omitted, the check falls back to any-channel matching.
function isAccountBoundToCallerAgent(params: {
  accountId: string;
  callerAgentId: string;
  cfg: OpenClawConfig;
  channelId?: string;
}): boolean {
  const normalizedChannel = params.channelId
    ? normalizeRouteBindingChannelId(params.channelId)
    : undefined;
  if (normalizedChannel) {
    // Channel-scoped check: concrete match or wildcard/default on this channel.
    return isAccountAuthorizedForAgentChannel({
      cfg: params.cfg,
      agentId: params.callerAgentId,
      accountId: params.accountId,
      channelId: params.channelId!,
    });
  }
  // No channel specified: check across all channels for concrete match or
  // any-channel wildcard/default binding.
  const normalizedAgent = normalizeAgentId(params.callerAgentId);
  const normalizedAccount = normalizeAccountId(params.accountId);
  for (const binding of listRouteBindings(params.cfg)) {
    const resolved = resolveNormalizedRouteBindingMatch(binding);
    if (!resolved) {
      continue;
    }
    if (resolved.agentId === normalizedAgent && resolved.accountId === normalizedAccount) {
      return true;
    }
  }
  for (const binding of listRouteBindings(params.cfg)) {
    const match = binding.match;
    if (!match || typeof match !== "object") {
      continue;
    }
    // Only consider bindings with a valid channel — malformed
    // channelless entries must not silently authorize.
    if (!normalizeRouteBindingChannelId(match.channel)) {
      continue;
    }
    if (normalizeAgentId(binding.agentId) !== normalizedAgent) {
      continue;
    }
    const aid = typeof match.accountId === "string" ? match.accountId.trim() : "";
    if (!aid || aid === "*") {
      return true;
    }
  }
  return false;
}

/**
 * Verifies that every delivery accountId on a cron.create payload is bound to
 * the caller's agent. Call after {@link cronCreateMatchesCallerScope} has
 * already validated agentId, sessionKey, and sessionTarget references.
 */
export function cronDeliveryAccountMatchesCallerScope(params: {
  job: CronJobCreate;
  callerScope: CronCallerScope | undefined;
  cfg: OpenClawConfig;
}): boolean {
  if (!params.callerScope) {
    return true;
  }
  const delivery = params.job.delivery;
  if (!delivery) {
    return true;
  }
  if (delivery.accountId) {
    if (
      !isAccountBoundToCallerAgent({
        accountId: delivery.accountId,
        callerAgentId: params.callerScope.agentId,
        cfg: params.cfg,
        channelId: delivery.channel,
      })
    ) {
      return false;
    }
  }
  if (delivery.failureDestination?.accountId) {
    if (
      !isAccountBoundToCallerAgent({
        accountId: delivery.failureDestination.accountId,
        callerAgentId: params.callerScope.agentId,
        cfg: params.cfg,
        channelId: delivery.failureDestination.channel ?? delivery.channel,
      })
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Verifies that every delivery accountId in a cron.update patch is bound to
 * the caller's agent. Call after {@link cronPatchSessionRefsMatchCaller} has
 * already validated sessionKey and sessionTarget references in the patch.
 */
export function cronPatchDeliveryAccountMatchesCaller(params: {
  patch: CronJobPatch;
  callerScope: CronCallerScope | undefined;
  cfg: OpenClawConfig;
}): boolean {
  if (!params.callerScope) {
    return true;
  }
  const delivery = params.patch.delivery;
  if (!delivery) {
    return true;
  }
  // null means "clear this field" — not an accountId selection.
  if (delivery.accountId && delivery.accountId !== null) {
    if (
      !isAccountBoundToCallerAgent({
        accountId: delivery.accountId,
        callerAgentId: params.callerScope.agentId,
        cfg: params.cfg,
        channelId: delivery.channel ?? undefined,
      })
    ) {
      return false;
    }
  }
  if (delivery.failureDestination?.accountId && delivery.failureDestination.accountId !== null) {
    if (
      !isAccountBoundToCallerAgent({
        accountId: delivery.failureDestination.accountId,
        callerAgentId: params.callerScope.agentId,
        cfg: params.cfg,
        channelId: delivery.failureDestination.channel ?? delivery.channel ?? undefined,
      })
    ) {
      return false;
    }
  }
  return true;
}
