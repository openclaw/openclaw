/** Process-local index of session keys that enabled cron jobs are bound to. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobBoundSessionKeys } from "../cron/job-session-bindings.js";
import type { CronJob } from "../cron/types.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { sessionChanges } from "../sessions/session-row-changes.js";

type SessionAutomationSource = {
  /** Current in-memory cron jobs; undefined until the cron store is loaded. */
  getJobs: () => readonly CronJob[] | undefined;
  getDefaultAgentId: () => string | undefined;
};

let source: SessionAutomationSource | null = null;
let epochCounter = 0;
let registeredEpoch = 0;

let memo: {
  jobs: readonly CronJob[] | undefined;
  defaultAgentId: string | undefined;
  cfg: OpenClawConfig;
  keys: ReadonlySet<string>;
} | null = null;
// Keep the last publication separate from reader refreshes: cron replaces its
// jobs array before awaited persistence, so a read must not consume that delta.
let publishedKeys: ReadonlySet<string> | undefined;

/**
 * Claimed at cron service build time so registration authority follows build
 * order: a stale service whose start resolves after a config reload cannot
 * clobber the replacement's registration.
 */
export function claimSessionAutomationEpoch(): number {
  return ++epochCounter;
}

/** Registered by the gateway cron owner; newer epochs win over stale services. */
export function registerSessionAutomationSource(
  next: SessionAutomationSource | null,
  epoch?: number,
): void {
  const effectiveEpoch = epoch ?? claimSessionAutomationEpoch();
  if (effectiveEpoch < registeredEpoch) {
    return;
  }
  registeredEpoch = effectiveEpoch;
  source = next;
  invalidateSessionAutomationIndex();
}

/**
 * Owner-compare unregistration: a stopped cron service must not clear a
 * replacement's registration when config reloads race the lazy service build.
 */
export function unregisterSessionAutomationSource(owner: SessionAutomationSource): void {
  if (source !== owner) {
    return;
  }
  source = null;
  invalidateSessionAutomationIndex();
}

/** Called from the cron onEvent hook after any job/store change. */
export function invalidateSessionAutomationIndex(): void {
  // Even an empty source retains the last reader's config so the first added
  // binding can invalidate rows that were materialized before cron loaded.
  if (!memo) {
    return;
  }
  publishAutomationKeys(refreshAutomationKeys(memo.cfg).keys);
}

/** Publish membership deltas without letting speculative reader refreshes consume them. */
function publishAutomationKeys(current: ReadonlySet<string>) {
  const previous = publishedKeys ?? new Set<string>();
  publishedKeys = current;
  // Install the complete snapshot before notifying synchronous consumers.
  for (const identity of new Set([...previous, ...current])) {
    if (previous.has(identity) === current.has(identity)) {
      continue;
    }
    const separator = identity.indexOf("\0");
    sessionChanges.emit({
      scope: "automation",
      sessionKey: separator < 0 ? identity : identity.slice(separator + 1),
      ...(separator < 0 ? {} : { agentId: identity.slice(0, separator) }),
    });
  }
}

function buildAutomationKeys(
  jobs: readonly CronJob[],
  cfg: OpenClawConfig,
  defaultAgentId: string | undefined,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const job of jobs) {
    if (!job.enabled) {
      continue;
    }
    for (const key of resolveCronJobBoundSessionKeys(job, { cfg, defaultAgentId })) {
      const agentId = job.owner?.agentId ?? defaultAgentId;
      if (parseAgentSessionKey(key)) {
        keys.add(key);
      } else if (agentId) {
        keys.add(`${normalizeAgentId(agentId)}\0${key}`);
      }
    }
  }
  return keys;
}

/** Replace the existing memo with a snapshot, never retaining mutable job facts. */
function refreshAutomationKeys(cfg: OpenClawConfig) {
  const jobs = source?.getJobs();
  const defaultAgentId = source?.getDefaultAgentId();
  memo = {
    jobs,
    cfg,
    defaultAgentId,
    keys: buildAutomationKeys(jobs ?? [], cfg, defaultAgentId),
  };
  publishedKeys ??= memo.keys;
  return memo;
}

/** True when an enabled cron job is bound to the canonical session key. */
export function sessionHasAutomation(
  sessionKey: string,
  cfg: OpenClawConfig,
  agentId?: string,
): boolean {
  const jobs = source?.getJobs();
  const defaultAgentId = source?.getDefaultAgentId();
  // Config publications rebuild resident rows; their reads adopt the new
  // routing config even when the cron jobs array itself has not changed.
  const configChanged = memo && memo.cfg !== cfg;
  const current =
    memo && memo.jobs === jobs && memo.cfg === cfg && memo.defaultAgentId === defaultAgentId
      ? memo
      : refreshAutomationKeys(cfg);
  if (configChanged) {
    publishAutomationKeys(current.keys);
  }
  const identity = parseAgentSessionKey(sessionKey)
    ? sessionKey
    : agentId
      ? `${normalizeAgentId(agentId)}\0${sessionKey}`
      : undefined;
  return identity ? current.keys.has(identity) : false;
}
