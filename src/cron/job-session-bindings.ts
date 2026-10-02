/** Maps cron jobs to the canonical session-store keys they are bound to. */
import { tryGetLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { tryResolveCronJobEffectiveAgentId } from "./agent-id.js";
import { resolveCronAgentSessionKey } from "./isolated-agent/session-key.js";
import type { CronServiceContract } from "./service-contract.js";
import { resolveCronSessionTargetSessionKey } from "./session-target.js";
import type { CronJob } from "./types.js";

type CronJobSessionBinding = Pick<CronJob, "id" | "agentId" | "sessionKey" | "sessionTarget">;

/**
 * Resolves every canonical session key a job is bound to: the session the run
 * joins (main/isolated/session:<key>) plus the explicit wake/delivery lane in
 * job.sessionKey. Keys use the same canonicalization as cron run/session
 * creation, so they compare equal to gateway session-store row keys.
 */
export function resolveCronJobBoundSessionKeys(
  job: CronJobSessionBinding,
  opts: { cfg: OpenClawConfig; defaultAgentId?: string },
): Set<string> {
  const keys = new Set<string>();
  const legacyDefaultAgentId = tryGetLegacyDefaultAgentId(opts.cfg);
  const agentId = legacyDefaultAgentId
    ? tryResolveCronJobEffectiveAgentId(job, opts.defaultAgentId, legacyDefaultAgentId)
    : normalizeAgentId(job.agentId ?? opts.defaultAgentId);
  if (!agentId) {
    return keys;
  }
  const add = (sessionKey: string | undefined) => {
    const trimmed = sessionKey?.trim();
    if (!trimmed) {
      return;
    }
    keys.add(
      resolveCronAgentSessionKey({
        sessionKey: trimmed,
        agentId,
        mainKey: opts.cfg.session?.mainKey,
        cfg: opts.cfg,
      }),
    );
  };
  try {
    if (job.sessionTarget === "main") {
      add("main");
    } else if (job.sessionTarget === "isolated" || job.sessionTarget === "current") {
      // Gateway execution runs isolated jobs — and stale persisted "current"
      // targets, which patches can store un-resolved — in the deterministic
      // cron:<jobId> session (server-cron.ts falls back to it for non-session
      // targets); job.sessionKey is only a delivery/wake lane, added below.
      add(`cron:${job.id}`);
    } else {
      add(resolveCronSessionTargetSessionKey(job.sessionTarget));
    }
    add(job.sessionKey);
  } catch {
    // Malformed persisted targets are quarantined by the store loader; a job
    // that slips through must not break session listing, so bind nothing.
    keys.clear();
  }
  return keys;
}

/** Signals a locked re-check found the job no longer bound; a per-job no-op. */
class CronJobBindingStaleError extends Error {
  constructor() {
    super("cron job binding changed concurrently");
  }
}

type CronSessionPauseResult = {
  disabledJobIds: string[];
  failures: Array<{ jobId: string; error: unknown }>;
};

/** Disables bound jobs in one scan, retaining successful pauses when another job fails. */
export async function disableCronJobsBoundToSessions(params: {
  cron: Pick<CronServiceContract, "list" | "updateWithPrecondition" | "getDefaultAgentId">;
  cfg: OpenClawConfig;
  sessionKeys: readonly string[];
  assertSessionCurrent?: (sessionKey: string) => void;
}): Promise<Map<string, CronSessionPauseResult>> {
  const sessionKeys = [...new Set(params.sessionKeys.map((key) => key.trim()).filter(Boolean))];
  const disabledBySession = new Map<string, CronSessionPauseResult>(
    sessionKeys.map((sessionKey) => [sessionKey, { disabledJobIds: [], failures: [] }]),
  );
  if (sessionKeys.length === 0) {
    return disabledBySession;
  }
  const targetKeys = new Set(sessionKeys);
  const jobs = await params.cron.list();
  const defaultAgentId = params.cron.getDefaultAgentId();
  const matchingSessionKeys = (job: CronJobSessionBinding & Pick<CronJob, "enabled">) => {
    if (!job.enabled) {
      return [];
    }
    const boundKeys = resolveCronJobBoundSessionKeys(job, {
      cfg: params.cfg,
      defaultAgentId,
    });
    return [...boundKeys].filter((sessionKey) => targetKeys.has(sessionKey));
  };
  for (const job of jobs) {
    let matchedKeys = matchingSessionKeys(job);
    if (matchedKeys.length === 0) {
      continue;
    }
    try {
      // Re-check the binding under the store lock: a job retargeted after the
      // list snapshot must not be disabled, and one failing/removed job must
      // not abort the remaining bound jobs.
      await params.cron.updateWithPrecondition(
        job.id,
        { enabled: false },
        (currentJob) => {
          matchedKeys = matchingSessionKeys(currentJob);
          if (matchedKeys.length === 0) {
            throw new CronJobBindingStaleError();
          }
        },
        {
          // The precondition may yield; live authority belongs at the cron commit boundary.
          commitGuard: () => {
            for (const sessionKey of matchedKeys) {
              params.assertSessionCurrent?.(sessionKey);
            }
          },
        },
      );
      for (const sessionKey of matchedKeys) {
        disabledBySession.get(sessionKey)?.disabledJobIds.push(job.id);
      }
    } catch (error) {
      if (error instanceof CronJobBindingStaleError) {
        continue;
      }
      for (const sessionKey of matchedKeys) {
        disabledBySession.get(sessionKey)?.failures.push({ jobId: job.id, error });
      }
    }
  }
  return disabledBySession;
}
