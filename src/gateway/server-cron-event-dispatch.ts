import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildCronCommandSummary } from "../cron/command-output-summary.js";
import { resolveCronStoredDeliveryContext } from "../cron/delivery-context.js";
import type { CronService } from "../cron/service.js";
import type { CronServiceDeps } from "../cron/service/state.js";
import { resolveCronSessionTargetSessionKey } from "../cron/session-target.js";
import type { CronJob, CronPayload, CronStoredJob } from "../cron/types.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import { enqueueSystemEventWithReceipt } from "../infra/system-events.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { createDeferredCore } from "../shared/deferred.js";
import { truncateUtf16WithEllipsis } from "../shared/text-truncate.js";
import type { CronExitResult } from "./cron-exit-watchers.js";
import type { CronStreamFireDisposition } from "./cron-stream-watchers.js";

type ResolveCronTarget = (opts?: {
  agentId?: string | null;
  sessionKey?: string | null;
  preserveUntargeted?: boolean;
}) => {
  runtimeConfig: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
};

/** Admits a stored job's occurrence with the agent and config its executors resolve. */
export async function admitGatewayCronOccurrence(
  job: CronStoredJob,
  resolveAgent: (requested?: string | null) => { agentId: string; cfg: OpenClawConfig },
) {
  const { agentId, cfg } = resolveAgent(job.agentId);
  const { admitScheduledOccurrence } = await import("../cron/execution-context-admission.js");
  return await admitScheduledOccurrence({ cfg, job, agentId, trigger: "cron" });
}

export async function runGatewayCronSessionEvent(
  request: Parameters<NonNullable<CronServiceDeps["runSessionEvent"]>>[0],
  resolveTarget: ResolveCronTarget,
) {
  const sessionKey = resolveCronSessionTargetSessionKey(request.job.sessionTarget);
  const target = resolveTarget({ agentId: request.job.agentId, sessionKey });
  if (!target.agentId || !target.sessionKey) {
    return { status: "error" as const, error: "Automation has no valid session destination" };
  }
  const canonicalRequest = sessionKey
    ? canonicalizeMainSessionAlias({
        cfg: target.runtimeConfig,
        agentId: target.agentId,
        sessionKey,
      })
    : undefined;
  const sessionAgentId = parseAgentSessionKey(canonicalRequest)?.agentId;
  if (sessionAgentId && normalizeAgentId(sessionAgentId) !== normalizeAgentId(target.agentId)) {
    return {
      status: "error" as const,
      error:
        "Automation session target belongs to another agent; update agentId or sessionTarget before retrying",
    };
  }
  const { runCronSessionTurn } = await import("../cron/session-run.js");
  return await runCronSessionTurn({
    ...request,
    cfg: target.runtimeConfig,
    agentId: target.agentId,
    sessionKey: target.sessionKey,
  });
}

export function resolveGatewayCronOriginDeliveryContext(
  opts: Parameters<NonNullable<CronServiceDeps["resolveOriginDeliveryContext"]>>[0],
  resolveTarget: ResolveCronTarget,
) {
  // Global scope removes the key's agent prefix; retain the selected store owner.
  const { runtimeConfig, agentId, sessionKey } = resolveTarget({
    ...opts,
    preserveUntargeted: true,
  });
  return sessionKey
    ? resolveCronStoredDeliveryContext({ cfg: runtimeConfig, agentId, sessionKey })
    : undefined;
}

export function enqueueCronSystemEvent(
  text: string,
  opts: Parameters<CronServiceDeps["enqueueSystemEvent"]>[1],
  target: { agentId?: string; sessionKey?: string },
) {
  const { agentId, sessionKey } = target;
  if (!agentId || !sessionKey) {
    throw new Error("Cron system event target did not resolve an owner and session key.");
  }
  const adoption = createDeferredCore<boolean>();
  const remove = enqueueSystemEventWithReceipt(
    text,
    withSystemEventOwner(
      { sessionKey, contextKey: opts?.contextKey, deliveryContext: opts?.deliveryContext },
      agentId,
    ),
    { onSettled: adoption.resolve },
  );
  return remove ? { accepted: true, remove, adopted: adoption.promise } : { accepted: false };
}

export function formatOnExitRunSummary(exit: CronExitResult): string {
  const lines = [
    "Watched command finished.",
    `Exit code: ${exit.exitCode ?? "none"}`,
    `Reason: ${exit.reason}`,
  ];
  const output = buildCronCommandSummary({ stdout: exit.stdout, stderr: exit.stderr });
  return output ? `${lines.join("\n")}\n\nOutput:\n${output}` : lines.join("\n");
}

/**
 * On-exit jobs share cron execution, history, notifications, and delivery.
 * The admission owner builds their payload from its authoritative job snapshot.
 */
export async function fireOnExitJob(
  job: CronJob,
  exit: CronExitResult,
  deps: {
    run: (
      jobId: string,
      payload: (current: CronJob) => CronPayload | undefined,
    ) => ReturnType<CronService["run"]>;
  },
): Promise<void> {
  const summary = formatOnExitRunSummary(exit);
  const result = await deps.run(job.id, (current) => {
    const payload = current.payload;
    return payload.kind === "systemEvent"
      ? { ...payload, text: `${payload.text}\n\n${summary}` }
      : payload.kind === "agentTurn"
        ? { ...payload, message: `${payload.message}\n\n${summary}` }
        : undefined;
  });
  if (!result.ok || !("ran" in result && result.ran)) {
    // Retiring a one-shot must not hide refused admission behind a fulfilled callback.
    // Keep bounded terminal evidence in the watcher's existing failure log.
    const reason = "reason" in result ? result.reason : "run did not start";
    const evidence = truncateUtf16WithEllipsis(summary, 2_000);
    throw new Error(`cron on-exit run was not admitted: ${reason}\n\n${evidence}`);
  }
}

/** Fire one source batch through the normal trigger and payload pipeline. */
export async function fireStreamJob(
  job: CronJob,
  deps: {
    // No payload override: cron.run snapshots the persisted payload under its
    // admission lock, so a batch never executes the owner's stale cache.
    run: (
      jobId: string,
      onDisposition: (disposition: Exclude<CronStreamFireDisposition, "not-run">) => void,
    ) => Promise<{ ok: boolean; ran?: boolean; reason?: string; enabled?: boolean }>;
  },
): Promise<CronStreamFireDisposition> {
  let disposition: Exclude<CronStreamFireDisposition, "not-run"> | undefined;
  const result = await deps.run(job.id, (value) => {
    disposition = value;
  });
  if (!disposition && result.ok && result.ran === false && result.reason === "already-running") {
    return "busy";
  }
  if (disposition === "fired" && result.enabled === false) {
    return "disabled";
  }
  return disposition ?? (result.ok && result.ran === true ? "fired" : "not-run");
}
