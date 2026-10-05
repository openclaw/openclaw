import {
  asNonNegativeFiniteNumber,
  asPositiveFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import {
  RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS,
  shouldKeepSubagentRunChildLink,
} from "../agents/subagents/registry/subagent-run-liveness.js";
import { isTerminalSessionStatus, type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
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

export function matchesSessionArchiveFilter(
  entry: Pick<SessionEntry, "archivedAt">,
  archived: SessionsListParams["archived"],
) {
  return archived === "all" || (entry.archivedAt !== undefined) === (archived === true);
}

export function deriveSessionTitle(
  entry: SessionEntry | undefined,
  firstUserMessage?: string | null,
  externalDisplayName?: string | null,
): string | undefined {
  if (!entry) {
    return undefined;
  }

  // When no model label was persisted, prefer a task-bearing sentence over a
  // raw first-bubble truncation so Control UI and gateway clients stay readable.
  // Derived titles are human content only; UI/TUI/ACP own key-based fallbacks,
  // which an id prefix here would mask.
  return (
    normalizeOptionalString(entry.label) ??
    normalizeOptionalString(externalDisplayName) ??
    normalizeOptionalString(entry.displayName) ??
    normalizeOptionalString(entry.subject) ??
    (deriveGoalSessionTitle(firstUserMessage) || undefined)
  );
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

const emptyChildOwners: readonly string[] = Object.freeze([]);
const sessionChildOwners = new WeakMap<
  SessionEntry,
  {
    revision: object;
    key: string;
    controller?: string;
    parent?: string;
    owners: readonly string[];
  }
>();

/** Reuse owner identities, but recheck time and live authority on every read. */
export function resolveSessionChildOwners(params: {
  key: string;
  entry: SessionEntry;
  now: number;
  subagentRuns: SessionListRowContext["subagentRuns"];
  hasActiveRun?: boolean;
}): readonly string[] {
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
  // Runtime control replaces spawnedBy, but only retained runs own controller links.
  const controller = keep
    ? latest
      ? normalizeOptionalString(latest.controllerSessionKey) ||
        normalizeOptionalString(latest.requesterSessionKey)
      : normalizeOptionalString(entry.spawnedBy)
    : undefined;
  // Persistent dashboard navigation outlives the individual run, including forks.
  const parent =
    keep || parseAgentSessionKey(key)?.rest.startsWith("dashboard:")
      ? normalizeOptionalString(entry.parentSessionKey)
      : undefined;
  const cached = sessionChildOwners.get(entry);
  if (
    cached?.revision === subagentRuns.revision &&
    cached.key === key &&
    cached.controller === controller &&
    cached.parent === parent
  ) {
    return cached.owners;
  }
  const owners: string[] = [];
  if (controller && controller !== key) {
    owners.push(controller);
  }
  if (parent && parent !== key && parent !== controller) {
    owners.push(parent);
  }
  const result = owners.length ? Object.freeze(owners) : emptyChildOwners;
  sessionChildOwners.set(entry, {
    revision: subagentRuns.revision,
    key,
    controller,
    parent,
    owners: result,
  });
  return result;
}

export type SessionChildLink = { key: string; entry: SessionEntry };

/** Select canonical children; retained run results cannot create session links. */
export function readStoreChildSessionLinks(params: {
  store: Record<string, SessionEntry>;
  key: string;
  subagentRunsByChildSessionKey: SessionListRowContext["subagentRunsByChildSessionKey"];
}): SessionChildLink[] | undefined {
  const children: SessionChildLink[] = [];
  // One store pass discovers both persisted navigation and runtime-only controller links.
  for (const key of Object.keys(params.store)) {
    const entry = params.store[key];
    if (!entry || key === params.key || !params.key) {
      continue;
    }
    const runs = params.subagentRunsByChildSessionKey.get(key.trim()) ?? [];
    const owners = [
      ...runs.map(
        (run) =>
          normalizeOptionalString(run.controllerSessionKey) ||
          normalizeOptionalString(run.requesterSessionKey),
      ),
      normalizeOptionalString(entry.spawnedBy),
      normalizeOptionalString(entry.parentSessionKey),
    ];
    if (owners.includes(params.key)) {
      children.push({ key, entry });
    }
  }
  return children.length ? children : undefined;
}
