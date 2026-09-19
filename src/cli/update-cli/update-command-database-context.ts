import type { LegacyConfigUpdatePlan } from "../../commands/doctor/legacy-config-repair.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { captureTargetDatabaseSchemaContext } from "./schema-preflight.js";
import { UpdatePreMutationError } from "./shared.js";
import { formatUpdateAncestryBlockMessage } from "./update-command-handoff.js";
import { captureOwnedManagedUpdatePreflightContext } from "./update-command-managed-context.js";
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
  expectedServices?: ReadonlyMap<string, PreManagedServiceStop>;
}) {
  return await withCommandProcessScope(async () => {
    let service: PreManagedServiceStop | undefined;
    const services = new Map<string, PreManagedServiceStop>();
    for (const root of new Set(params.roots)) {
      const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
        root,
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
    if (params.managedServiceRootRedirect && !managed) {
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
    return { service, services, contexts, managedEnv: managed?.env };
  });
}
