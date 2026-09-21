// Builds restart sentinel payloads for update handoff reporting.
import { formatDoctorNonInteractiveHint, type RestartSentinelPayload } from "./restart-sentinel.js";
import { updateRunStepKey } from "./update-run-step-key.js";
import { isUpdateGatewayReadinessPending } from "./update-run-step.js";
import type { UpdateRunResult } from "./update-runner.js";

export type ForegroundUpdateOrigin = {
  owner: string;
  pid: number;
  host: string;
  startedAt: number;
  port: number;
  stateDatabasePath: string;
  configPath: string;
};

// Update restart sentinel payloads carry update result details across a process
// restart so the next gateway can report completion or failure.
/** Metadata needed to route update restart continuation messages. */
export type UpdateRestartSentinelMeta = {
  runId?: string;
  /** The foreground replacement Gateway verifies success after the CLI settles. */
  completionOwner?: "gateway-restart";
  foregroundOrigin?: ForegroundUpdateOrigin;
  /** Internal helper fact: when the owning service stop was issued. */
  serviceStoppedAtMs?: number;
  root?: string;
  target?: string;
  sessionKey?: string;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
  };
  threadId?: string;
  handoffId?: string;
  note?: string | null;
  continuationMessage?: string | null;
};

export function normalizeControlPlaneUpdateResult(input: UpdateRunResult): UpdateRunResult {
  const lint = input.postUpdate?.plugins?.doctorLint;
  const result =
    lint && !input.steps.some((step) => step.name === lint.name)
      ? { ...input, steps: [...input.steps, lint] }
      : input;
  if (
    (result.status === "ok" ||
      (result.status === "skipped" && result.reason === "already-current")) &&
    isUpdateGatewayReadinessPending(result)
  ) {
    return {
      ...result,
      status: "skipped",
      reason:
        result.reason === "still-starting" ? "still-starting" : "gateway-readiness-unverified",
    };
  }
  return result;
}

function resolvePersistedRecovery(result: UpdateRunResult): UpdateRunResult["recovery"] {
  const recovery = result.recovery;
  if (!recovery) {
    return undefined;
  }
  // Restored runtimes parse this strictly; keep new diagnostics in the update result.
  return recovery.serviceRestartSafe
    ? {
        serviceRestartSafe: true,
        version: recovery.version,
        buildId: recovery.buildId,
        service: recovery.service,
      }
    : { serviceRestartSafe: false, reason: recovery.reason };
}

/** Build the restart sentinel payload written after update runs. */
export function buildUpdateRestartSentinelPayload(params: {
  result: UpdateRunResult;
  meta: UpdateRestartSentinelMeta;
  nowMs?: number;
}): RestartSentinelPayload {
  const result = normalizeControlPlaneUpdateResult(params.result);
  const recovery = resolvePersistedRecovery(result);
  const { meta } = params;
  const continuationMessage = result.status === "ok" ? meta.continuationMessage?.trim() : undefined;
  const continuation: RestartSentinelPayload["continuation"] = continuationMessage
    ? { kind: "agentTurn", message: continuationMessage }
    : null;
  return {
    kind: "update",
    status: result.status,
    ts: params.nowMs ?? Date.now(),
    ...(meta.sessionKey ? { sessionKey: meta.sessionKey } : {}),
    ...(meta.deliveryContext ? { deliveryContext: meta.deliveryContext } : {}),
    ...(meta.threadId ? { threadId: meta.threadId } : {}),
    message: meta.note ?? null,
    ...(continuation ? { continuation } : {}),
    doctorHint: formatDoctorNonInteractiveHint(),
    stats: {
      ...(meta.runId || result.runId ? { runId: meta.runId ?? result.runId } : {}),
      mode: result.mode,
      ...(meta.root || result.root ? { root: meta.root ?? result.root } : {}),
      ...(meta.target ? { target: meta.target } : {}),
      ...(meta.handoffId ? { handoffId: meta.handoffId } : {}),
      ...(recovery ? { recovery } : {}),
      before: result.before ?? null,
      after: result.after ?? null,
      steps: result.steps.map((step) => ({
        name: updateRunStepKey(step.name),
        command: step.command,
        cwd: step.cwd,
        durationMs: step.durationMs,
        ...(step.advisory ? { advisory: true } : {}),
        ...(step.failureFacts?.length ? { failureFacts: step.failureFacts } : {}),
        log: {
          stdoutTail: step.stdoutTail ?? null,
          stderrTail: step.stderrTail ?? null,
          exitCode: step.exitCode ?? null,
        },
      })),
      reason: result.reason ?? null,
      durationMs: result.durationMs,
    },
  };
}
