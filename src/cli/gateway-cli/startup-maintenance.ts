import { isStartupConfigRefusal } from "../../commands/doctor-startup-migration-refusal.js";
import { isInvalidConfigError } from "../../config/io.invalid-config.js";
import { isGatewayEffectiveConfigConflictError } from "../../gateway/server-runtime-config.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { GatewayLockError } from "../../infra/gateway-lock.js";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import { findStartupMaintenanceRequiredError } from "../../infra/startup-maintenance-required.js";
import { isTailscaleRouteOwnershipConflictError } from "../../infra/tailscale-route-ownership-error.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { defaultRuntime } from "../../runtime.js";
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

export function resolveGatewayStartupMaintenanceReason(error: unknown) {
  return findStartupMaintenanceRequiredError(error)?.reason;
}

export async function handleGatewayStartupMaintenance(error: unknown): Promise<boolean> {
  const maintenance = findStartupMaintenanceRequiredError(error);
  if (!maintenance) {
    return false;
  }
  const reason = maintenance.reason;
  let refusal = maintenance;
  if (
    maintenance.kind === "newer-schema" &&
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

export async function handleGatewayLockFailure(
  err: GatewayLockError,
  port: number,
  exitCode: number,
): Promise<void> {
  const storageFailure =
    err.databasePath &&
    collectNestedErrorCandidates(err)
      .map((cause) => {
        // Generic errno is storage evidence only within state-database acquisition.
        if (
          hasErrnoCode(cause, "EACCES") ||
          hasErrnoCode(cause, "EPERM") ||
          hasErrnoCode(cause, "EROFS")
        ) {
          return "SQLITE_READONLY";
        }
        if (hasErrnoCode(cause, "EIO")) {
          return "SQLITE_IOERR";
        }
        return classifyGatewayStorageFailure(cause);
      })
      .find(
        (failure) =>
          failure === "SQLITE_READONLY" || failure === "SQLITE_FULL" || failure === "SQLITE_IOERR",
      );
  if (storageFailure) {
    const guidance =
      storageFailure === "SQLITE_READONLY"
        ? "The state database is read-only or not writable by this user. Fix ownership and permissions for this path and its parent directory, or remount the volume writable. If the file is immutable, clear its immutable flag (on macOS: chflags nouchg)."
        : storageFailure === "SQLITE_FULL"
          ? "The disk is full. Free up space on the volume containing this path."
          : "The state database could not be opened or written. Check access to this path and its parent directory, and check the volume for I/O errors.";
    defaultRuntime.error(
      `Gateway failed to start: storage failure at ${err.databasePath}. ${guidance} Run ${formatCliCommand("openclaw doctor")} for general diagnostics.`,
    );
    defaultRuntime.exit(exitCode);
    return;
  }
  const errMessage = formatErrorMessage(err);
  defaultRuntime.error(
    `Gateway failed to start: ${errMessage}\nIf the gateway is supervised, stop it with: ${formatCliCommand("openclaw gateway stop")}`,
  );
  try {
    const [{ formatPortDiagnostics }, { inspectPortUsage }] = await Promise.all([
      import("../../infra/ports-format.js"),
      import("../../infra/ports-inspect.js"),
    ]);
    const diagnostics = await inspectPortUsage(port);
    if (diagnostics.status === "busy") {
      for (const line of formatPortDiagnostics(diagnostics)) {
        defaultRuntime.error(line);
      }
    }
  } catch {
    // ignore diagnostics failures
  }
  const { maybeExplainGatewayServiceStop } = await import("./shared.js");
  await maybeExplainGatewayServiceStop();
  defaultRuntime.exit(exitCode);
}
