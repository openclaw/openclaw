import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveStateDir } from "../../config/paths.js";
import { isContainerEnvironment } from "../../infra/container-environment.js";
import { isUpdateGatewayReadinessPending } from "../../infra/update-run-step.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
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
  verificationFailure?: string;
  env: NodeJS.ProcessEnv;
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
    const state = reason
      ? params.serviceRunning === true
        ? `The gateway is running${runningVersion ? ` ${runningVersion}` : ""} but did not pass verification (${failure}).`
        : `${params.serviceRunning === false ? "Managed gateway remains stopped because update recovery" : "Update recovery"} could not prove a runnable installation (${failure}).${params.serviceRunning === false ? " Keep the gateway stopped until the update succeeds." : ""}`
      : "";
    const configRefusal = result.steps.findLast(
      (step) => step.name === "config rollback",
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
              (failedStep.name.startsWith("global update") ||
                failedStep.name.startsWith("global install")) &&
              /\beacces\b/i.test(failedStep.stderrTail ?? ""))))) &&
      isContainerEnvironment();
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
      reason || !detail ? resolveUnsafeUpdateRecoveryGuidance(reason, env) : undefined,
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
    return `After verifying your history, preview recovery rollback retirement with ${command("openclaw update cleanup --dry-run")} for state ${resolveStateDir(env)}. Keep the same state/config overrides.`;
  }
  return undefined;
}
