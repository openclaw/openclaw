import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveStateDir } from "../../config/paths.js";
import { isContainerEnvironment } from "../../infra/container-environment.js";
import { isUpdateGatewayReadinessPending } from "../../infra/update-run-step.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import {
  formatUpdateActivationTimeoutGuidance,
  UPDATE_ACTIVATION_TIMEOUT_REASON,
  UPDATE_INSTALL_SKIP_GUIDANCE,
  UPDATE_ENVIRONMENT_FAILURE_REASONS,
  UPDATE_GLOBAL_PERMISSION_REASON,
  UPDATE_FOREIGN_DESTINATION_REASON,
} from "../../shared/update-outcome.js";
import { formatCliCommand } from "../command-format.js";

type UnsafeUpdateRecovery = Extract<
  NonNullable<UpdateRunResult["recovery"]>,
  { serviceRestartSafe: false }
>;

function resolveUnsafeUpdateRecoveryGuidance(
  reason?: UnsafeUpdateRecovery["reason"],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const triageCommand = formatCliCommand("openclaw triage", env);
  const guidance = `Run \`${triageCommand}\` on this machine to open a coding agent that can diagnose and repair the installation.`;
  if (reason === "state-migration-started") {
    return `${guidance} Update Doctor may have migrated state; keep the update installed and do not roll back code alone.`;
  }
  return guidance;
}

export function resolveUpdateResultNextAction(params: {
  result: UpdateRunResult;
  restart?: boolean;
  serviceRunning?: boolean;
  runningVersion?: string;
  verifiedServingVersion?: string;
  verificationFailure?: string;
  env: NodeJS.ProcessEnv;
  /** Prepared before ledger writes so formatting performs no filesystem discovery. */
  environment?: { container: boolean; stateDir: string };
}): string | undefined {
  const { result, env } = params;
  if (isUpdateGatewayReadinessPending(result)) {
    return `The readiness observation ended without confirmation. Leave the Gateway starting and keep recovery backups; check current progress with \`${formatCliCommand("openclaw gateway status --deep", env)}\`.`;
  }
  if (result.reason === "dirty") {
    return `Local changes prevented this update before installation. Your checkout was preserved. Commit your changes and retry, or run \`${formatCliCommand("openclaw triage", env)}\` for help.`;
  }
  if (
    result.status === "skipped" &&
    result.reason &&
    Object.hasOwn(UPDATE_INSTALL_SKIP_GUIDANCE, result.reason)
  ) {
    return UPDATE_INSTALL_SKIP_GUIDANCE[result.reason];
  }
  if (result.status === "error") {
    const doctorSettlement = result.steps.findLast(
      (step) => step.name === "doctor process settlement",
    );
    if (doctorSettlement && doctorSettlement.exitCode !== 0) {
      const detail =
        doctorSettlement.failureFacts
          ?.map((fact) => fact.message)
          .filter(Boolean)
          .join("; ") || doctorSettlement.stderrTail;
      return `${detail ?? "Doctor process settlement could not be verified."} Keep the Gateway stopped while Doctor writers may still be running. Preserve the migrated state and recovery snapshots; after the recorded processes have stopped, run \`${formatCliCommand("openclaw update repair", env)}\`.`;
    }
    if (
      result.reason === "state-migrated-no-rollback" &&
      doctorSettlement?.exitCode === 0 &&
      result.recovery?.serviceRestartSafe === true &&
      result.recovery.service === "healthy"
    ) {
      return `Doctor did not finish normally, but all tracked process groups stopped and the candidate Gateway is healthy on the preserved migrated state. Keep the recovery snapshots and run \`${formatCliCommand("openclaw update repair", env)}\` to finish maintenance.`;
    }
    if (
      result.reason === "state-migrated-no-rollback" &&
      result.steps.some((step) => step.name === "database rollback" && step.exitCode !== 0) &&
      result.recovery?.serviceRestartSafe === true &&
      result.recovery.service === "healthy"
    ) {
      const refusal =
        result.rollbackOutcome?.reason ??
        result.steps.findLast((step) => step.name === "database rollback")?.stderrTail;
      return `Rollback refused: ${refusal ?? "restoring the backup would discard later writes"}. The Gateway is running on the preserved migrated state. Keep the recovery snapshots and run \`${formatCliCommand("openclaw doctor", env)}\` to inspect the remaining repair.`;
    }
    if (
      result.reason === "update-failed" &&
      !result.recovery &&
      (result.failedStep?.name === "requested" ||
        result.failedStep?.name === "installation-inspection")
    ) {
      return `Update stopped before staging. Retry the same update command. If the failure persists, run \`${formatCliCommand("openclaw triage", env)}\` to inspect the recorded failure.`;
    }
    if (result.reason === UPDATE_ACTIVATION_TIMEOUT_REASON) {
      return formatUpdateActivationTimeoutGuidance((command) => formatCliCommand(command, env));
    }
    if (result.reason === "rollback-project-changed") {
      return `Other global packages changed after staging; automatic rollback was refused to preserve them. The new installation was left unchanged. Check \`${formatCliCommand("openclaw gateway status --deep", env)}\` before restarting it. ${resolveUnsafeUpdateRecoveryGuidance(undefined, env)}`;
    }
    const reason =
      result.recovery?.serviceRestartSafe === false ? result.recovery.reason : undefined;
    const failure = truncateUtf16Safe(
      params.verificationFailure ?? result.reason ?? reason ?? "",
      240,
    );
    const runningVersion = truncateUtf16Safe(params.runningVersion ?? "", 120);
    const servingVersion = truncateUtf16Safe(params.verifiedServingVersion ?? "", 120);
    const state = servingVersion
      ? `Your Gateway is still serving ${servingVersion}; nothing to restore.${reason ? ` Restart remains unsafe (${reason}).` : ""}`
      : reason
        ? params.serviceRunning === true
          ? `The gateway is running${runningVersion ? ` ${runningVersion}` : ""} but did not pass verification (${failure}).`
          : `${params.serviceRunning === false ? "Managed gateway remains stopped because update recovery" : "Update recovery"} could not prove a runnable installation (${failure}).${params.serviceRunning === false ? " Keep the gateway stopped until the update succeeds." : ""}`
        : "";
    const configRefusal = result.steps.findLast(
      (step) => step.name === "config-rollback",
    )?.stderrTail;
    const failedStep = result.failedStep;
    const detail =
      result.reason && UPDATE_ENVIRONMENT_FAILURE_REASONS.has(result.reason)
        ? failedStep?.stderrTail
        : undefined;
    const foreignDestination = result.reason === UPDATE_FOREIGN_DESTINATION_REASON;
    // The typed pre-admission refusal identifies npm even before result.mode is available.
    const containerPackageFailure =
      (foreignDestination ||
        ((result.mode === "npm" || result.mode === "pnpm" || result.mode === "bun") &&
          (result.reason === UPDATE_GLOBAL_PERMISSION_REASON ||
            (failedStep !== undefined &&
              failedStep.exitCode !== 0 &&
              !failedStep.advisory &&
              /^package-(?:install|pack|stage|verify|swap|rollback|backup-retention|permissions)(?:-|$)/.test(
                failedStep.name,
              ) &&
              /\beacces\b/i.test(failedStep.stderrTail ?? ""))))) &&
      (params.environment?.container ?? isContainerEnvironment());
    // Record deployment-specific advice here so CLI output and later reports agree.
    // Keep the recovery constraints: an image change must not roll back migrated state.
    const deployment = containerPackageFailure
      ? `Detected ${foreignDestination ? "a foreign npm destination" : "package update permission failure"} inside a container. Pull or build an OpenClaw image with the target version, then recreate or redeploy the container with the same state/config mounts. In-container package changes are not durable.`
      : "";
    return [
      detail,
      deployment,
      configRefusal,
      state,
      servingVersion
        ? `Fix ${truncateUtf16Safe(result.reason ?? "the update failure", 240)} then run \`${formatCliCommand("openclaw update", env)}\` again.`
        : undefined,
      reason === "state-migration-started" || (!servingVersion && (reason || !detail))
        ? resolveUnsafeUpdateRecoveryGuidance(reason, env)
        : undefined,
    ]
      .filter(Boolean)
      .join(" ");
  }
  const command = (value: string) => formatCliCommand(value, env);
  if (result.reason === "not-git-install") {
    return `This OpenClaw install isn't a git checkout, and the package manager couldn't be detected. Update via your package manager, then run \`${command("openclaw doctor")}\` and \`${command("openclaw gateway restart")}\`. Examples: \`npm i -g openclaw@latest\` or \`pnpm add -g openclaw@latest\`.`;
  }
  if (result.status === "ok") {
    if (params.restart === false && result.postUpdate?.plugins?.changed) {
      return `Plugins updated; Gateway restart skipped (--no-restart). Run \`${command("openclaw gateway restart")}\` to activate them in the running Gateway.`;
    }
    return `After verifying your history, preview recovery rollback retirement with ${command("openclaw update cleanup --dry-run")} for state ${params.environment?.stateDir ?? resolveStateDir(env)}. Keep the same state/config overrides.`;
  }
  return undefined;
}
