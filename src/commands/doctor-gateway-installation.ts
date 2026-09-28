import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import { SERVICE_AUDIT_CODES } from "../daemon/service-audit.js";
import { mergeGatewayServiceEnv } from "../daemon/service-env-merge.js";
import { sanitizeServiceInspectionError } from "../daemon/service-inspection-error.js";
import { withGatewayServiceOperationLock } from "../daemon/service-operation-lock.js";
import type { GatewayServiceDefinitionTransactionHooks } from "../daemon/service-stage.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceEnv,
  GatewayServiceInstallArgs,
} from "../daemon/service-types.js";
import { GatewayServiceAuthorityError } from "../daemon/service-update-authority.js";
import { readGatewayServiceState, type GatewayService } from "../daemon/service.js";
import { isSystemdUnitActive, type SystemdUnitScope } from "../daemon/systemd.js";
import { assertGatewayServiceMutationAllowed } from "../infra/gateway-supervision.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import type { RuntimeEnv } from "../runtime.js";

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

export async function canRepairRunningGatewayDefinition(params: {
  service: GatewayService;
  command: GatewayServiceCommandConfig;
  env: GatewayServiceEnv;
}): Promise<boolean> {
  const currentRuntime = await params.service
    .readRuntime(mergeGatewayServiceEnv(params.env, params.command))
    .catch(() => null);
  if (currentRuntime?.status === "running") {
    return true;
  }
  note(
    `Gateway native-policy repair requires a running managed service. The existing definition and stop state were preserved; inspect it with \`${formatCliCommand("openclaw gateway status --deep", params.env)}\` before using \`${formatCliCommand("openclaw gateway install --force", params.env)}\`.`,
    "Gateway service definition",
  );
  return false;
}

/** One native writer retains Doctor custody through publication and recovery. */
export async function installDoctorGatewayService(
  params: Omit<GatewayServiceInstallationRepair, "activeRoot"> & {
    repair: { kind: "config" } | { kind: "definition" | "installation"; root: string };
    args: GatewayServiceInstallArgs;
    runtime: RuntimeEnv;
  },
): Promise<void> {
  try {
    const install = async (assertCurrent = params.maintenance?.assertCurrent) => {
      const publish = async (definitionTransaction?: GatewayServiceDefinitionTransactionHooks) => {
        if (params.repair.kind === "definition" && !params.maintenance) {
          if (
            !(await canRepairRunningGatewayDefinition({
              service: params.service,
              command: params.command,
              env: params.args.env,
            }))
          ) {
            throw new Error(
              "Gateway stopped before native-policy repair; its definition was preserved.",
            );
          }
        }
        await params.service.install({ ...params.args, assertCurrent, definitionTransaction });
      };
      if (params.repair.kind === "definition") {
        const { reconcileGatewayServiceDefinition } =
          await import("../daemon/service-reconciliation.js");
        await reconcileGatewayServiceDefinition({
          env: params.args.env,
          root: params.repair.root,
          command: params.command,
          expectedCommand: params.args,
          install: publish,
          warn: (message) => note(message, "Gateway service definition"),
        });
      } else {
        await publish();
      }
    };
    if (params.repair.kind === "installation") {
      await repairGatewayServiceInstallation({
        service: params.service,
        command: params.command,
        activeRoot: params.repair.root,
        maintenance: params.maintenance,
        env: params.args.env,
        install,
      });
      note(
        "Gateway service installation reconciled with the active CLI.",
        "Gateway service installation",
      );
    } else {
      await install();
    }
  } catch (err) {
    if (err instanceof GatewayServiceAuthorityError || hasCommandProcessCleanupError(err)) {
      throw err;
    }
    params.runtime.error(`Gateway service update failed: ${String(err)}`);
  }
}

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

async function repairGatewayServiceInstallation(
  params: GatewayServiceInstallationRepair & {
    env: NodeJS.ProcessEnv;
    install: (assertCurrent: () => void) => Promise<void>;
  },
): Promise<void> {
  await withGatewayServiceOperationLock(params.env, async (assertNative) => {
    const assertCurrent = () => {
      assertNative();
      params.maintenance?.assertCurrent();
    };
    await assertGatewayServiceInstallationRepairAllowed(params);
    assertCurrent();
    await params.install(assertCurrent);
    // Maintenance already stopped the old task. A standalone reinstall can leave
    // an existing Scheduled Task process alive after /Run accepts its new script.
    if (process.platform === "win32" && !params.maintenance) {
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
