import type { LegacyConfigUpdatePlan } from "../../commands/doctor/legacy-config-repair.js";
import { resolveConfigPath } from "../../config/paths.js";
import { resolveIdentityPathViaExistingAncestorSync as canonicalPath } from "../../infra/boundary-path.js";
import { readGatewayLockProcessCmdline as readCmdline } from "../../infra/gateway-lock-process.js";
import { readLockPayload, resolveGatewayLockPaths as lockPaths } from "../../infra/gateway-lock.js";
import { classifyOpenClawArgv as classify } from "../../infra/gateway-process-argv.js";
import { createUpdatePreflightFailure } from "../../infra/update-preflight-details.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import {
  captureTargetDatabaseSchemaContext,
  checkTargetDatabaseSchemasForContexts,
  formatSchemaRefusalLines,
  hasSchemaRefusal,
  isCandidateAdmissionContextCovered,
} from "./schema-preflight.js";
import { UpdatePreMutationError } from "./shared.js";
import {
  formatUpdateAncestryBlockMessage,
  resolveForegroundUpdateAdmission,
} from "./update-command-handoff.js";
import {
  captureOwnedManagedUpdatePreflightContext,
  resolveOwnedManagedUpdatePreflightEnv,
} from "./update-command-managed-context.js";
import type { ManagedServiceRootRedirect } from "./update-command-service-context-types.js";
import {
  collectServiceInspectionFailureFacts,
  GatewayServiceUpdateOwnershipError,
} from "./update-command-service-plan.js";
import {
  maybeStopManagedServiceBeforeMutableUpdate,
  type PreManagedServiceStop,
} from "./update-command-service.js";

type UpdateManagedServiceInspectionParams = {
  roots: readonly string[];
  updateInstallKind: "package" | "git";
  shouldRestart: boolean;
  jsonMode: boolean;
  timeoutMs: number;
  invocationCwd?: string;
  managedServiceRootRedirect: ManagedServiceRootRedirect | null;
  managedServiceRoot?: string;
  expectedServices?: ReadonlyMap<string, PreManagedServiceStop>;
  expectedForeground?: true;
  assertCurrent?: () => void;
  handoffFromGateway?: Parameters<
    typeof maybeStopManagedServiceBeforeMutableUpdate
  >[0]["handoffFromGateway"];
};

function managedServicePreflightError(code: Parameters<typeof createUpdatePreflightFailure>[0]) {
  const failure = createUpdatePreflightFailure(code, undefined, "managed-service-preflight");
  return new UpdatePreMutationError("managed-service-preflight", failure.message, failure);
}

/** The installed process owns ancestry and coordination inspection before candidate code runs. */
export async function inspectUpdateManagedServices(params: UpdateManagedServiceInspectionParams) {
  return await withCommandProcessScope(() => inspectUpdateManagedServicesInScope(params));
}

async function inspectUpdateManagedServicesInScope(params: UpdateManagedServiceInspectionParams) {
  const foreground = await resolveForegroundUpdateAdmission({
    root: params.roots[0],
    expectedForeground: params.expectedForeground,
  });
  let service: PreManagedServiceStop | undefined;
  const services = new Map<string, PreManagedServiceStop>();
  const serviceRoots = params.managedServiceRoot ? [params.managedServiceRoot] : params.roots;
  for (const root of new Set(serviceRoots)) {
    const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
      root,
      handoffRoot: params.managedServiceRoot ? params.roots[0] : undefined,
      updateInstallKind: params.updateInstallKind,
      shouldRestart: params.shouldRestart,
      jsonMode: params.jsonMode,
      timeoutMs: params.timeoutMs,
      phase: "inspect",
      expectedService: params.expectedServices?.get(root),
      assertCurrent: params.assertCurrent,
      handoffFromGateway: params.handoffFromGateway,
    }).catch((error: unknown) => {
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      if (error instanceof GatewayServiceUpdateOwnershipError) {
        throw new UpdatePreMutationError("managed-service-preflight", error.message, {
          failureFacts: error.failureFacts,
        });
      }
      throw error;
    });
    if (inspected.blockMessage) {
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        formatUpdateAncestryBlockMessage(inspected.blockMessage),
        {
          failureFacts:
            inspected.blockFailureFacts ??
            collectServiceInspectionFailureFacts(inspected.serviceUpdateVerdict),
        },
      );
    }
    if (
      params.updateInstallKind === "package" &&
      inspected.serviceUpdateVerdict?.kind === "unavailable"
    ) {
      const owner = await readLockPayload(lockPaths(process.env).ownerLockPath);
      const live = owner && isPidAlive(owner.pid) && (owner.role ?? "gateway") === "gateway";
      const argv = live ? readCmdline(owner.pid, process.platform, params.timeoutMs) : null;
      const entry = classify(argv ?? [], { requirePackageIdentity: true, pid: owner?.pid });
      if (
        live &&
        ((process.platform === "win32" && (!argv || entry.kind === "unclassified")) ||
          (entry.kind === "openclaw" &&
            entry.packageIdentity &&
            canonicalPath(entry.packageIdentity.root) === canonicalPath(params.roots[0] ?? root)))
      ) {
        const detail = inspected.serviceUpdateVerdict.message;
        const failure = createUpdatePreflightFailure("gateway-stop-unverified", detail);
        throw new UpdatePreMutationError("gateway-stop-unverified", failure.message, {
          failureFacts: [
            ...failure.failureFacts,
            ...(collectServiceInspectionFailureFacts(inspected.serviceUpdateVerdict) ?? []),
          ],
        });
      }
    }
    if (
      foreground &&
      (inspected.serviceUpdateVerdict?.kind === "owned" ||
        inspected.serviceUpdateVerdict?.kind === "unresolved") &&
      inspected.offline !== true
    ) {
      throw managedServicePreflightError("service-not-offline");
    }
    if (
      params.managedServiceRoot &&
      (inspected.serviceUpdateVerdict?.kind !== "owned" ||
        !inspected.serviceUpdateVerdict.refreshDefinition)
    ) {
      throw managedServicePreflightError("service-definition-not-writable");
    }
    services.set(root, inspected);
    if (inspected.serviceUpdateVerdict?.kind === "owned") {
      service = inspected;
      break;
    }
  }
  const managedEnv = resolveOwnedManagedUpdatePreflightEnv({
    stopState: service,
    processEnv: process.env,
    invocationCwd: params.invocationCwd,
  });
  if ((params.managedServiceRootRedirect || params.managedServiceRoot) && !managedEnv) {
    throw managedServicePreflightError("service-context-changed");
  }
  return {
    service,
    services,
    managedEnv,
    ...(foreground ? { foreground: true as const } : {}),
  };
}

export async function inspectUpdateDatabaseContexts(
  params: UpdateManagedServiceInspectionParams & {
    legacyConfigPlan?: LegacyConfigUpdatePlan;
    callerLegacyConfigPlan?: LegacyConfigUpdatePlan;
    candidateAdmissionChecks?: readonly string[];
  },
) {
  return await withCommandProcessScope(async () => {
    const inspected = await inspectUpdateManagedServicesInScope(params);
    const configValidation = params.candidateAdmissionChecks?.includes("config")
      ? ("candidate" as const)
      : undefined;
    const managed = await captureOwnedManagedUpdatePreflightContext({
      stopState: inspected.service,
      processEnv: process.env,
      invocationCwd: params.invocationCwd,
      legacyConfigPlan: params.legacyConfigPlan,
      configValidation,
    });
    // Redirected package replacement does not own the invoking installation's stores.
    const contexts = params.managedServiceRootRedirect
      ? []
      : [
          await captureTargetDatabaseSchemaContext(process.env, {
            legacyConfigPlan:
              params.callerLegacyConfigPlan?.snapshot.path === resolveConfigPath()
                ? params.callerLegacyConfigPlan
                : params.legacyConfigPlan,
            configValidation,
          }),
        ];
    if (managed) {
      contexts.push(managed);
    }
    return {
      ...inspected,
      contexts,
      managedEnv: inspected.foreground ? undefined : managed?.env,
    };
  });
}

/** Check target schema support; native service effects validate their own authority. */
export async function revalidateUpdateDatabaseContexts(
  params: Omit<Parameters<typeof inspectUpdateDatabaseContexts>[0], "roots" | "expectedServices">,
  admission: Awaited<ReturnType<typeof inspectUpdateDatabaseContexts>> | undefined,
  versions: OpenClawSchemaVersions | undefined,
) {
  if (!admission) {
    throw new UpdatePreMutationError(
      "database-schema-preflight",
      "Database admission was not inspected.",
    );
  }
  const installedContexts = params.candidateAdmissionChecks?.includes("database-schema")
    ? admission.contexts.filter((context) => !isCandidateAdmissionContextCovered(context.env))
    : admission.contexts;
  const schemas = await checkTargetDatabaseSchemasForContexts(versions, installedContexts);
  if (hasSchemaRefusal(schemas)) {
    throw new UpdatePreMutationError(
      "database-schema-preflight",
      formatSchemaRefusalLines(schemas).join("\n"),
    );
  }
  return admission;
}
