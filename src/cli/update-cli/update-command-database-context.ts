import type { LegacyConfigUpdatePlan } from "../../commands/doctor/legacy-config-repair.js";
import { createUpdatePreflightFailure } from "../../infra/update-preflight-details.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
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
  revalidateUpdateDatabaseContext,
} from "./update-command-managed-context.js";
import { collectServiceInspectionFailureFacts } from "./update-command-result.js";
import {
  GatewayServiceUpdateOwnershipError,
  type ManagedServiceRootRedirect,
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
  handoffFromGateway?: Parameters<
    typeof maybeStopManagedServiceBeforeMutableUpdate
  >[0]["handoffFromGateway"];
};

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
      foreground &&
      (inspected.serviceUpdateVerdict?.kind === "owned" ||
        inspected.serviceUpdateVerdict?.kind === "unresolved") &&
      inspected.offline !== true
    ) {
      const failure = createUpdatePreflightFailure(
        "service-not-offline",
        undefined,
        "managed-service-preflight",
      );
      throw new UpdatePreMutationError("managed-service-preflight", failure.message, failure);
    }
    if (
      params.managedServiceRoot &&
      (inspected.serviceUpdateVerdict?.kind !== "owned" ||
        !inspected.serviceUpdateVerdict.refreshDefinition)
    ) {
      const failure = createUpdatePreflightFailure(
        "service-definition-not-writable",
        undefined,
        "managed-service-preflight",
      );
      throw new UpdatePreMutationError("managed-service-preflight", failure.message, failure);
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
    const failure = createUpdatePreflightFailure(
      "service-context-changed",
      undefined,
      "managed-service-preflight",
    );
    throw new UpdatePreMutationError("managed-service-preflight", failure.message, failure);
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
            legacyConfigPlan: params.legacyConfigPlan,
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

/** Recheck the admitted service and stores together before mutable update work. */
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
  await inspectUpdateDatabaseContexts({
    ...params,
    roots: [...admission.services.keys()],
    expectedServices: admission.services,
    expectedForeground: admission.foreground,
  });
  admission.contexts = await Promise.all(admission.contexts.map(revalidateUpdateDatabaseContext));
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
