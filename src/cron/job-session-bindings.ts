/** Maps cron jobs to the physical conversations they are bound to. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { tryResolveCronJobEffectiveAgentId } from "./agent-id.js";
import { resolveCronAgentSessionKey } from "./isolated-agent/session-key.js";
import type { CronServiceContract } from "./service-contract.js";
import { resolveCronSessionTargetSessionKey } from "./session-target.js";
import type { CronJob, CronStoredJob } from "./types.js";

type CronJobSessionBinding = Pick<
  CronStoredJob,
  "id" | "agentId" | "sessionKey" | "sessionTarget" | "sourceConversation"
>;

type PreparedBinding = Omit<CronJobSessionBinding, "sourceConversation"> & {
  sourceSessionKey: string | undefined;
  defaultAgentId: string | undefined;
  mainKey: string | undefined;
  scope: NonNullable<OpenClawConfig["session"]>["scope"];
  bindings: ReadonlyMap<string, string>;
};
const preparedBindings = new WeakMap<CronJobSessionBinding, PreparedBinding[]>();

/**
 * Maps each canonical session key to its owning agent: the session the run
 * joins (main/isolated/session:<key>) plus the explicit wake/delivery lane in
 * job.sessionKey and the creating conversation. Keys compare equal to physical
 * Gateway session-store rows; values retain ownership when the key is unqualified.
 */
export function resolveCronJobSessionBindings(
  job: CronJobSessionBinding,
  opts: { cfg: OpenClawConfig; defaultAgentId?: string },
): ReadonlyMap<string, string> {
  const mainKey = opts.cfg.session?.mainKey;
  const scope = opts.cfg.session?.scope;
  const sourceSessionKey = job.sourceConversation?.sessionKey;
  const prepared = preparedBindings.get(job);
  // These scalar facts are the binding revision, including in-place edits.
  // Keep separate bounded slots for interleaved callers with different routing.
  for (const entry of prepared ?? []) {
    if (
      entry.id === job.id &&
      entry.agentId === job.agentId &&
      entry.sessionKey === job.sessionKey &&
      entry.sessionTarget === job.sessionTarget &&
      entry.sourceSessionKey === sourceSessionKey &&
      entry.defaultAgentId === opts.defaultAgentId &&
      entry.mainKey === mainKey &&
      entry.scope === scope
    ) {
      return entry.bindings;
    }
  }
  const bindings = new Map<string, string>();
  const entry: PreparedBinding = {
    id: job.id,
    agentId: job.agentId,
    sessionKey: job.sessionKey,
    sessionTarget: job.sessionTarget,
    sourceSessionKey,
    defaultAgentId: opts.defaultAgentId,
    mainKey,
    scope,
    bindings,
  };
  if (prepared) {
    if (prepared.length === 4) {
      prepared.shift();
    }
    prepared.push(entry);
  } else {
    preparedBindings.set(job, [entry]);
  }
  const agentId = tryResolveCronJobEffectiveAgentId(job, opts.defaultAgentId);
  if (!agentId) {
    return bindings;
  }
  const add = (sessionKey: string | undefined) => {
    const trimmed = sessionKey?.trim();
    if (!trimmed) {
      return;
    }
    // Literal global names the selected agent's physical row; a qualified
    // named target remains distinct. Queue-key qualification has other owners.
    const key =
      scope === "global" && trimmed === "global"
        ? trimmed
        : resolveCronAgentSessionKey({
            sessionKey: trimmed,
            agentId,
            mainKey,
            cfg: opts.cfg,
          });
    bindings.set(key, parseAgentSessionKey(key)?.agentId ?? agentId);
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
    add(job.sourceConversation?.sessionKey);
  } catch {
    // Malformed persisted targets are quarantined by the store loader; a job
    // that slips through must not break session listing, so bind nothing.
    bindings.clear();
  }
  return bindings;
}

/** Signals a locked re-check found the job no longer bound; a per-job no-op. */
class CronJobBindingStaleError extends Error {
  constructor() {
    super("cron job binding changed concurrently");
  }
}

/** Disables enabled jobs bound to any archived session with one job-list scan. */
export async function disableCronJobsBoundToSessions(params: {
  cron: Pick<CronServiceContract, "list" | "updateWithPrecondition" | "getDefaultAgentId">;
  cfg: OpenClawConfig;
  sessionKeys: readonly string[];
}): Promise<Map<string, string[]>> {
  const sessionKeys = [...new Set(params.sessionKeys.map((key) => key.trim()).filter(Boolean))];
  const disabledBySession = new Map(sessionKeys.map((sessionKey) => [sessionKey, [] as string[]]));
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
    const boundKeys = resolveCronJobSessionBindings(job, {
      cfg: params.cfg,
      defaultAgentId,
    });
    return [...boundKeys.keys()].filter((sessionKey) => targetKeys.has(sessionKey));
  };
  const failures: unknown[] = [];
  for (const job of jobs) {
    if (matchingSessionKeys(job).length === 0) {
      continue;
    }
    try {
      // Re-check the binding under the store lock: a job retargeted after the
      // list snapshot must not be disabled, and one failing/removed job must
      // not abort the remaining bound jobs.
      let lockedMatches: string[] = [];
      await params.cron.updateWithPrecondition(job.id, { enabled: false }, (currentJob) => {
        lockedMatches = matchingSessionKeys(currentJob);
        if (lockedMatches.length === 0) {
          throw new CronJobBindingStaleError();
        }
      });
      for (const sessionKey of lockedMatches) {
        disabledBySession.get(sessionKey)?.push(job.id);
      }
    } catch (error) {
      if (error instanceof CronJobBindingStaleError) {
        continue;
      }
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    const subject =
      sessionKeys.length === 1
        ? `bound to ${sessionKeys[0]}`
        : `bound to ${sessionKeys.length} archived sessions`;
    throw new AggregateError(
      failures,
      `failed to disable ${failures.length} cron job(s) ${subject}`,
    );
  }
  return disabledBySession;
}
