import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  SESSION_DASHBOARD_ROW_FIELDS,
  SESSION_ROW_DETAIL_FIELDS,
  SESSION_SIDEBAR_ROW_FIELDS,
} from "../../packages/gateway-protocol/src/session-row-fields.js";
import {
  buildSubagentSessionListReadIndex,
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  isSubagentRunLive,
  isSubagentRunPausedForContinuation,
  isSubagentRunQueued,
  resolveSubagentSessionStatus,
} from "../agents/subagents/registry/subagent-registry-read.js";
import {
  isTerminalSessionStatus,
  resolveSessionGoalDisplayState,
  type InternalSessionEntry as SessionEntry,
} from "../config/sessions.js";
import { buildGroupDisplayName, buildGroupDisplayTitle } from "../config/sessions/group-display.js";
import {
  type prepareProjectedAgentRunProgressState,
  resolveProjectedAgentRunProgressState,
} from "../infra/agent-run-registry.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { classifySessionKind } from "../sessions/classify-session-kind.js";
import { sessionDeliveryChannel, sessionDeliveryOrigin } from "../utils/delivery-context.read.js";
import type {
  SessionListActiveRunProjector,
  SessionListRowContext,
} from "./session-utils-contracts.js";
import {
  resolveSessionChildOwners,
  shouldPropagateChildActivity,
  type SessionChildLink,
} from "./session-utils-core.js";
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
  const origin = sessionDeliveryOrigin(entry);
  const privateTelegramTopicTitle =
    channel === "telegram" &&
    !isGroupSession &&
    origin?.provider === "telegram" &&
    origin.chatType === "direct" &&
    origin.threadId != null &&
    normalizeOptionalString(entry?.topicName) !== undefined
      ? buildGroupDisplayTitle({ topicName: entry?.topicName })
      : undefined;
  if (privateTelegramTopicTitle !== undefined) {
    return privateTelegramTopicTitle;
  }
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

type GatewaySessionRunState = {
  subagentRun: ReturnType<SessionListRowContext["subagentRuns"]["getDisplaySubagentRun"]>;
  subagentOwner: string | undefined;
  fields: Pick<
    GatewaySessionRow,
    | "status"
    | "lastRunError"
    | "suppressErrorNotice"
    | "subagentRunState"
    | "hasActiveSubagentRun"
    | "startedAt"
    | "endedAt"
    | "runtimeMs"
  >;
};

export type GatewaySessionRunStateCache = {
  current?: {
    entry: SessionEntry | undefined;
    live: boolean;
    active: boolean;
    clock: number | undefined;
    value: GatewaySessionRunState;
  };
};

export function projectGatewaySessionRunState(params: {
  key: string;
  projectRunProgress?: ReturnType<typeof prepareProjectedAgentRunProgressState>;
  /** Only immutable prepared entry/run facts may retain their presentation. */
  cache?: GatewaySessionRunStateCache;
  parsedKey?: ReturnType<typeof parseAgentSessionKey>;
  entry?: SessionEntry;
  now: number;
  rowContext?: Pick<
    SessionListRowContext,
    "subagentRuns" | "projectedAgentRuns" | "projectedSubagentActivity"
  >;
}): GatewaySessionRunState {
  const { key, entry, now, rowContext } = params;
  const subagentRuns = rowContext?.subagentRuns ?? buildSubagentSessionListReadIndex(now);
  const subagentRun = subagentRuns.getDisplaySubagentRun(key);
  const liveSubagentRunActive = isSubagentRunLive(subagentRun) || isSubagentRunQueued(subagentRun);
  // Follow-up turns retain the child session while owning a different run from its original spawn.
  const hasActiveSubagentRun =
    liveSubagentRunActive ||
    subagentRuns.countActiveDescendantRuns(key) > 0 ||
    ((subagentRun !== null || entry?.spawnedBy !== undefined) &&
      rowContext?.projectedAgentRuns !== undefined &&
      (params.projectRunProgress
        ? params.projectRunProgress(rowContext.projectedAgentRuns)
        : resolveProjectedAgentRunProgressState({
            sessionKeys: [key],
            sessionId: entry?.sessionId,
            agentId:
              (params.parsedKey === undefined ? parseAgentSessionKey(key) : params.parsedKey)
                ?.agentId ?? "",
            index: rowContext.projectedAgentRuns,
          })) !== undefined) ||
    rowContext?.projectedSubagentActivity?.has(key) === true;
  // Clock views and live custody can change without a topology publication.
  // Compare their current facts before reusing an immutable projection.
  const clock = subagentRun && !Number.isFinite(subagentRun.execution.endedAt) ? now : undefined;
  const previous = params.cache?.current;
  if (
    previous &&
    previous.entry === entry &&
    previous.value.subagentRun === subagentRun &&
    previous.live === liveSubagentRunActive &&
    previous.active === hasActiveSubagentRun &&
    previous.clock === clock
  ) {
    return previous.value;
  }
  const subagentOwner =
    normalizeOptionalString(subagentRun?.controllerSessionKey) ||
    normalizeOptionalString(subagentRun?.requesterSessionKey);
  const fields: GatewaySessionRunState["fields"] = {
    status: entry?.status,
    lastRunError: entry?.lastRunError,
    suppressErrorNotice: entry?.suppressErrorNotice,
    subagentRunState: undefined,
    hasActiveSubagentRun: subagentRun || hasActiveSubagentRun ? hasActiveSubagentRun : undefined,
    startedAt: entry?.startedAt,
    endedAt: entry?.endedAt,
    runtimeMs: entry?.runtimeMs,
  };
  if (subagentRun) {
    const endedAt = subagentRun.execution.endedAt;
    const subagentStatus = resolveSubagentSessionStatus(subagentRun);
    // A kill claim keeps the pause marker until its reconciliation commits, so a
    // killed paused child can read "paused" briefly before it reads "killed".
    fields.subagentRunState = liveSubagentRunActive
      ? "active"
      : isSubagentRunPausedForContinuation(subagentRun)
        ? "paused"
        : typeof endedAt === "number" ||
            isTerminalSessionStatus(fields.status) ||
            typeof fields.endedAt === "number"
          ? "historical"
          : "interrupted";
    fields.status = liveSubagentRunActive
      ? subagentStatus
      : (fields.status ?? (typeof endedAt === "number" ? subagentStatus : undefined));
    // A lifecycle start after the spawn run ended belongs to a follow-up turn; do not refill
    // its cleared terminal fields from the finished spawn run.
    const fallbackEndedAt =
      typeof fields.startedAt === "number" &&
      typeof endedAt === "number" &&
      fields.startedAt > endedAt
        ? undefined
        : endedAt;
    fields.startedAt =
      (liveSubagentRunActive ? undefined : fields.startedAt) ??
      getSubagentSessionStartedAt(subagentRun);
    fields.endedAt = liveSubagentRunActive ? endedAt : (fields.endedAt ?? fallbackEndedAt);
    fields.runtimeMs = liveSubagentRunActive
      ? getSubagentSessionRuntimeMs(subagentRun, now)
      : (fields.runtimeMs ??
        (typeof fallbackEndedAt === "number"
          ? getSubagentSessionRuntimeMs(subagentRun, now)
          : undefined));
  }
  const value = { subagentRun, subagentOwner, fields };
  if (params.cache) {
    params.cache.current = {
      entry,
      live: liveSubagentRunActive,
      active: hasActiveSubagentRun,
      clock,
      value,
    };
  }
  return value;
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

/** Shape the wire row after recipient-specific fields have been prepared. */
export function applyGatewaySessionRowMode(
  row: GatewaySessionRow,
  rowMode: GatewaySessionRow["rowMode"],
): void {
  if (rowMode === "dashboard" || rowMode === "sidebar") {
    const fields =
      rowMode === "sidebar" ? SESSION_SIDEBAR_ROW_FIELDS : SESSION_DASHBOARD_ROW_FIELDS;
    for (const field of Object.keys(row)) {
      if (!fields.has(field)) {
        Reflect.deleteProperty(row, field);
      }
    }
    row.rowMode = rowMode;
  } else if (rowMode === "compact") {
    for (const field of SESSION_ROW_DETAIL_FIELDS) {
      delete row[field];
    }
    row.rowMode = "compact";
  }
}

/** One child contribution serves retained aggregates and standalone row presentation. */
export function projectPreparedSessionChild(
  child: SessionChildLink & { parsedKey?: ReturnType<typeof parseAgentSessionKey> },
  parentKey: string,
  now: number,
  rowContext: NonNullable<Parameters<typeof projectGatewaySessionRunState>[0]["rowContext"]>,
) {
  const active = projectGatewaySessionRunState({ ...child, now, rowContext }).fields
    .hasActiveSubagentRun;
  return {
    included: resolveSessionChildOwners({
      ...child,
      now,
      subagentRuns: rowContext.subagentRuns,
      hasActiveRun: active,
    }).includes(parentKey),
    active: active && shouldPropagateChildActivity(child.key, child.entry, parentKey),
  };
}
