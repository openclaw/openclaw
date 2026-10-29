// Read-only engine admission before any candidate staging or runtime provisioning.
import { capturePackageActivationRuntime } from "../../infra/package-update-activation-paths.js";
import { UpdatePreMutationError } from "./shared.js";
import { inspectUpdateManagedServices } from "./update-command-database-context.js";
import { resolvePackageRuntimePreflight } from "./update-command-runtime-preflight.js";
import { isGatewayServiceManagementAllowedForUpdate } from "./update-command-service-plan.js";

export async function inspectPackageEngineAdmission(
  params: Parameters<typeof resolvePackageRuntimePreflight>[0] & {
    root: string;
    timeoutMs: number;
  },
) {
  const inspect = async (
    expectedServices?: Parameters<typeof inspectUpdateManagedServices>[0]["expectedServices"],
  ) =>
    await inspectUpdateManagedServices({
      roots: [params.root],
      updateInstallKind: "package",
      shouldRestart: params.shouldRestart === true,
      jsonMode: true,
      timeoutMs: params.timeoutMs,
      invocationCwd: params.invocationCwd,
      managedServiceRootRedirect: null,
      expectedServices,
    });
  // A planned runtime path is only discovery, not service ownership or write authority.
  const admission = params.nodeRunner ? await inspect() : undefined;
  const observed = admission?.foreground
    ? undefined
    : (admission?.service ?? admission?.services.get(params.root));
  // Retain values, not an inspection provider's mutable object, across probes.
  const service = observed
    ? {
        ...observed,
        serviceUpdateVerdict: observed.serviceUpdateVerdict
          ? { ...observed.serviceUpdateVerdict }
          : undefined,
        serviceEnv: observed.serviceEnv ? { ...observed.serviceEnv } : undefined,
        serviceDefinitionEnv: observed.serviceDefinitionEnv
          ? { ...observed.serviceDefinitionEnv }
          : undefined,
      }
    : undefined;
  const expectedServices = new Map(admission?.services);
  if (service) {
    expectedServices.set(params.root, service);
  }
  const runtime = await resolvePackageRuntimePreflight({ ...params, engineOnly: true, service });
  const selected = runtime.ok && runtime.value.replacedNodeRunner ? runtime.value : undefined;
  const assertCurrent = async () => {
    if (!selected?.activationRuntime || !admission || !service) {
      return;
    }
    const latest = await inspect(expectedServices);
    const current = latest.service ?? latest.services.get(params.root);
    const before = service.serviceUpdateVerdict;
    const after = current?.serviceUpdateVerdict;
    let executable;
    try {
      executable = capturePackageActivationRuntime("node", selected.nodeRunner!);
    } catch (cause) {
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        "Selected Node is no longer available after engine admission; retry without staging the target.",
        { cause },
      );
    }
    if (
      before?.kind !== "owned" ||
      after?.kind !== "owned" ||
      after.root !== before.root ||
      after.fingerprint !== before.fingerprint ||
      !after.refreshDefinition ||
      after.requiresInstallRootRefresh ||
      current?.serviceMutationAllowed === false ||
      !isGatewayServiceManagementAllowedForUpdate(current?.serviceEnv ?? process.env) ||
      !current?.running ||
      !current.inspected ||
      !current.runtimeInspected ||
      current.serviceNodeRunner !== service.serviceNodeRunner ||
      executable.path !== selected.activationRuntime.path ||
      executable.identity !== selected.activationRuntime.identity
    ) {
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        "Gateway service authority or selected Node changed after engine admission; retry without staging the target.",
      );
    }
  };
  await assertCurrent();
  return { runtime, assertCurrent };
}
