import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  buildSubagentSessionListReadIndex,
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  isSubagentRunLive,
  isSubagentRunQueued,
  resolveSubagentSessionStatus,
} from "../agents/subagents/registry/subagent-registry-read.js";
import {
  isTerminalSessionStatus,
  buildGroupDisplayName,
  buildGroupDisplayTitle,
  resolveSessionGoalDisplayState,
  type SessionEntry,
} from "../config/sessions.js";
import { resolveProjectedAgentRunProgressState } from "../infra/agent-run-registry.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { classifySessionKind } from "../sessions/classify-session-kind.js";
import { sessionDeliveryChannel, sessionDeliveryOrigin } from "../utils/delivery-context.shared.js";
import type {
  SessionListActiveRunProjector,
  SessionListRowContext,
} from "./session-utils-contracts.js";
import { isGroupOrChannelDisplaySession, parseGroupKey } from "./session-utils-store.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

export function resolveGatewaySessionDisplayName(key: string, entry?: SessionEntry) {
  // Explicit renames outrank channel metadata and generated titles.
  const explicitLabel = normalizeOptionalString(entry?.label);
  if (explicitLabel !== undefined) {
    return explicitLabel;
  }
  const parsed = parseGroupKey(key);
  const isGroupSession = isGroupOrChannelDisplaySession(entry, parsed);
  const groupTitle = isGroupSession ? buildGroupDisplayTitle(entry ?? {}) : undefined;
  if (groupTitle !== undefined) {
    return groupTitle;
  }
  const channel = sessionDeliveryChannel(entry) ?? parsed?.channel;
  const id = parsed?.id;
  const compactGroupFallback =
    isGroupSession && channel
      ? buildGroupDisplayName({
          provider: channel,
          subject: entry?.subject,
          topicName: entry?.topicName,
          groupChannel: entry?.groupChannel,
          space: entry?.space,
          id,
          key,
        })
      : undefined;
  const storedDisplayName =
    channel === "imessage" && isGroupSession && entry?.displayName === compactGroupFallback
      ? undefined
      : entry?.displayName;
  const displayName =
    storedDisplayName ??
    entry?.autoLabel ??
    (channel === "imessage" ? undefined : compactGroupFallback);
  if (displayName !== undefined) {
    return displayName;
  }
  // Dashboard origin labels identify the sender, not the conversation.
  if (parseAgentSessionKey(key)?.rest.startsWith("dashboard:")) {
    return undefined;
  }
  const origin = sessionDeliveryOrigin(entry);
  const originLabel = origin?.label;
  const normalizedOriginFrom = normalizeOptionalString(origin?.from);
  const routeIdentityTail = normalizedOriginFrom?.split(":").at(-1);
  const routeIdentityTailIsOpaque =
    routeIdentityTail != null &&
    (routeIdentityTail.includes("@") || /^[+]?[\d\s().-]+$/.test(routeIdentityTail));
  const originIsRouteIdentity =
    originLabel != null &&
    (originLabel === normalizedOriginFrom ||
      (routeIdentityTailIsOpaque && originLabel === routeIdentityTail));
  const originIsGenericGroupFallback =
    channel === "imessage" &&
    isGroupSession &&
    id != null &&
    originLabel?.toLowerCase() === `group id:${id.toLowerCase()}`;
  return originIsRouteIdentity || originIsGenericGroupFallback ? undefined : originLabel;
}

export function resolveGatewaySessionKind(key: string, entry?: SessionEntry) {
  const sessionKind = classifySessionKind(key, entry);
  // The older Gateway wire kind folds cron/spawn-child into direct.
  const gatewayKind =
    sessionKind === "cron" || sessionKind === "spawn-child" ? "direct" : sessionKind;
  return gatewayKind;
}

export function projectGatewaySessionRunState(params: {
  key: string;
  entry?: SessionEntry;
  now: number;
  rowContext?: Pick<
    SessionListRowContext,
    "subagentRuns" | "projectedAgentRuns" | "projectedSubagentActivity"
  >;
}) {
  const { key, entry, now, rowContext } = params;
  const subagentRuns = rowContext?.subagentRuns ?? buildSubagentSessionListReadIndex(now);
  const subagentRun = subagentRuns.getDisplaySubagentRun(key);
  const subagentOwner =
    normalizeOptionalString(subagentRun?.controllerSessionKey) ||
    normalizeOptionalString(subagentRun?.requesterSessionKey);
  const liveSubagentRunActive = isSubagentRunLive(subagentRun) || isSubagentRunQueued(subagentRun);
  const hasProjectedRun = (sessionKey: string, sessionId?: string) => {
    if (!rowContext?.projectedAgentRuns) {
      return false;
    }
    const state = resolveProjectedAgentRunProgressState({
      sessionKeys: [sessionKey],
      sessionId,
      index: rowContext.projectedAgentRuns,
    });
    return state !== undefined;
  };
  // Follow-up turns retain the child session while owning a different run from its original spawn.
  const hasActiveSubagentRun =
    liveSubagentRunActive ||
    subagentRuns.countActiveDescendantRuns(key) > 0 ||
    ((subagentRun !== null || entry?.spawnedBy !== undefined) &&
      hasProjectedRun(key, entry?.sessionId)) ||
    rowContext?.projectedSubagentActivity?.has(key) === true;
  const fields: Pick<
    GatewaySessionRow,
    "status" | "subagentRunState" | "hasActiveSubagentRun" | "startedAt" | "endedAt" | "runtimeMs"
  > = {
    status: entry?.status === "interrupted" ? "failed" : entry?.status,
    subagentRunState: undefined,
    hasActiveSubagentRun: subagentRun || hasActiveSubagentRun ? hasActiveSubagentRun : undefined,
    startedAt: entry?.startedAt,
    endedAt: entry?.endedAt,
    runtimeMs: entry?.runtimeMs,
  };
  if (subagentRun) {
    const endedAt = subagentRun.execution.endedAt;
    fields.subagentRunState = liveSubagentRunActive
      ? "active"
      : typeof endedAt === "number" ||
          isTerminalSessionStatus(fields.status) ||
          typeof fields.endedAt === "number"
        ? "historical"
        : "interrupted";
    fields.status = liveSubagentRunActive
      ? resolveSubagentSessionStatus(subagentRun)
      : fields.status === "running"
        ? undefined
        : (fields.status ??
          (typeof endedAt === "number" ? resolveSubagentSessionStatus(subagentRun) : undefined));
    fields.startedAt =
      (liveSubagentRunActive ? undefined : fields.startedAt) ??
      getSubagentSessionStartedAt(subagentRun);
    fields.endedAt = liveSubagentRunActive ? endedAt : (fields.endedAt ?? endedAt);
    fields.runtimeMs = liveSubagentRunActive
      ? getSubagentSessionRuntimeMs(subagentRun, now)
      : (fields.runtimeMs ??
        (typeof endedAt === "number" ? getSubagentSessionRuntimeMs(subagentRun, now) : undefined));
  }
  return { subagentRun, subagentOwner, fields };
}

export function resolveGatewaySessionGoal(
  entry: SessionEntry | undefined,
  now: number,
  usage:
    | Pick<SessionEntry, "totalTokens" | "totalTokensFresh" | "totalTokensVersion">
    | undefined = entry,
) {
  // Listing is read-only; only goal commands may adopt and persist a fresh baseline.
  return entry?.goal
    ? resolveSessionGoalDisplayState({ ...usage, goal: entry.goal }, now, {
        adoptFreshBaseline: false,
      })
    : undefined;
}

export function projectGatewaySessionActiveRun(
  active: ReturnType<SessionListActiveRunProjector> | undefined,
  status: GatewaySessionRow["status"],
): Pick<GatewaySessionRow, "status" | "hasActiveRun"> {
  return {
    hasActiveRun: active?.active,
    status: active?.active ? (active.status ?? "running") : status,
  };
}
