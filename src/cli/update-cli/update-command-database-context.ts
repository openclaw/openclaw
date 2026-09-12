import type { LegacyConfigUpdatePlan } from "../../commands/doctor/legacy-config-repair.js";
import { captureTargetDatabaseSchemaContext } from "./schema-preflight.js";
import { UpdatePreMutationError } from "./shared.js";
import { formatUpdateAncestryBlockMessage } from "./update-command-handoff.js";
import { captureOwnedManagedUpdatePreflightContext } from "./update-command-managed-context.js";
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
  /** Actual service owner during a forward rebind; not a package-root redirect. */
  managedServiceRoot?: string;
  expectedServices?: ReadonlyMap<string, PreManagedServiceStop>;
}) {
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
      if (error instanceof GatewayServiceUpdateOwnershipError) {
        throw new UpdatePreMutationError("managed-service-preflight", error.message);
      }
      throw error;
    });
    const unavailable =
      inspected.serviceUpdateVerdict?.kind === "unavailable"
        ? inspected.serviceUpdateVerdict.message
        : undefined;
    if (inspected.blockMessage || unavailable) {
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        formatUpdateAncestryBlockMessage(inspected.blockMessage ?? unavailable!),
      );
    }
    if (inspected.serviceUpdateVerdict?.kind === "unresolved") {
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        "Gateway service installation ownership is unresolved. Run `openclaw gateway status --deep` and retry before changing package or Git files.",
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
  return { service, services, contexts, managedEnv: managed?.env };
}
