import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getCliSessionBinding } from "../agents/cli-session.js";
import { resolveSessionLifecycleTimestamps } from "../config/sessions/lifecycle.js";
import {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
} from "../config/sessions/reset.js";
import { loadSessionStore } from "../config/sessions/store.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { performGatewaySessionReset } from "./session-reset-service.js";
import { resolveSessionStoreKey } from "./session-store-key.js";
import {
  resolveFreshestSessionStoreMatchFromStoreKeys,
  resolveGatewaySessionStoreTarget,
} from "./session-utils.js";

const DAILY_SESSION_RESET_INTERVAL_MS = 60_000;

const log = createSubsystemLogger("session-daily-reset");

export type DailySessionResetResult = {
  checked: number;
  reset: number;
  errors: number;
};

export type DailySessionResetExpectedEntry = {
  sessionId: string;
  updatedAt: number;
};

export type DailySessionResetContext = {
  agentId?: string;
};

export async function resetStaleDailySessions(params: {
  cfg: OpenClawConfig;
  nowMs?: number;
  activeSessionKeys?: ReadonlySet<string>;
  onSuccessfulReset?: (payload: { sessionKey: string; agentId?: string }) => void;
  performReset?: (
    key: string,
    expectedEntry?: DailySessionResetExpectedEntry,
    context?: DailySessionResetContext,
  ) => Promise<{ ok: boolean; skipped?: boolean }>;
}): Promise<DailySessionResetResult> {
  const now = params.nowMs ?? Date.now();
  const performReset =
    params.performReset ??
    (async (
      key: string,
      expectedEntry?: DailySessionResetExpectedEntry,
      context?: DailySessionResetContext,
    ) => {
      const result = await performGatewaySessionReset({
        key,
        agentId: context?.agentId,
        reason: "daily",
        commandSource: "daily-session-reset-scheduler",
        expectedDailySession: expectedEntry,
      });
      if (
        !result.ok &&
        result.error.details &&
        typeof result.error.details === "object" &&
        (result.error.details as { skippedDailyReset?: unknown }).skippedDailyReset === true
      ) {
        return { ok: false, skipped: true };
      }
      return result.ok ? { ok: true } : { ok: false };
    });
  let checked = 0;
  let reset = 0;
  let errors = 0;

  for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg)) {
    const store = loadSessionStore(target.storePath, { skipCache: true });
    const visitedStoreKeys = new Set<string>();
    for (const [sessionKey, entry] of Object.entries(store)) {
      if (visitedStoreKeys.has(sessionKey)) {
        continue;
      }
      if (!entry?.sessionId || typeof entry.updatedAt !== "number") {
        continue;
      }
      const sessionTarget = resolveGatewaySessionStoreTarget({
        cfg: params.cfg,
        key: sessionKey,
        agentId: target.agentId,
      });
      if (sessionTarget.storePath !== target.storePath) {
        continue;
      }
      const authoritativeStore = loadSessionStore(sessionTarget.storePath, { skipCache: true });
      for (const storeKey of sessionTarget.storeKeys) {
        visitedStoreKeys.add(storeKey);
      }
      const resetSessionKey = sessionTarget.canonicalKey;
      const activeSessionKeys = params.activeSessionKeys;
      if (
        activeSessionKeys &&
        hasActiveSessionTarget({
          activeSessionKeys,
          agentId: sessionTarget.agentId,
          cfg: params.cfg,
          canonicalKey: resetSessionKey,
          storeKeys: sessionTarget.storeKeys,
        })
      ) {
        continue;
      }
      const freshestMatch = resolveFreshestSessionStoreMatchFromStoreKeys(
        authoritativeStore,
        sessionTarget.storeKeys,
      );
      if (!freshestMatch) {
        continue;
      }
      const resetEntry = freshestMatch.entry;
      if (!resetEntry?.sessionId || typeof resetEntry.updatedAt !== "number") {
        continue;
      }
      const resetType = resolveSessionResetType({ sessionKey: resetSessionKey });
      const resetPolicy = resolveSessionResetPolicy({
        sessionCfg: params.cfg.session,
        resetType,
        resetOverride: resolveChannelResetConfig({
          sessionCfg: params.cfg.session,
          channel: resetEntry.lastChannel ?? resetEntry.channel ?? resetEntry.origin?.provider,
        }),
      });
      if (resetPolicy.mode !== "daily") {
        continue;
      }
      if (hasProviderOwnedSession(resetEntry, resetPolicy.configured === true)) {
        continue;
      }
      checked += 1;
      const lifecycle = resolveSessionLifecycleTimestamps({
        entry: resetEntry,
        agentId: sessionTarget.agentId,
        storePath: sessionTarget.storePath,
      });
      const freshness = evaluateSessionFreshness({
        updatedAt: resetEntry.updatedAt,
        ...lifecycle,
        now,
        policy: resetPolicy,
      });
      if (
        !isDailyBoundaryStale({
          entry: resetEntry,
          dailyResetAt: freshness.dailyResetAt,
          sessionStartedAt: lifecycle.sessionStartedAt,
        })
      ) {
        continue;
      }
      const latestStore = loadSessionStore(sessionTarget.storePath, { skipCache: true });
      const latestMatch = resolveFreshestSessionStoreMatchFromStoreKeys(
        latestStore,
        sessionTarget.storeKeys,
      );
      const latestEntry = latestMatch?.entry;
      if (!latestEntry?.sessionId || typeof latestEntry.updatedAt !== "number") {
        continue;
      }
      const latestResetPolicy = resolveSessionResetPolicy({
        sessionCfg: params.cfg.session,
        resetType: resolveSessionResetType({ sessionKey: resetSessionKey }),
        resetOverride: resolveChannelResetConfig({
          sessionCfg: params.cfg.session,
          channel: latestEntry.lastChannel ?? latestEntry.channel ?? latestEntry.origin?.provider,
        }),
      });
      if (
        latestResetPolicy.mode !== "daily" ||
        hasProviderOwnedSession(latestEntry, latestResetPolicy.configured === true)
      ) {
        continue;
      }
      const latestLifecycle = resolveSessionLifecycleTimestamps({
        entry: latestEntry,
        agentId: sessionTarget.agentId,
        storePath: sessionTarget.storePath,
      });
      const latestFreshness = evaluateSessionFreshness({
        updatedAt: latestEntry.updatedAt,
        ...latestLifecycle,
        now,
        policy: latestResetPolicy,
      });
      if (
        !isDailyBoundaryStale({
          entry: latestEntry,
          dailyResetAt: latestFreshness.dailyResetAt,
          sessionStartedAt: latestLifecycle.sessionStartedAt,
        })
      ) {
        continue;
      }
      const result = await performReset(
        resetSessionKey,
        {
          sessionId: latestEntry.sessionId,
          updatedAt: latestEntry.updatedAt,
        },
        {
          agentId: sessionTarget.agentId,
        },
      );
      if (result.ok) {
        reset += 1;
        params.onSuccessfulReset?.({
          sessionKey: resetSessionKey,
          agentId: sessionTarget.agentId,
        });
      } else if (!("skipped" in result && result.skipped)) {
        errors += 1;
      }
    }
  }

  return { checked, reset, errors };
}

function isDailyBoundaryStale(params: {
  entry: SessionEntry;
  dailyResetAt: number | undefined;
  sessionStartedAt?: number;
}): boolean {
  const dailyResetAt = params.dailyResetAt;
  if (dailyResetAt == null) {
    return false;
  }
  const sessionStartedAt =
    typeof params.sessionStartedAt === "number" &&
    Number.isFinite(params.sessionStartedAt) &&
    params.sessionStartedAt >= 0
      ? params.sessionStartedAt
      : params.entry.updatedAt;
  return sessionStartedAt < dailyResetAt;
}

function hasProviderOwnedSession(entry: SessionEntry | undefined, resetConfigured: boolean) {
  if (resetConfigured) {
    return false;
  }
  const provider = normalizeOptionalString(entry?.providerOverride ?? entry?.modelProvider);
  return Boolean(provider && getCliSessionBinding(entry, provider));
}

function hasActiveSessionTarget(params: {
  activeSessionKeys: ReadonlySet<string>;
  agentId?: string;
  cfg: OpenClawConfig;
  canonicalKey: string;
  storeKeys: string[];
}) {
  for (const activeKey of params.activeSessionKeys) {
    if (params.storeKeys.includes(activeKey)) {
      return true;
    }
    const activeCanonicalKey = resolveSessionStoreKey({
      cfg: params.cfg,
      sessionKey: activeKey,
      storeAgentId: params.agentId,
    });
    if (activeCanonicalKey === params.canonicalKey) {
      return true;
    }
  }
  return false;
}

export function startDailySessionResetScheduler(params: {
  cfg: OpenClawConfig;
  getConfig?: () => OpenClawConfig;
  intervalMs?: number;
  getNowMs?: () => number;
  getActiveSessionKeys?: () => ReadonlySet<string>;
  onSuccessfulReset?: (payload: { sessionKey: string; agentId?: string }) => void;
  performReset?: (
    key: string,
    expectedEntry?: DailySessionResetExpectedEntry,
    context?: DailySessionResetContext,
  ) => Promise<{ ok: boolean }>;
}): ReturnType<typeof setInterval> {
  let inFlight = false;
  const run = () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    void resetStaleDailySessions({
      cfg: params.getConfig?.() ?? params.cfg,
      nowMs: params.getNowMs?.(),
      activeSessionKeys: params.getActiveSessionKeys?.(),
      onSuccessfulReset: params.onSuccessfulReset,
      performReset: params.performReset,
    })
      .then((result) => {
        if (result.reset > 0 || result.errors > 0) {
          log.info("daily session reset sweep complete", result);
        }
      })
      .catch((err: unknown) => {
        log.warn("daily session reset sweep failed", { error: String(err) });
      })
      .finally(() => {
        inFlight = false;
      });
  };

  run();
  const timer = setInterval(run, params.intervalMs ?? DAILY_SESSION_RESET_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
