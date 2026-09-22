import type { LegacyConfigUpdatePlan } from "../../commands/doctor/legacy-config-repair.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import {
  captureTargetDatabaseSchemaContext,
  checkTargetDatabaseSchemasForContexts,
  formatSchemaRefusalLines,
  hasSchemaRefusal,
} from "./schema-preflight.js";
import { UpdatePreMutationError } from "./shared.js";
import {
  formatUpdateAncestryBlockMessage,
  resolveForegroundUpdateAdmission,
} from "./update-command-handoff.js";
import {
  captureOwnedManagedUpdatePreflightContext,
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

export async function inspectUpdateDatabaseContexts(params: {
  roots: readonly string[];
  updateInstallKind: "package" | "git";
  shouldRestart: boolean;
  jsonMode: boolean;
  timeoutMs: number;
  invocationCwd?: string;
  legacyConfigPlan?: LegacyConfigUpdatePlan;
  managedServiceRootRedirect: ManagedServiceRootRedirect | null;
  managedServiceRoot?: string;
  expectedServices?: ReadonlyMap<string, PreManagedServiceStop>;
  expectedForeground?: true;
}) {
  return await withCommandProcessScope(async () => {
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
          { failureFacts: collectServiceInspectionFailureFacts(inspected.serviceUpdateVerdict) },
        );
      }
      if (
        foreground &&
        (inspected.serviceUpdateVerdict?.kind === "owned" ||
          inspected.serviceUpdateVerdict?.kind === "unresolved") &&
        inspected.offline !== true
      ) {
        throw new UpdatePreMutationError(
          "managed-service-preflight",
          "Another Gateway service uses this installation and is not verified offline. Stop it through its service owner before updating the foreground Gateway.",
          { failureFacts: collectServiceInspectionFailureFacts(inspected.serviceUpdateVerdict) },
        );
      }
      if (
        params.managedServiceRoot &&
        (inspected.serviceUpdateVerdict?.kind !== "owned" ||
          !inspected.serviceUpdateVerdict.refreshDefinition)
      ) {
        throw new UpdatePreMutationError(
          "managed-service-preflight",
          "The Gateway cannot be rebound from its current installation: its owned service definition must be writable before this update can align it with the CLI.",
        );
      }
      services.set(root, inspected);
      if (inspected.serviceUpdateVerdict?.kind === "owned") {
        service = inspected;
        break;
      }
    }
    const managed = await captureOwnedManagedUpdatePreflightContext({
      stopState: service,
      processEnv: process.env,
      invocationCwd: params.invocationCwd,
      legacyConfigPlan: params.legacyConfigPlan,
    });
    if ((params.managedServiceRootRedirect || params.managedServiceRoot) && !managed) {
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        "The managed Gateway service changed before database admission. Retry so its package root and state can be inspected together.",
      );
    }
    // Redirected package replacement does not own the invoking installation's stores.
    const contexts = params.managedServiceRootRedirect
      ? []
      : [
          await captureTargetDatabaseSchemaContext(process.env, {
            legacyConfigPlan: params.legacyConfigPlan,
          }),
        ];
    if (managed) {
      contexts.push(managed);
    }
    return {
      service,
      services,
      contexts,
      managedEnv: foreground ? undefined : managed?.env,
      ...(foreground ? { foreground: true as const } : {}),
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
  const schemas = await checkTargetDatabaseSchemasForContexts(versions, admission.contexts);
  if (hasSchemaRefusal(schemas)) {
    throw new UpdatePreMutationError(
      "database-schema-preflight",
      formatSchemaRefusalLines(schemas).join("\n"),
    );
  }
  return admission;
}
