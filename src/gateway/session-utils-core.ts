import {
  asNonNegativeFiniteNumber,
  asPositiveFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS,
  shouldKeepSubagentRunChildLink,
} from "../agents/subagents/registry/subagent-run-liveness.js";
import { isTerminalSessionStatus, type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SynchronousWork } from "../shared/synchronous-work.js";
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
  // Derived titles are human content only; UI/TUI/ACP own key-based fallbacks,
  // which an id prefix here would mask.
  return deriveGoalSessionTitle(firstUserMessage) || undefined;
}

export function prepareSessionTitleRead(
  entry: SessionEntry | undefined,
  displayName: string | undefined,
  opts: { includeDerivedTitles?: boolean; includeLastMessage?: boolean },
) {
  if (!entry?.sessionId || !(opts.includeDerivedTitles || opts.includeLastMessage)) {
    return undefined;
  }
  // Metadata wins over transcript text in both scalar and tool rows. Carry
  // that result forward so title-only reads do not hydrate discarded payloads.
  const derivedTitle = opts.includeDerivedTitles
    ? deriveSessionTitle(entry, undefined, displayName)
    : undefined;
  return {
    derivedTitle,
    needsTranscript: opts.includeLastMessage || !derivedTitle,
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
  const input = asPositiveFiniteNumber(params.entry?.inputTokens);
  const output = asPositiveFiniteNumber(params.entry?.outputTokens);
  const cacheRead = asPositiveFiniteNumber(params.entry?.cacheRead);
  const cacheWrite = asPositiveFiniteNumber(params.entry?.cacheWrite);
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
  // Store-only child links lack a live registry entry; retain recent unknown-state rows.
  return (
    entry.status === "running" ||
    isFinitePositiveTimestamp(entry.startedAt) ||
    (isFinitePositiveTimestamp(entry.updatedAt) &&
      now - entry.updatedAt <= STALE_STORE_ONLY_CHILD_LINK_MS)
  );
}

/** Resolve navigation owners from canonical existence and current run liveness. */
export function resolveSessionChildOwners(params: {
  key: string;
  entry: SessionEntry;
  now: number;
  subagentRuns: SessionListRowContext["subagentRuns"];
  hasActiveRun?: boolean;
}): string[] {
  const { key, entry, now, subagentRuns } = params;
  const latest = subagentRuns.getDisplaySubagentRun(key);
  const keep =
    params.hasActiveRun ||
    (latest
      ? shouldKeepSubagentRunChildLink(latest, {
          activeDescendants: subagentRuns.countActiveDescendantRuns(key),
          now,
        })
      : shouldKeepStoreOnlyChildLink(entry, now));
  if (!keep) {
    return [];
  }
  // Runtime control replaces spawnedBy, but explicit navigation lineage survives moves.
  const controller = latest
    ? normalizeOptionalString(latest.controllerSessionKey) ||
      normalizeOptionalString(latest.requesterSessionKey)
    : normalizeOptionalString(entry.spawnedBy);
  const parent = normalizeOptionalString(entry.parentSessionKey);
  return [...new Set([controller, parent])].filter(
    (owner): owner is string => owner !== undefined && owner !== key,
  );
}

export type SessionChildLink = { key: string; entry: SessionEntry };

/** Index only canonical children; retained run results cannot create session links. */
export function* buildStoreChildSessionLinksWork(
  params: {
    store: Record<string, SessionEntry>;
    keys: readonly string[];
    subagentRunsByChildSessionKey: SessionListRowContext["subagentRunsByChildSessionKey"];
  },
  shouldYield?: () => boolean,
): SynchronousWork<Map<string, SessionChildLink[]>> {
  const children = new Map<string, SessionChildLink[]>();
  if (params.keys.length === 0) {
    return children;
  }
  const parents = new Set(params.keys);
  // One store pass discovers both persisted navigation and runtime-only controller links.
  for (const key of Object.keys(params.store)) {
    if (shouldYield?.()) {
      yield;
    }
    const entry = params.store[key];
    if (!entry) {
      continue;
    }
    const runs = params.subagentRunsByChildSessionKey.get(key.trim()) ?? [];
    const owners = new Set([
      ...runs.map(
        (run) =>
          normalizeOptionalString(run.controllerSessionKey) ||
          normalizeOptionalString(run.requesterSessionKey),
      ),
      normalizeOptionalString(entry.spawnedBy),
      normalizeOptionalString(entry.parentSessionKey),
    ]);
    for (const owner of owners) {
      if (owner && owner !== key && parents.has(owner)) {
        const siblings = children.get(owner) ?? [];
        siblings.push({ key, entry });
        children.set(owner, siblings);
      }
    }
  }
  return children;
}
