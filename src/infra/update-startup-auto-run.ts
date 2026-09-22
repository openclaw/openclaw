import { randomUUID } from "node:crypto";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { classifyUpdateOutcome } from "../shared/update-outcome.js";
import { VERSION } from "../version.js";
import {
  EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
  isGatewayExternallySupervised,
} from "./gateway-supervision.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "./restart.js";
import { detectRespawnSupervisor } from "./supervisor-markers.js";
import type { TrackedDevUpdateTarget } from "./update-dev-target.js";
import {
  buildManagedServiceHandoffUnavailableMessage,
  cancelManagedServiceUpdateHandoff,
  formatManagedServiceUpdateCommand,
  startManagedServiceUpdateHandoff,
  transferManagedServiceUpdateHandoff,
} from "./update-managed-service-handoff.js";
import { finishUpdateRun } from "./update-run-ledger.js";
import type { UpdateRunResult } from "./update-runner.js";

export type AutoUpdateRunResult =
  | { status: "handoff"; command?: string; logPath?: string }
  | { status: "failed" | "skipped"; result: UpdateRunResult; message: string };

export type AutoUpdateRunParams = {
  runId: string;
  channel: "stable" | "beta" | "dev";
  mode: UpdateRunResult["mode"];
  timeoutMs: number;
  restartDrainTimeoutMs: number | undefined;
  root?: string;
  packageTargetVersion?: string;
  devTarget?: TrackedDevUpdateTarget;
  signal?: AbortSignal;
};

export async function runAutoUpdateCommand(
  params: AutoUpdateRunParams,
  log: { info: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<AutoUpdateRunResult> {
  const startedAt = Date.now();
  const command = formatManagedServiceUpdateCommand({
    channel: params.channel,
    ...(params.packageTargetVersion ? { tag: params.packageTargetVersion } : {}),
  });
  const failure = (
    reason: string,
    message: string,
    status: "error" | "skipped" = "error",
  ): AutoUpdateRunResult => ({
    status: "failed",
    result: {
      status,
      mode: params.mode,
      root: params.root,
      reason,
      before: { version: VERSION },
      steps: [],
      durationMs: Date.now() - startedAt,
    },
    message,
  });
  if (isGatewayExternallySupervised()) {
    return failure(
      EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
      "Use the external supervisor's update workflow to stop, update, and restart the Gateway.",
      "skipped",
    );
  }
  const supervisor = detectRespawnSupervisor(process.env, process.platform, {
    includeLinuxOpenClawGatewayServiceMarker: true,
  });
  if (!supervisor) {
    return failure(
      "managed-service-handoff-unavailable",
      buildManagedServiceHandoffUnavailableMessage(command),
      "skipped",
    );
  }

  try {
    params.signal?.throwIfAborted();
    if (params.devTarget) {
      const { runGatewayUpdatePreflight } = await import("./update-runner.js");
      params.signal?.throwIfAborted();
      const result = await runGatewayUpdatePreflight(
        params.root,
        params.timeoutMs,
        params.devTarget,
        params.signal,
      );
      params.signal?.throwIfAborted();
      if (result) {
        if (classifyUpdateOutcome(result) === "noop") {
          return {
            status: "skipped",
            result,
            message: "Automatic update skipped: the selected version is already current.",
          };
        }
        return {
          status: "failed",
          result,
          message: `Automatic update preflight failed. Run \`${command}\` from a shell to inspect and retry.`,
        };
      }
    }
    if (!params.root?.trim()) {
      throw new Error("managed auto-update install root is unavailable");
    }
    const handoffId = randomUUID();
    const started = await startManagedServiceUpdateHandoff({
      root: params.root,
      recoveryTimeoutMs: params.timeoutMs,
      restartDrainTimeoutMs:
        resolveGatewayRestartDeferralTimeoutMs(params.restartDrainTimeoutMs) ??
        resolveGatewayRestartDeferralTimeoutMs(),
      channel: params.channel,
      ...(params.packageTargetVersion ? { tag: params.packageTargetVersion } : {}),
      supervisor,
      handoffId,
      ...(params.devTarget ? { devTarget: params.devTarget } : {}),
      meta: { runId: params.runId, handoffId, note: "background auto-update" },
    });
    if (started.status === "started") {
      const successorOwner = {
        kind: "managed-update-handoff" as const,
        handoffId: started.handoffId,
        installRoot: started.installRoot,
      };
      if (params.signal?.aborted) {
        const cancelled = await cancelManagedServiceUpdateHandoff(successorOwner);
        if (cancelled !== "restored-in-process") {
          log.info("stopped auto-update handoff cancellation could not be verified", {
            result: cancelled,
            command: started.command,
            logPath: started.logPath,
          });
        }
        params.signal.throwIfAborted();
      }
      // Transfer starts validation while this generation remains available. Only
      // the orchestrator's activation request may park the managed service.
      try {
        if (!(await transferManagedServiceUpdateHandoff(successorOwner))) {
          throw new Error("managed update ownership transfer failed");
        }
        params.signal?.throwIfAborted();
      } catch (error) {
        await cancelManagedServiceUpdateHandoff(successorOwner);
        throw error;
      }
    } else {
      // A joined helper owns another run; it cannot complete this campaign's admission.
      finishUpdateRun(params.runId, {
        status: "skipped",
        reason: "managed-service-handoff-already-running",
      });
    }
    return {
      status: "handoff",
      command: started.command,
      logPath: started.logPath,
    };
  } catch (err) {
    // Filesystem failures can contain private helper paths; keep the full cause local.
    log.info("automatic update handoff failed", { error: String(err) });
    const code = extractErrorCode(err);
    return failure(
      "managed-service-handoff-failed",
      `Automatic update handoff failed${code ? ` (${code})` : ""}. Inspect the Gateway log, then run \`${command}\` from a shell to retry.`,
    );
  }
}
