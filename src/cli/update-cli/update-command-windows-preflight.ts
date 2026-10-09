import { resolveTaskName } from "../../daemon/schtasks-layout.js";
import {
  probeScheduledTaskUpdateAccess,
  ScheduledTaskInspectionError,
} from "../../daemon/schtasks-state-probe.js";
import { normalizePackageTagInput } from "../../infra/package-tag.js";
import { resolveGlobalInstallSpec } from "../../infra/update-global.js";
import { createUpdatePreflightFailure } from "../../infra/update-preflight-details.js";
import { defaultRuntime } from "../../runtime.js";
import { quotePowerShellArg } from "../quote-cli-arg.js";
import {
  GatewayServiceUpdateOwnershipError,
  isGatewayServiceManagementAllowedForUpdate,
} from "./update-command-service-plan.js";

/** Refuse impossible task control before staging or opening writable update state. */
export function preflightWindowsUpdateTask(tag?: string, timeoutMs?: number): void {
  if (process.platform !== "win32" || !isGatewayServiceManagementAllowedForUpdate(process.env)) {
    return;
  }
  const probe = probeScheduledTaskUpdateAccess(resolveTaskName(process.env), timeoutMs);
  if (probe.status !== "unknown" && probe.status !== "elevation-required") {
    return;
  }
  let failureCode: "windows-task-elevation-required" | "windows-task-inspection-timeout" =
    "windows-task-elevation-required";
  let error: ScheduledTaskInspectionError | undefined;
  if (probe.status === "unknown") {
    error = new ScheduledTaskInspectionError(probe);
    if (probe.diagnostic.kind === "timeout") {
      failureCode = "windows-task-inspection-timeout";
    } else if (probe.diagnostic.kind !== "native" || probe.diagnostic.hresult !== -2147024891) {
      defaultRuntime.error(`Warning: ${error.message}`);
      return;
    }
  }
  const target = resolveGlobalInstallSpec({
    packageName: "openclaw",
    tag: normalizePackageTagInput(tag, ["openclaw"]) ?? "<target>",
  });
  const spec = /^[\w@.+-]+$/.test(target) ? target : quotePowerShellArg(target);
  const manual = `For a global npm installation, update manually: npm i -g ${spec} --allow-scripts=openclaw, then openclaw doctor --fix, then openclaw gateway restart.`;
  throw new GatewayServiceUpdateOwnershipError(
    createUpdatePreflightFailure(
      failureCode,
      [error?.message, manual].filter(Boolean).join("\n"),
      "managed-service",
    ),
    error,
  );
}
