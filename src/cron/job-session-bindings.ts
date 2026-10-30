/** Maps cron jobs to the physical conversations they are bound to. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { tryResolveCronJobEffectiveAgentId } from "./agent-id.js";
import { resolveCronAgentSessionKey } from "./isolated-agent/session-key.js";
import type { CronServiceContract } from "./service-contract.js";
import { resolveCronSessionTargetSessionKey } from "./session-target.js";
import type { CronJob, CronStoredJob } from "./types.js";

type CronJobSessionBinding = Pick<
  CronStoredJob,
  | "id"
  | "agentId"
  | "sessionKey"
  | "sessionTarget"
  | "payloadSourceConversation"
  | "sourceConversation"
  | "owner"
  | "ownerSessionId"
>;

type PreparedBinding = Omit<
  CronJobSessionBinding,
  "payloadSourceConversation" | "sourceConversation" | "owner"
> & {
  payloadSourceSessionKey: string | undefined;
  payloadSourceSessionId: string | undefined;
  sourceSessionKey: string | undefined;
  sourceSessionId: string | undefined;
  ownerAgentId: string | undefined;
  ownerSessionKey: string | undefined;
  defaultAgentId: string | undefined;
  mainKey: string | undefined;
  scope: NonNullable<OpenClawConfig["session"]>["scope"];
  bindings: ReadonlyMap<string, string>;
  identities: readonly CronSessionCleanupIdentity[];
};
const preparedBindings = new WeakMap<CronJobSessionBinding, PreparedBinding[]>();

export type CronSessionCleanupIdentity = {
  sessionKey: string;
  agentId: string;
  sessionId?: string;
};

/**
 * Resolves each canonical session key with its owning agent: the session the run
 * joins (main/isolated/session:<key>) plus the explicit wake/delivery lane in
 * job.sessionKey and the creating conversation retained by source or owner.
 * Keys compare equal to physical Gateway session-store rows; values retain
 * ownership when the key is unqualified.
 */
function prepareCronJobSessionBindings(
  job: CronJobSessionBinding,
  opts: { cfg: OpenClawConfig; defaultAgentId?: string },
): PreparedBinding {
  const mainKey = opts.cfg.session?.mainKey;
  const scope = opts.cfg.session?.scope;
  const payloadSourceSessionKey = job.payloadSourceConversation?.sessionKey;
  const payloadSourceSessionId = job.payloadSourceConversation?.sessionId;
  const sourceSessionKey = job.sourceConversation?.sessionKey;
  const sourceSessionId = job.sourceConversation?.sessionId;
  const ownerAgentId = job.owner?.agentId;
  const ownerSessionKey = job.owner?.sessionKey;
  const prepared = preparedBindings.get(job);
  // These scalar facts are the binding revision, including in-place edits.
  // Keep separate bounded slots for interleaved callers with different routing.
  for (const entry of prepared ?? []) {
    if (
      entry.id === job.id &&
      entry.agentId === job.agentId &&
      entry.sessionKey === job.sessionKey &&
      entry.sessionTarget === job.sessionTarget &&
      entry.payloadSourceSessionKey === payloadSourceSessionKey &&
      entry.payloadSourceSessionId === payloadSourceSessionId &&
      entry.sourceSessionKey === sourceSessionKey &&
      entry.sourceSessionId === sourceSessionId &&
      entry.ownerAgentId === ownerAgentId &&
      entry.ownerSessionKey === ownerSessionKey &&
      entry.ownerSessionId === job.ownerSessionId &&
      entry.defaultAgentId === opts.defaultAgentId &&
      entry.mainKey === mainKey &&
      entry.scope === scope
    ) {
      return entry;
    }
  }
  const bindings = new Map<string, string>();
  const identities: CronSessionCleanupIdentity[] = [];
  const entry: PreparedBinding = {
    id: job.id,
    agentId: job.agentId,
    sessionKey: job.sessionKey,
    sessionTarget: job.sessionTarget,
    payloadSourceSessionKey,
    payloadSourceSessionId,
    sourceSessionKey,
    sourceSessionId,
    ownerAgentId,
    ownerSessionKey,
    ownerSessionId: job.ownerSessionId,
    defaultAgentId: opts.defaultAgentId,
    mainKey,
    scope,
    bindings,
    identities,
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
    return entry;
  }
  const add = (sessionKey: string | undefined, bindingAgentId = agentId, sessionId?: string) => {
    const trimmed = sessionKey?.trim();
    if (!trimmed) {
      return;
    }
    const normalizedBindingAgentId = normalizeAgentId(bindingAgentId);
    // Literal global names the selected agent's physical row; a qualified
    // named target remains distinct. Queue-key qualification has other owners.
    const key =
      scope === "global" && trimmed === "global"
        ? trimmed
        : resolveCronAgentSessionKey({
            sessionKey: trimmed,
            agentId: normalizedBindingAgentId,
            mainKey,
            cfg: opts.cfg,
          });
    const binding = {
      sessionKey: key,
      agentId: parseAgentSessionKey(key)?.agentId ?? normalizedBindingAgentId,
      ...(sessionId ? { sessionId } : {}),
    };
    bindings.set(binding.sessionKey, binding.agentId);
    if (
      !identities.some(
        (existing) =>
          existing.sessionKey === binding.sessionKey &&
          existing.agentId === binding.agentId &&
          existing.sessionId === binding.sessionId,
      )
    ) {
      identities.push(binding);
    }
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
    add(job.payloadSourceConversation?.sessionKey, agentId, payloadSourceSessionId);
    add(job.sourceConversation?.sessionKey, agentId, sourceSessionId);
    add(ownerSessionKey, ownerAgentId?.trim() || agentId, job.ownerSessionId);
  } catch {
    // Malformed persisted targets are quarantined by the store loader; a job
    // that slips through must not break session listing, so bind nothing.
    bindings.clear();
    identities.length = 0;
  }
  return entry;
}

export function resolveCronJobSessionBindings(
  job: CronJobSessionBinding,
  opts: { cfg: OpenClawConfig; defaultAgentId?: string },
): ReadonlyMap<string, string> {
  return prepareCronJobSessionBindings(job, opts).bindings;
}

/** Signals a locked re-check found the job no longer bound; a per-job no-op. */
class CronJobBindingStaleError extends Error {
  constructor() {
    super("cron job binding changed concurrently");
  }
}

export type DisableCronJobsBoundToSessionsResult = {
  disabledBySession: Map<string, string[]>;
  failures: Array<{ jobId?: string; message: string }>;
};

/** Disables enabled jobs bound to any specified session with one job-list scan. */
export async function disableCronJobsBoundToSessions(params: {
  cron: Pick<CronServiceContract, "list" | "updateWithPrecondition" | "getDefaultAgentId">;
  cfg: OpenClawConfig;
  sessions: readonly CronSessionCleanupIdentity[];
}): Promise<DisableCronJobsBoundToSessionsResult> {
  const sessions = params.sessions
    .map((session) => ({
      sessionKey: session.sessionKey.trim(),
      agentId: normalizeAgentId(session.agentId),
      ...(session.sessionId?.trim() ? { sessionId: session.sessionId.trim() } : {}),
    }))
    .filter((session) => session.sessionKey);
  const sessionKeys = [...new Set(sessions.map((session) => session.sessionKey))];
  const disabledBySession = new Map(sessionKeys.map((sessionKey) => [sessionKey, [] as string[]]));
  if (sessionKeys.length === 0) {
    return { disabledBySession, failures: [] };
  }
  let jobs: CronJob[];
  let defaultAgentId: string | undefined;
  try {
    jobs = await params.cron.list();
    defaultAgentId = params.cron.getDefaultAgentId();
  } catch (error) {
    return { disabledBySession, failures: [{ message: formatErrorMessage(error) }] };
  }
  const matchingSessionKeys = (job: CronJobSessionBinding & Pick<CronJob, "enabled">) => {
    if (!job.enabled) {
      return [];
    }
    const bindings = prepareCronJobSessionBindings(job, {
      cfg: params.cfg,
      defaultAgentId,
    }).identities;
    return [
      ...new Set(
        sessions
          .filter((session) => {
            const matchingBindings = bindings.filter(
              (binding) =>
                binding.sessionKey === session.sessionKey && binding.agentId === session.agentId,
            );
            return session.sessionId && matchingBindings.some((binding) => binding.sessionId)
              ? matchingBindings.some((binding) => binding.sessionId === session.sessionId)
              : matchingBindings.length > 0;
          })
          .map((session) => session.sessionKey),
      ),
    ];
  };
  const failures: DisableCronJobsBoundToSessionsResult["failures"] = [];
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
      failures.push({ jobId: job.id, message: formatErrorMessage(error) });
    }
  }
  return { disabledBySession, failures };
}
