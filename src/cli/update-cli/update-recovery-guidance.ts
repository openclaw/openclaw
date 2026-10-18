import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveStateDir } from "../../config/paths.js";
import { isContainerEnvironment } from "../../infra/container-environment.js";
import {
  isUpdateGatewayReadinessPending,
  isUpdatePostInstallVerificationDeferred,
} from "../../infra/update-run-step.js";
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
  if (result.status === "skipped" && result.reason === "gateway-readiness-unverified") {
    const deferred = result.steps.find(isUpdatePostInstallVerificationDeferred)?.advisory;
    if (deferred) {
      return deferred.message;
    }
  }
  if (
    isUpdateGatewayReadinessPending(result) &&
    !(result.recovery?.serviceRestartSafe === false && result.recovery.dataAtRisk)
  ) {
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
    const triageGuidance = `Run \`${formatCliCommand("openclaw triage", env)}\` on this machine to open a coding agent that can diagnose and repair the installation.`;
    const doctorSettlement = result.steps.findLast(
      (step) => step.name === "doctor process settlement",
    );
    if (
      result.recovery?.serviceRestartSafe === true &&
      result.recovery.service === "healthy" &&
      !result.recovery.packageRollbackVerified
    ) {
      const refusal = result.rollbackOutcome?.reason;
      return `${refusal ? `Rollback refused: ${refusal}. ` : ""}The candidate Gateway is healthy and running on the preserved migrated state. Keep the recovery snapshots; stop the Gateway first (\`${formatCliCommand("openclaw gateway stop", env)}\`), then run \`${formatCliCommand("openclaw update repair", env)}\` to finish maintenance.`;
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
      return `Other global packages changed after staging; automatic rollback was refused to preserve them. The new installation was left unchanged. Check \`${formatCliCommand("openclaw gateway status --deep", env)}\` before restarting it. ${triageGuidance}`;
    }
    const hostLinkFailure = result.steps.some((step) =>
      step.failureFacts?.some((fact) => fact.code === "host-owned-plugin-link"),
    );
    const retentionGuidance = hostLinkFailure
      ? `A dependency link reaches OpenClaw-owned files that cannot be safely retained. Keep source files and backups; inspect the link in the local error and follow https://docs.openclaw.ai/cli/update#runtime-retention-failures. Do not skip runtime retention. After repairing the link, retry the update.`
      : undefined;
    const reason =
      result.recovery?.serviceRestartSafe === false ? result.recovery.reason : undefined;
    const failure = truncateUtf16Safe(
      params.verificationFailure ?? result.reason ?? reason ?? "",
      240,
    );
    const runningVersion = truncateUtf16Safe(params.runningVersion ?? "", 120);
    const servingVersion = truncateUtf16Safe(params.verifiedServingVersion ?? "", 120);
    const dataAtRisk = result.recovery?.serviceRestartSafe === false && result.recovery.dataAtRisk;
    const state = dataAtRisk
      ? `${doctorSettlement?.stderrTail ? `${doctorSettlement.stderrTail} ` : ""}Keep the Gateway stopped: data at risk (${dataAtRisk}). Keep the update installed and preserve recovery snapshots; do not roll back code alone. Run \`${formatCliCommand("openclaw update repair", env)}\` after ${dataAtRisk === "active-mutation" ? "the recorded processes have stopped" : "resolving this risk"}.`
      : servingVersion
        ? `Your Gateway is still serving ${servingVersion}; nothing to restore.${reason ? ` Restart remains unsafe (${reason}).` : ""}`
        : reason
          ? params.serviceRunning === true
            ? `The gateway is running${runningVersion ? ` ${runningVersion}` : ""} but did not pass verification (${failure}). Run \`${formatCliCommand("openclaw update repair", env)}\` and \`${formatCliCommand("openclaw gateway status --deep", env)}\`.`
            : `${params.serviceRunning === false ? "Managed gateway remains stopped because update recovery" : "Update recovery"} could not prove a runnable installation (${failure}). Run \`${formatCliCommand("openclaw update repair", env)}\` and \`${formatCliCommand("openclaw gateway status --deep", env)}\`.`
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
      retentionGuidance,
      servingVersion && !hostLinkFailure
        ? `Fix ${truncateUtf16Safe(result.reason ?? "the update failure", 240)} then run \`${formatCliCommand("openclaw update", env)}\` again.`
        : undefined,
      !servingVersion && (reason || !detail) ? triageGuidance : undefined,
    ]
      .filter(Boolean)
      .join(" ");
  }
  const command = (value: string) => formatCliCommand(value, env);
  if (result.reason === "not-git-install") {
    return `This OpenClaw install isn't a git checkout, and the package manager couldn't be detected. Update via your package manager, then run \`${command("openclaw doctor")}\` and \`${command("openclaw gateway restart")}\`. Examples: \`npm i -g openclaw@latest\` or \`pnpm add -g openclaw@latest\`.`;
  }
  if (result.status === "ok") {
    if (result.recovery?.serviceRestartSafe === true && result.recovery.service === "healthy") {
      return `Gateway recovery is healthy. Retained update warnings and backups need repair; run \`${command("openclaw update repair")}\`.`;
    }
    if (params.restart === false && result.postUpdate?.plugins?.changed) {
      return `Plugins updated; Gateway restart skipped (--no-restart). Run \`${command("openclaw gateway restart")}\` to activate them in the running Gateway.`;
    }
    return `After confirming the update and your conversations are healthy, preview retained migration originals eligible for permanent cleanup with \`${command("openclaw update cleanup --dry-run")}\` for state \`${params.environment?.stateDir ?? resolveStateDir(env)}\`. Before applying cleanup, stop the Gateway first (\`${command("openclaw gateway stop")}\`). Use the same profile, state, and config settings.`;
  }
  return undefined;
}
