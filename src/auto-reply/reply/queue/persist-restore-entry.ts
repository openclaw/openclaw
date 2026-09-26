// Rebuilds one durable followup-queue row into queue state.
//
// Restore and per-key reconciliation both read rows, and both must apply the
// same fail-closed guards before any queued work can run again. This module owns
// that projection; registering the result and writing SQLite stay in persist.ts.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { defaultRuntime } from "../../../runtime.js";
import { normalizeQueueDropPolicy, normalizeQueueMode } from "./normalize.js";
import {
  isExpiredPersistedFollowup,
  persistedFollowupCarriesInlineImagePayload,
} from "./persist-codec-policy.js";
import {
  createExplicitSkillRestoreResolver,
  describeFollowupForLog,
  hasInvalidExplicitSkillSelections,
  hasInvalidInputProvenance,
  hasInvalidRestrictiveExecOverrides,
  hasInvalidScheduledToolPolicy,
  hasInvalidSessionPermissionPolicy,
  hasInvalidSkillWorkshopProposalRevision,
  hasInvalidTerminalReplyExpectation,
  hasInvalidToolsAllowIntersection,
  isCanceledPersistedFollowup,
  isDelegatedAuthorityPersistedFollowup,
  isDeliveredPersistedFollowup,
  isDiscardedPersistedFollowup,
  isPersistedQueueEntry,
  isPersistedRunFields,
  isRoleDependentPersistedFollowup,
  persistedFollowupItemCarriesInboundContext,
  persistedInputProvenanceCarriesSourceIdentity,
  persistedRunCarriesRawChannelIdentity,
  rehydratePersistedFollowupRun,
  rehydrateRun,
  type ExplicitSkillRestoreResolution,
  type PersistedFollowupRun,
  type PersistedQueueEntry,
  type RestoredExplicitSkillSelections,
} from "./persist-codec.js";
import { createSessionAuthorityRevalidator } from "./persist-session-authority.js";
import type { FollowupQueueState, FollowupRun, QueueDropPolicy } from "./types.js";

const DEFAULT_QUEUE_DEBOUNCE_MS = 500;
const DEFAULT_QUEUE_CAP = 20;
const DEFAULT_QUEUE_DROP: QueueDropPolicy = "summarize";

/** Per-restore revalidation against current config and live session state. */
export type RestoreRevalidation = {
  resolveExplicitSkillSelections: (item: PersistedFollowupRun) => ExplicitSkillRestoreResolution;
  sessionAuthorityChanged: (item: PersistedFollowupRun) => boolean;
};

export function createRestoreRevalidation(currentConfig: OpenClawConfig): RestoreRevalidation {
  return {
    resolveExplicitSkillSelections: createExplicitSkillRestoreResolver(currentConfig),
    sessionAuthorityChanged: createSessionAuthorityRevalidator(currentConfig),
  };
}

type RestoreFailCloseGuard = {
  blocks: (item: PersistedFollowupRun, revalidation: RestoreRevalidation) => boolean;
  reason: string;
};

/**
 * Restore fail-close guards, evaluated in order. Pairing each predicate with
 * its log reason keeps the block decision and the operator-facing message from
 * drifting apart.
 */
const RESTORE_FAIL_CLOSE_GUARDS: readonly RestoreFailCloseGuard[] = [
  {
    blocks: (item) => isRoleDependentPersistedFollowup(item),
    reason: "role-dependent work cannot revalidate member roles after restart",
  },
  {
    blocks: (item) => isDelegatedAuthorityPersistedFollowup(item),
    reason: "delegated handoff or plugin tool grant cannot be revalidated after restart",
  },
  {
    blocks: (item) => persistedRunCarriesRawChannelIdentity(item.run),
    reason: "sender-admitted work cannot revalidate channel access after restart",
  },
  {
    blocks: (item) => isCanceledPersistedFollowup(item),
    reason: "canceled work cannot execute after restart",
  },
  {
    blocks: (item) => isDeliveredPersistedFollowup(item),
    reason: "already-delivered work cannot replay after restart",
  },
  {
    blocks: (item) => isDiscardedPersistedFollowup(item),
    reason: "undelivered completed work cannot replay after restart",
  },
  {
    blocks: (item) => persistedFollowupCarriesInlineImagePayload(item),
    reason: "inline image payloads are never retained across restarts",
  },
  {
    blocks: (item) => isExpiredPersistedFollowup(item),
    reason: "queued work exceeded the bounded retention window",
  },
  {
    blocks: (item) => hasInvalidScheduledToolPolicy(item.run),
    reason: "scheduled tool policy is missing or invalid after restart",
  },
  {
    blocks: (item) => hasInvalidSessionPermissionPolicy(item.run),
    reason: "session permission policy is missing or invalid after restart",
  },
  {
    blocks: (item, revalidation) => revalidation.sessionAuthorityChanged(item),
    reason: "session permission or tool overrides changed while the turn waited",
  },
  {
    blocks: (item) => hasInvalidRestrictiveExecOverrides(item.run),
    reason: "exec override policy is missing or invalid after restart",
  },
  {
    blocks: (item) => hasInvalidSkillWorkshopProposalRevision(item.run),
    reason: "Skill Workshop revision constraint is missing or invalid after restart",
  },
  {
    blocks: (item) => hasInvalidTerminalReplyExpectation(item.run),
    reason: "terminal reply expectation is missing or invalid after restart",
  },
  {
    blocks: (item) => hasInvalidInputProvenance(item.run),
    reason: "input provenance is missing or invalid after restart",
  },
  {
    blocks: (item) => hasInvalidToolsAllowIntersection(item),
    reason: "tool allowlist intersection cannot restore without toolsAllow",
  },
  {
    blocks: (item, revalidation) =>
      hasInvalidExplicitSkillSelections(item, revalidation.resolveExplicitSkillSelections),
    reason: "explicit skill selections are missing or invalid after restart",
  },
];

function findRestoreFailCloseReason(
  item: PersistedFollowupRun,
  revalidation: RestoreRevalidation,
): string | undefined {
  return RESTORE_FAIL_CLOSE_GUARDS.find((guard) => guard.blocks(item, revalidation))?.reason;
}

function isUnrestorablePersistedFollowup(
  item: PersistedFollowupRun,
  revalidation: RestoreRevalidation,
): boolean {
  return findRestoreFailCloseReason(item, revalidation) !== undefined;
}

function failClosedUnrestorablePersistedFollowup(
  queueKey: string,
  item: PersistedFollowupRun,
  revalidation: RestoreRevalidation,
): boolean {
  const reason = findRestoreFailCloseReason(item, revalidation);
  if (reason === undefined) {
    return false;
  }
  defaultRuntime.error?.(
    `fail-closed restored followup for ${queueKey}: ${reason} (${describeFollowupForLog(item)})`,
  );
  return true;
}

function rehydrateRestorablePersistedFollowups(
  queueKey: string,
  items: readonly PersistedFollowupRun[],
  currentConfig: OpenClawConfig,
  pairedLines?: readonly string[],
  revalidation: RestoreRevalidation = createRestoreRevalidation(currentConfig),
): { restored: FollowupRun[]; restoredLines: string[]; skippedUnrestorable: boolean } {
  const candidates: Array<{
    item: PersistedFollowupRun;
    line?: string;
    explicitSkillSelections?: RestoredExplicitSkillSelections;
  }> = [];
  let skippedUnrestorable = false;
  if (pairedLines !== undefined && pairedLines.length !== items.length) {
    skippedUnrestorable = true;
  }
  const limit =
    pairedLines === undefined ? items.length : Math.min(items.length, pairedLines.length);
  for (let index = 0; index < limit; index += 1) {
    const item = items[index]!;
    if (failClosedUnrestorablePersistedFollowup(queueKey, item, revalidation)) {
      skippedUnrestorable = true;
      continue;
    }
    const explicitSkillSelections = revalidation.resolveExplicitSkillSelections(item);
    candidates.push({
      item,
      line: pairedLines?.[index],
      ...(explicitSkillSelections.status === "ok"
        ? { explicitSkillSelections: explicitSkillSelections.selections }
        : {}),
    });
  }
  for (let index = limit; index < items.length; index += 1) {
    skippedUnrestorable = true;
    failClosedUnrestorablePersistedFollowup(queueKey, items[index]!, revalidation);
  }

  const restored: FollowupRun[] = [];
  const restoredLines: string[] = [];
  for (const candidate of candidates) {
    const [kept] = filterRestorableFollowupItems(queueKey, [
      rehydratePersistedFollowupRun(
        candidate.item,
        currentConfig,
        candidate.explicitSkillSelections,
      ),
    ]);
    if (!kept) {
      skippedUnrestorable = true;
      continue;
    }
    const persisted = candidate.item;
    // A fresh revalidator per call: the restore-time one memoizes session reads,
    // so reusing it here would report the authority as it stood at restore.
    kept.restoredSessionAuthorityChanged = () =>
      createSessionAuthorityRevalidator(currentConfig)(persisted);
    restored.push(kept);
    if (candidate.line !== undefined) {
      restoredLines.push(candidate.line);
    }
  }
  return { restored, restoredLines, skippedUnrestorable };
}

function filterRestorableFollowupItems(queueKey: string, items: FollowupRun[]): FollowupRun[] {
  const restored: FollowupRun[] = [];
  for (const item of items) {
    const sessionKey = normalizeOptionalString(item.run.sessionKey);
    if (sessionKey && sessionKey !== queueKey && !queueKey.startsWith(`${sessionKey}:`)) {
      defaultRuntime.error?.(
        `skipping restored followup for ${queueKey}: sessionKey ${sessionKey} does not match queue key`,
      );
      continue;
    }
    const channel = normalizeOptionalString(item.originatingChannel);
    const to = normalizeOptionalString(item.originatingTo);
    if ((channel && !to) || (!channel && to)) {
      defaultRuntime.error?.(
        `skipping restored followup for ${queueKey}: incomplete originating route (${channel ?? "?"} -> ${to ?? "?"})`,
      );
      continue;
    }
    restored.push(item);
  }
  return restored;
}

export function isDeliverablePersistedFollowup(
  queueKey: string,
  item: PersistedFollowupRun,
  revalidation: RestoreRevalidation,
): boolean {
  const sessionKey = normalizeOptionalString(item.run.sessionKey);
  if (sessionKey && sessionKey !== queueKey && !queueKey.startsWith(`${sessionKey}:`)) {
    return false;
  }
  const channel = normalizeOptionalString(item.originatingChannel);
  const to = normalizeOptionalString(item.originatingTo);
  if ((channel && !to) || (!channel && to)) {
    return false;
  }
  return !isUnrestorablePersistedFollowup(item, revalidation);
}

/**
 * Bind restored work to the fresh queue abort controller so `clearFollowupQueue`
 * can cancel restarted items and overflow sources through the normal drain path.
 */
function bindRestoredRunsToQueueAbort(queue: FollowupQueueState): void {
  const signal = queue.abortController.signal;
  for (const item of queue.items) {
    item.queueAbortSignal = signal;
  }
  for (const source of queue.summarySources) {
    source.queueAbortSignal = signal;
  }
  for (const elision of queue.summaryElisions) {
    for (const source of elision.sources) {
      source.queueAbortSignal = signal;
    }
  }
}

function persistedQueueEntryRuns(data: PersistedQueueEntry): PersistedFollowupRun["run"][] {
  return [
    ...data.items.map((item) => item.run),
    ...(data.summarySources ?? []).map((item) => item.run),
    ...(data.summaryElisions ?? []).flatMap((elision) =>
      elision.sources.map((source) => source.run),
    ),
    ...(data.lastRun ? [data.lastRun] : []),
  ];
}

function persistedQueueEntryCarriesRawInputProvenance(data: PersistedQueueEntry): boolean {
  return persistedQueueEntryRuns(data).some(persistedInputProvenanceCarriesSourceIdentity);
}

function persistedQueueEntryCarriesRawChannelIdentity(data: PersistedQueueEntry): boolean {
  return persistedQueueEntryRuns(data).some(persistedRunCarriesRawChannelIdentity);
}

function persistedQueueEntryCarriesInboundContext(data: PersistedQueueEntry): boolean {
  return [
    ...data.items,
    ...(data.summarySources ?? []),
    ...(data.summaryElisions ?? []).flatMap((elision) => elision.sources),
  ].some(persistedFollowupItemCarriesInboundContext);
}

export type RestoredFollowupQueueEntry = {
  /** Rebuilt queue state; undefined when nothing in the row can restore. */
  queue: FollowupQueueState | undefined;
  /** Fail-closed or sanitized content the caller must rewrite out of SQLite. */
  needsRewrite: boolean;
};

/**
 * Rebuild one durable queue row without registering it. Items that fail closed
 * are logged and dropped here; the caller persists when `needsRewrite` is set so
 * the dropped or sanitized content also leaves SQLite.
 */
export function restorePersistedFollowupQueueEntry(
  key: string,
  rawData: unknown,
  currentConfig: OpenClawConfig,
  revalidation: RestoreRevalidation,
): RestoredFollowupQueueEntry {
  if (!isPersistedQueueEntry(rawData)) {
    return { queue: undefined, needsRewrite: true };
  }
  const data = rawData;
  const sanitizedClosedDescriptor =
    persistedQueueEntryCarriesRawInputProvenance(data) ||
    persistedQueueEntryCarriesRawChannelIdentity(data) ||
    persistedQueueEntryCarriesInboundContext(data);
  const itemsRestore = rehydrateRestorablePersistedFollowups(
    key,
    data.items,
    currentConfig,
    undefined,
    revalidation,
  );
  let skippedUnrestorable = itemsRestore.skippedUnrestorable;
  const rehydratedItems = itemsRestore.restored;
  const originalSummarySources = data.summarySources ?? [];
  const originalSummaryLines = Array.isArray(data.summaryLines) ? data.summaryLines : [];
  const summaryRestore = rehydrateRestorablePersistedFollowups(
    key,
    originalSummarySources,
    currentConfig,
    originalSummaryLines,
    revalidation,
  );
  skippedUnrestorable ||= summaryRestore.skippedUnrestorable;
  const rehydratedSummarySources = summaryRestore.restored;
  let removedOverflowCount = originalSummarySources.length - rehydratedSummarySources.length;
  const restoredElisions = (data.summaryElisions ?? []).flatMap((elision) => {
    let droppedElision = false;
    for (const source of elision.sources) {
      if (failClosedUnrestorablePersistedFollowup(key, source, revalidation)) {
        skippedUnrestorable = true;
        droppedElision = true;
      }
    }
    if (droppedElision) {
      removedOverflowCount += elision.sources.length;
      return [];
    }
    const sources = filterRestorableFollowupItems(
      key,
      elision.sources.map((persisted) => {
        const resolved = revalidation.resolveExplicitSkillSelections(persisted);
        return rehydratePersistedFollowupRun(
          persisted,
          currentConfig,
          resolved.status === "ok" ? resolved.selections : undefined,
        );
      }),
    );
    if (sources.length === 0 || sources.length !== elision.sources.length) {
      skippedUnrestorable = true;
      removedOverflowCount += elision.sources.length;
      return [];
    }
    return [
      {
        contextKey: elision.contextKey,
        count: elision.count,
        sources,
        summaryLines: [...elision.summaryLines],
        sourceRefs: new WeakMap<FollowupRun, FollowupRun>(),
      },
    ];
  });
  const hasSummaryPayload = rehydratedSummarySources.length > 0 || restoredElisions.length > 0;
  if (rehydratedItems.length === 0 && !hasSummaryPayload) {
    return { queue: undefined, needsRewrite: skippedUnrestorable || sanitizedClosedDescriptor };
  }
  const originalDroppedCount =
    typeof data.droppedCount === "number" ? Math.max(0, Math.floor(data.droppedCount)) : 0;
  const restoredDroppedCount = hasSummaryPayload
    ? Math.max(0, originalDroppedCount - removedOverflowCount)
    : 0;
  const restored: FollowupQueueState = {
    abortController: new AbortController(),
    items: rehydratedItems,
    draining: false,
    inFlight: new Set(),
    lastEnqueuedAt: typeof data.lastEnqueuedAt === "number" ? data.lastEnqueuedAt : Date.now(),
    mode: normalizeQueueMode(data.mode) ?? "steer",
    debounceMs:
      typeof data.debounceMs === "number"
        ? Math.max(0, data.debounceMs)
        : DEFAULT_QUEUE_DEBOUNCE_MS,
    cap: typeof data.cap === "number" && data.cap > 0 ? Math.floor(data.cap) : DEFAULT_QUEUE_CAP,
    dropPolicy: normalizeQueueDropPolicy(data.dropPolicy) ?? DEFAULT_QUEUE_DROP,
    droppedCount: restoredDroppedCount,
    summaryLines: hasSummaryPayload ? summaryRestore.restoredLines : [],
    summarySources: rehydratedSummarySources,
    steerAcceptanceTail: Promise.resolve(true),
    activeSummarySources: new WeakSet(),
    summaryElisions: restoredElisions,
    evictedSummaryCount:
      typeof data.evictedSummaryCount === "number"
        ? Math.max(0, Math.floor(data.evictedSummaryCount))
        : 0,
    ...(isPersistedRunFields(data.lastRun)
      ? { lastRun: rehydrateRun(data.lastRun, currentConfig) }
      : {}),
  };
  bindRestoredRunsToQueueAbort(restored);
  return { queue: restored, needsRewrite: skippedUnrestorable || sanitizedClosedDescriptor };
}
