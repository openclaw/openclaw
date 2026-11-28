import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronAgentSessionKey } from "./isolated-agent/session-key.js";
import { prepareCronSession } from "./isolated-agent/session.js";
import {
  isDetachedCronSessionTarget,
  resolveCronSessionTargetSessionKey,
} from "./session-target.js";
import type { CronStoredJob } from "./types.js";

/** Read the same carried preferences and native resume identity as a scheduled run. */
export async function prepareCronInferenceDiagnosticSession(params: {
  cfg: OpenClawConfig;
  agentId: string;
  signal?: AbortSignal;
  job: Pick<CronStoredJob, "id" | "sessionTarget" | "sessionKey">;
}) {
  const { cfg, agentId, job, signal } = params;
  signal?.throwIfAborted();
  const targetKey = resolveCronSessionTargetSessionKey(job.sessionTarget);
  const sessionKey = resolveCronAgentSessionKey({
    cfg,
    agentId,
    sessionKey: targetKey ?? `cron:${job.id}`,
  });
  if (targetKey) {
    // Session-event admission pins the existing incarnation even after configured expiry.
    const read = await readSessionEntriesFromStoreInWorker({
      agentId,
      sessionKeys: [sessionKey],
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
    });
    signal?.throwIfAborted();
    const entry = read.entries[0]?.entry;
    if (entry) {
      return { sessionEntry: entry, initialSessionEntry: entry, isNewSession: false };
    }
    // With no incarnation to pin, retain the existing fresh-session preparation.
  }
  return prepareCronSession({
    cfg,
    agentId,
    sessionKey,
    sourceSessionKey:
      job.sessionTarget === "current" && job.sessionKey
        ? resolveCronAgentSessionKey({ cfg, agentId, sessionKey: job.sessionKey })
        : undefined,
    forceNew: isDetachedCronSessionTarget(job.sessionTarget),
    exactRunSession: true,
    nowMs: Date.now(),
  });
}
