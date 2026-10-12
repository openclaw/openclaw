import { isStartupConfigRefusal } from "../../commands/doctor-startup-migration-refusal.js";
import { isInvalidConfigError } from "../../config/io.invalid-config.js";
import { isGatewayEffectiveConfigConflictError } from "../../gateway/server-runtime-config.js";
import { formatAgentDatabaseCorruptionRepairHint } from "../../infra/agent-database-recovery-guidance.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { findStartupMaintenanceRequiredError } from "../../infra/startup-maintenance-required.js";
import { isTailscaleRouteOwnershipConflictError } from "../../infra/tailscale-route-ownership-error.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { defaultRuntime } from "../../runtime.js";
import { AgentDatabaseAdmissionError } from "../../state/agent-database-admission.js";
import { OpenClawDatabaseSchemaPreflightError } from "../../state/openclaw-database-preflight.messages.js";
import { formatCliCommand } from "../command-format.js";

const gatewayLog = createSubsystemLogger("gateway");

export function resolveGatewayStartupFailureExitCode(err: unknown): number {
  return isInvalidConfigError(err) ||
    isTailscaleRouteOwnershipConflictError(err) ||
    isGatewayEffectiveConfigConflictError(err) ||
    isStartupConfigRefusal(err)
    ? 78
    : 1;
}

function findAgentDatabaseCorruptionRepairHints(error: unknown): string[] {
  return collectNestedErrorCandidates(error).flatMap((candidate) => {
    if (!(candidate instanceof AgentDatabaseAdmissionError)) {
      return [];
    }
    const hint = formatAgentDatabaseCorruptionRepairHint(
      candidate.refusal.agentId,
      candidate.cause,
    );
    return hint ? [hint] : [];
  });
}

export function resolveGatewayStartupMaintenanceReason(error: unknown) {
  return (
    findStartupMaintenanceRequiredError(error)?.reason ??
    (findAgentDatabaseCorruptionRepairHints(error).length > 0
      ? "offline agent database recovery"
      : undefined)
  );
}

export async function handleGatewayStartupMaintenance(error: unknown): Promise<boolean> {
  const maintenance = findStartupMaintenanceRequiredError(error);
  const corruptionRepairHints = findAgentDatabaseCorruptionRepairHints(error);
  if (!maintenance && corruptionRepairHints.length === 0) {
    return false;
  }
  const reason = maintenance?.reason ?? "offline agent database recovery";
  let refusal: unknown = maintenance ?? error;
  if (
    maintenance?.kind === "newer-schema" &&
    !(maintenance instanceof OpenClawDatabaseSchemaPreflightError)
  ) {
    // Config reads can refuse shared state before bootstrap reaches schema preflight.
    try {
      const { preflightOpenClawDatabaseSchemas } =
        await import("../../state/openclaw-database-preflight.js");
      const schemas = await preflightOpenClawDatabaseSchemas({ env: process.env });
      if (schemas.incompatible.length > 0) {
        refusal = new OpenClawDatabaseSchemaPreflightError(schemas.incompatible);
      }
    } catch {
      // Diagnostic inspection must not prevent parking and exit for the original refusal.
    }
  }
  const stop = `Stop the service with ${formatCliCommand("openclaw gateway stop")} (or its service owner), then`;
  const guidance =
    reason === "a newer OpenClaw build"
      ? `${stop} restore your pre-update backup created with ${formatCliCommand("openclaw backup create")}, then start it again with ${formatCliCommand("openclaw gateway start")}. See https://docs.openclaw.ai/install/updating#rollback.`
      : corruptionRepairHints.length > 0
        ? `${[...new Set(corruptionRepairHints)].join("\n")} Start the service again with ${formatCliCommand("openclaw gateway start")}.`
        : `${stop} run ${formatCliCommand("openclaw doctor --fix")}, then start it again with ${formatCliCommand("openclaw gateway start")}.`;
  let parked = false;
  try {
    // launchd ignores exit 78 under KeepAlive. Park without opening the database,
    // which may also be unavailable to the persisted crash-loop counter.
    const { parkCurrentLaunchAgentForMaintenance } = await import("../../daemon/launchd.js");
    parked = await parkCurrentLaunchAgentForMaintenance();
  } catch (parkError) {
    gatewayLog.error(`failed to park the managed LaunchAgent: ${formatErrorMessage(parkError)}`);
  }
  if (refusal instanceof OpenClawDatabaseSchemaPreflightError) {
    gatewayLog.error(
      `${formatErrorMessage(refusal)}${parked ? " Parked the managed LaunchAgent." : ""}`,
    );
    defaultRuntime.error(`Gateway failed to start: ${formatErrorMessage(refusal)}`);
  } else {
    gatewayLog.error(
      `gateway requires ${reason}${parked ? "; parked the managed LaunchAgent" : ""}. ${guidance}`,
    );
    defaultRuntime.error(`Gateway failed to start: ${formatErrorMessage(error)}. ${guidance}`);
  }
  // systemd's RestartPreventExitStatus already treats EX_CONFIG as terminal.
  defaultRuntime.exit(78);
  return true;
}
