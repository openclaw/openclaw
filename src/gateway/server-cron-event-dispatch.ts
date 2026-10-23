import { canonicalizeMainSessionAlias } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildCronCommandSummary } from "../cron/command-output-summary.js";
import type { CronService } from "../cron/service.js";
import type { CronServiceDeps } from "../cron/service/state.js";
import { resolveCronSessionTargetSessionKey } from "../cron/session-target.js";
import type { CronJob, CronPayload } from "../cron/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { truncateUtf16WithEllipsis } from "../shared/text-truncate.js";
import type { CronExitResult } from "./cron-exit-watchers.js";
import type { CronStreamFireDisposition } from "./cron-stream-watchers.js";

type ResolveCronTarget = (opts?: {
  agentId?: string | null;
  sessionKey?: string | null;
  preserveUntargeted?: boolean;
}) => { runtimeConfig: OpenClawConfig; agentId?: string; sessionKey?: string };

export async function runGatewayCronSessionEvent(
  request: Parameters<NonNullable<CronServiceDeps["runSessionEvent"]>>[0],
  resolveTarget: ResolveCronTarget,
) {
  const requestedSessionKey = resolveCronSessionTargetSessionKey(request.job.sessionTarget);
  const target = resolveTarget({ agentId: request.job.agentId, sessionKey: requestedSessionKey });
  if (!target.agentId || !target.sessionKey) {
    return { status: "error" as const, error: "Automation has no valid session destination" };
  }
  const canonicalRequest = requestedSessionKey
    ? canonicalizeMainSessionAlias({
        cfg: target.runtimeConfig,
        agentId: target.agentId,
        sessionKey: requestedSessionKey,
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
