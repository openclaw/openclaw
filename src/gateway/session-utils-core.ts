import {
  asNonNegativeFiniteNumber,
  asPositiveFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  countActiveDescendantRuns,
  getSessionDisplaySubagentRunByChildSessionKey,
} from "../agents/subagents/registry/subagent-registry-read.js";
import {
  RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS,
  shouldKeepSubagentRunChildLink,
} from "../agents/subagents/registry/subagent-run-liveness.js";
import { isTerminalSessionStatus, type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  estimateAggregateUsageCost,
  type ModelCostConfig,
  resolveModelCostConfig,
} from "../utils/usage-format.js";
import { deriveGoalSessionTitle } from "./derive-goal-session-title.js";
import {
  createSessionRowModelCacheKey,
  type SessionListRowContext,
} from "./session-utils-contracts.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

export function deriveSessionTitle(
  entry: SessionEntry | undefined,
  firstUserMessage?: string | null,
  externalDisplayName?: string | null,
): string | undefined {
  if (!entry) {
    return undefined;
  }

  const label = normalizeOptionalString(entry.label);
  if (label) {
    return label;
  }

  const displayName =
    normalizeOptionalString(externalDisplayName) ?? normalizeOptionalString(entry.displayName);
  if (displayName) {
    return displayName;
  }

  const subject = normalizeOptionalString(entry.subject);
  if (subject) {
    return subject;
  }

  // When no model label was persisted, prefer a task-bearing sentence over a
  // raw first-bubble truncation so Control UI and gateway clients stay readable.
  const goalTitle = deriveGoalSessionTitle(firstUserMessage);
  if (goalTitle) {
    return goalTitle;
  }

  // Derived titles are human content only; UI/TUI/ACP own key-based fallbacks,
  // which an id prefix here would mask.
  return undefined;
}

export function resolvePositiveNumber(value: number | null | undefined): number | undefined {
  return asPositiveFiniteNumber(value);
}

type SessionCompactionCheckpointEntry = NonNullable<SessionEntry["compactionCheckpoints"]>[number];

function isProjectableCompactionCheckpoint(
  value: unknown,
): value is SessionCompactionCheckpointEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const checkpoint = value as {
    checkpointId?: unknown;
    createdAt?: unknown;
    reason?: unknown;
  };
  return (
    Boolean(normalizeOptionalString(checkpoint.checkpointId)) &&
    typeof checkpoint.createdAt === "number" &&
    Number.isFinite(checkpoint.createdAt) &&
    (checkpoint.reason === "manual" ||
      checkpoint.reason === "auto-threshold" ||
      checkpoint.reason === "overflow-retry" ||
      checkpoint.reason === "timeout-retry")
  );
}

export function resolveProjectableCompactionCheckpoints(
  entry?: Pick<SessionEntry, "compactionCheckpoints"> | null,
): SessionCompactionCheckpointEntry[] {
  const checkpoints = entry?.compactionCheckpoints;
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return [];
  }
  return checkpoints.filter(isProjectableCompactionCheckpoint);
}

export function resolveLatestCompactionCheckpoint(
  checkpoints: readonly SessionCompactionCheckpointEntry[],
): SessionCompactionCheckpointEntry | undefined {
  return checkpoints.reduce<SessionCompactionCheckpointEntry | undefined>(
    (latest, checkpoint) =>
      !latest || checkpoint.createdAt > latest.createdAt ? checkpoint : latest,
    undefined,
  );
}

export function buildCompactionCheckpointPreview(
  checkpoint: SessionCompactionCheckpointEntry | undefined,
): GatewaySessionRow["latestCompactionCheckpoint"] {
  if (!checkpoint) {
    return undefined;
  }
  const checkpointId = normalizeOptionalString(checkpoint.checkpointId);
  const createdAt = checkpoint.createdAt;
  const reason = checkpoint.reason;
  if (!checkpointId || typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
    return undefined;
  }
  if (
    reason !== "manual" &&
    reason !== "auto-threshold" &&
    reason !== "overflow-retry" &&
    reason !== "timeout-retry"
  ) {
    return undefined;
  }
  return {
    checkpointId,
    createdAt,
    reason,
  };
}

function resolveModelCostConfigCached(
  provider: string | undefined,
  model: string | undefined,
  cfg: OpenClawConfig,
  rowContext?: SessionListRowContext,
): ModelCostConfig | undefined {
  if (!rowContext) {
    return resolveModelCostConfig({ provider, model, config: cfg });
  }
  const key = createSessionRowModelCacheKey(provider, model);
  if (rowContext.modelCostConfigByModelRef.has(key)) {
    return rowContext.modelCostConfigByModelRef.get(key);
  }
  const value = resolveModelCostConfig({ provider, model, config: cfg });
  rowContext.modelCostConfigByModelRef.set(key, value);
  return value;
}

export function resolveEstimatedSessionCostUsd(params: {
  cfg: OpenClawConfig;
  provider?: string;
  model?: string;
  entry?: Pick<
    SessionEntry,
    "estimatedCostUsd" | "inputTokens" | "outputTokens" | "cacheRead" | "cacheWrite"
  >;
  explicitCostUsd?: number;
  rowContext?: SessionListRowContext;
}): number | undefined {
  const explicitCostUsd = asNonNegativeFiniteNumber(
    params.explicitCostUsd ?? params.entry?.estimatedCostUsd,
  );
  if (explicitCostUsd !== undefined) {
    return explicitCostUsd;
  }
  const input = resolvePositiveNumber(params.entry?.inputTokens);
  const output = resolvePositiveNumber(params.entry?.outputTokens);
  const cacheRead = resolvePositiveNumber(params.entry?.cacheRead);
  const cacheWrite = resolvePositiveNumber(params.entry?.cacheWrite);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }
  const cost = resolveModelCostConfigCached(
    params.provider,
    params.model,
    params.cfg,
    params.rowContext,
  );
  if (!cost) {
    return undefined;
  }
  const estimated = estimateAggregateUsageCost({
    usage: {
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    },
    cost,
  });
  return asNonNegativeFiniteNumber(estimated);
}

const STALE_STORE_ONLY_CHILD_LINK_MS = 60 * 60 * 1_000;

export function isFinitePositiveTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function shouldKeepStoreOnlyChildLink(entry: SessionEntry, now: number): boolean {
  if (isTerminalSessionStatus(entry.status) || isFinitePositiveTimestamp(entry.endedAt)) {
    const endedAt = isFinitePositiveTimestamp(entry.endedAt) ? entry.endedAt : entry.updatedAt;
    return (
      isFinitePositiveTimestamp(endedAt) && now - endedAt <= RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS
    );
  }
  if (entry.status === "running" || isFinitePositiveTimestamp(entry.startedAt)) {
    return true;
  }
  // Store-only child links lack a live subagent registry entry. Keep recent
  // unknown-state rows visible briefly so reloads do not hide fresh children.
  return (
    isFinitePositiveTimestamp(entry.updatedAt) &&
    now - entry.updatedAt <= STALE_STORE_ONLY_CHILD_LINK_MS
  );
}

/** Resolve navigation owners from canonical existence and current run liveness. */
export function resolveSessionChildOwners(params: {
  key: string;
  entry: SessionEntry;
  now: number;
  subagentRuns?: SessionListRowContext["subagentRuns"];
}): string[] {
  const { key, entry, now, subagentRuns } = params;
  const latest = subagentRuns
    ? subagentRuns.getDisplaySubagentRun(key)
    : getSessionDisplaySubagentRunByChildSessionKey(key);
  const keep = latest
    ? shouldKeepSubagentRunChildLink(latest, {
        activeDescendants: subagentRuns
          ? subagentRuns.countActiveDescendantRuns(key)
          : countActiveDescendantRuns(key),
        now,
      })
    : shouldKeepStoreOnlyChildLink(entry, now);
  if (!keep) {
    return [];
  }
  // Runtime control replaces spawnedBy, but explicit navigation lineage survives moves.
  const controller = latest
    ? normalizeOptionalString(latest.controllerSessionKey) ||
      normalizeOptionalString(latest.requesterSessionKey)
    : normalizeOptionalString(entry.spawnedBy);
  return [...new Set([controller, normalizeOptionalString(entry.parentSessionKey)])].filter(
    (owner): owner is string => Boolean(owner) && owner !== key,
  );
}

/** Index only canonical children; retained run results cannot create session links. */
export function buildStoreChildSessionIndex(params: {
  store: Record<string, SessionEntry>;
  keys: readonly string[];
  now: number;
  subagentRuns?: SessionListRowContext["subagentRuns"];
  excludedChildKeys?: ReadonlySet<string>;
}): Map<string, string[]> {
  const children = new Map<string, string[]>();
  if (params.keys.length === 0) {
    return children;
  }
  const parents = new Set(params.keys);
  // One store pass discovers both persisted navigation and runtime-only controller links.
  for (const [key, entry] of Object.entries(params.store)) {
    if (!entry || params.excludedChildKeys?.has(key)) {
      continue;
    }
    for (const owner of resolveSessionChildOwners({ ...params, key, entry })) {
      if (parents.has(owner)) {
        const siblings = children.get(owner) ?? [];
        siblings.push(key);
        children.set(owner, siblings);
      }
    }
  }
  return children;
}
