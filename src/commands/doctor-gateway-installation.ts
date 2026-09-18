import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { formatCliCommand } from "../cli/command-format.js";
import { SERVICE_AUDIT_CODES } from "../daemon/service-audit.js";
import { sanitizeServiceInspectionError } from "../daemon/service-inspection-error.js";
import { withGatewayServiceOperationLock } from "../daemon/service-operation-lock.js";
import type { GatewayServiceCommandConfig } from "../daemon/service-types.js";
import { readGatewayServiceState, type GatewayService } from "../daemon/service.js";
import { isSystemdUnitActive, type SystemdUnitScope } from "../daemon/systemd.js";
import { assertGatewayServiceMutationAllowed } from "../infra/gateway-supervision.js";

export type DoctorGatewayInstallationMaintenance = {
  managerUid?: number;
  assertCurrent: () => void;
  assertReadCurrent: () => void;
};

type GatewayServiceInstallationRepair = {
  service: GatewayService;
  command: GatewayServiceCommandConfig;
  activeRoot: string;
  maintenance?: DoctorGatewayInstallationMaintenance;
};

/** Doctor consumes the updater's verified ownership; a recorded path alone grants no repair. */
export async function assertGatewayServiceInstallationRepairAllowed(
  params: GatewayServiceInstallationRepair,
): Promise<void> {
  const { inspectManagedGatewayServiceBeforeUpdate, GATEWAY_SERVICE_INSPECTION_WARNING } =
    await import("../cli/update-cli/update-command-service-plan.js");
  const maintenance = params.maintenance;
  const state = await readGatewayServiceState(params.service, {
    env: process.env,
    requireEffective: true,
    requireLoadedCommand: true,
    ...(maintenance?.managerUid !== undefined
      ? {
          loadForInspection: {
            managerUid: maintenance.managerUid,
            assertCurrent: maintenance.assertCurrent,
            assertReadCurrent: maintenance.assertReadCurrent,
          },
        }
      : {}),
    validateEnvBeforeStatusRead: (env) =>
      assertGatewayServiceMutationAllowed("repair the gateway service installation", env),
  }).catch((error: unknown) => {
    throw new Error(
      `${GATEWAY_SERVICE_INSPECTION_WARNING} ${sanitizeServiceInspectionError(error).message}`,
      { cause: error },
    );
  });
  const verdict = await inspectManagedGatewayServiceBeforeUpdate({
    state,
    root: params.activeRoot,
    allowInstallRootChange: true,
  });
  maintenance?.assertCurrent();
  if (verdict.kind === "unavailable") {
    throw new Error(verdict.message);
  }
  if (!isDeepStrictEqual(state.command, params.command)) {
    throw new Error(
      "Gateway service definition changed during Doctor; rerun doctor to inspect the current installation.",
    );
  }
  if (verdict.kind !== "owned" || !verdict.requiresInstallRootRefresh) {
    throw new Error(
      `Gateway service installation is controlled by another owner; automatic installation repair was skipped. Inspect it with \`${formatCliCommand("openclaw gateway status --deep", state.env)}\`.`,
    );
  }
}

export async function repairGatewayServiceInstallation(
  params: GatewayServiceInstallationRepair & {
    env: NodeJS.ProcessEnv;
    install: () => Promise<void>;
    updateRepairMode: boolean;
  },
): Promise<void> {
  await withGatewayServiceOperationLock(params.env, async (assertCurrent) => {
    await assertGatewayServiceInstallationRepairAllowed(params);
    assertCurrent();
    await params.install();
    // Maintenance already stopped the old task. A standalone reinstall can leave
    // an existing Scheduled Task process alive after /Run accepts its new script.
    if (process.platform === "win32" && !params.updateRepairMode && !params.maintenance) {
      await params.service.restart({ env: params.env, stdout: process.stdout, assertCurrent });
    }
  });
}

const EXECSTART_REPAIR_CODES = new Set<string>([
  SERVICE_AUDIT_CODES.gatewayCommandMissing,
  SERVICE_AUDIT_CODES.gatewayEntrypointMismatch,
]);
export function isExecStartRepairIssue(issue: { code: string }): boolean {
  return EXECSTART_REPAIR_CODES.has(issue.code);
}

export function resolveSystemdScopeFromServicePath(
  sourcePath: string | undefined,
): SystemdUnitScope {
  const normalized = sourcePath?.replaceAll("\\", "/") ?? "";
  return normalized.startsWith("/etc/systemd/") ||
    normalized.startsWith("/usr/lib/systemd/") ||
    normalized.startsWith("/lib/systemd/")
    ? "system"
    : "user";
}

export function resolveSystemdUnitNameFromServicePath(sourcePath: string | undefined): string {
  const base = sourcePath ? path.posix.basename(sourcePath.replaceAll("\\", "/")) : "";
  return base.endsWith(".service") ? base : "openclaw-gateway.service";
}

export async function resolveSystemdServiceRewriteBlock(
  command: GatewayServiceCommandConfig,
  issues: { code: string }[],
): Promise<string | undefined> {
  if (process.platform !== "linux" || !issues.some(isExecStartRepairIssue)) {
    return undefined;
  }
  const unitName = resolveSystemdUnitNameFromServicePath(command.sourcePath);
  const scope = resolveSystemdScopeFromServicePath(command.sourcePath);
  const active = await isSystemdUnitActive(process.env, unitName, scope);
  if (!active.ok) {
    return `Could not determine whether gateway service ${unitName} is active: ${active.error}. Leaving supervisor metadata unchanged. Check \`systemctl${scope === "user" ? " --user" : ""} status ${unitName}\` and rerun doctor.`;
  }
  if (!active.value) {
    return undefined;
  }
  issues.splice(0, issues.length, ...issues.filter((issue) => !isExecStartRepairIssue(issue)));
  return `Gateway service ${unitName} is running; skipped command/entrypoint rewrites and leaving supervisor metadata unchanged. Stop the service first or use \`${formatCliCommand("openclaw gateway install --force")}\` when you want to replace the active launcher.`;
}
