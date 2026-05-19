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
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { performGatewaySessionReset } from "./session-reset-service.js";

const DAILY_SESSION_RESET_INTERVAL_MS = 60_000;

const log = createSubsystemLogger("session-daily-reset");

export type DailySessionResetResult = {
  checked: number;
  reset: number;
  errors: number;
};

export async function resetStaleDailySessions(params: {
  cfg: OpenClawConfig;
  nowMs?: number;
  activeSessionKeys?: ReadonlySet<string>;
  performReset?: (key: string) => Promise<{ ok: boolean }>;
}): Promise<DailySessionResetResult> {
  const now = params.nowMs ?? Date.now();
  const performReset =
    params.performReset ??
    ((key: string) =>
      performGatewaySessionReset({
        key,
        reason: "daily",
        commandSource: "daily-session-reset-scheduler",
      }));
  let checked = 0;
  let reset = 0;
  let errors = 0;

  for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg)) {
    const store = loadSessionStore(target.storePath, { skipCache: true });
    for (const [sessionKey, entry] of Object.entries(store)) {
      if (!entry?.sessionId || typeof entry.updatedAt !== "number") {
        continue;
      }
      if (params.activeSessionKeys?.has(sessionKey)) {
        continue;
      }
      const resetType = resolveSessionResetType({ sessionKey });
      const resetPolicy = resolveSessionResetPolicy({
        sessionCfg: params.cfg.session,
        resetType,
        resetOverride: resolveChannelResetConfig({
          sessionCfg: params.cfg.session,
          channel: entry.lastChannel ?? entry.channel ?? entry.origin?.provider,
        }),
      });
      if (resetPolicy.mode !== "daily") {
        continue;
      }
      if (hasProviderOwnedSession(entry, resetPolicy.configured === true)) {
        continue;
      }
      checked += 1;
      const freshness = evaluateSessionFreshness({
        updatedAt: entry.updatedAt,
        ...resolveSessionLifecycleTimestamps({
          entry,
          agentId: target.agentId,
          storePath: target.storePath,
        }),
        now,
        policy: resetPolicy,
      });
      if (freshness.fresh) {
        continue;
      }
      const result = await performReset(sessionKey);
      if (result.ok) {
        reset += 1;
      } else {
        errors += 1;
      }
    }
  }

  return { checked, reset, errors };
}

function hasProviderOwnedSession(entry: SessionEntry | undefined, resetConfigured: boolean) {
  if (resetConfigured) {
    return false;
  }
  const provider = normalizeOptionalString(entry?.providerOverride ?? entry?.modelProvider);
  return Boolean(provider && getCliSessionBinding(entry, provider));
}

export function startDailySessionResetScheduler(params: {
  cfg: OpenClawConfig;
  intervalMs?: number;
  getActiveSessionKeys?: () => ReadonlySet<string>;
}): ReturnType<typeof setInterval> {
  let inFlight = false;
  const run = () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    void resetStaleDailySessions({
      cfg: params.cfg,
      activeSessionKeys: params.getActiveSessionKeys?.(),
    })
      .then((result) => {
        if (result.reset > 0 || result.errors > 0) {
          log.info("daily session reset sweep complete", result);
        }
      })
      .catch((err) => {
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
