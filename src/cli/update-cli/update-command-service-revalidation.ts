import {
  normalizeWindowsTaskIdentity,
  resolveGatewayProfileSuffix,
} from "../../daemon/constants.js";
import { resolveLaunchAgentLabel } from "../../daemon/launchd-label.js";
import { resolveTaskName } from "../../daemon/schtasks-layout.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import { resolveSystemdServiceName } from "../../daemon/systemd-service-files.js";
import type {
  ManagedGatewayUpdateVerdict,
  PreManagedServiceStop,
} from "./update-command-service-context-types.js";
import {
  assertGatewayServiceManagementAllowedForUpdate,
  GatewayServiceUpdateOwnershipError,
  inspectManagedGatewayServiceBeforeUpdate,
  observedSystemdManagerUid,
} from "./update-command-service-plan.js";

function matchesStoppedService(
  before: Pick<PreManagedServiceStop, "serviceEnv" | "serviceUpdateVerdict" | "serviceManagerUid">,
  state: GatewayServiceState,
  inspection: ManagedGatewayUpdateVerdict,
  allowIncompleteInspection = false,
): boolean {
  const verdict = before.serviceUpdateVerdict;
  const refreshDefinition = verdict?.kind === "owned" && verdict.refreshDefinition;
  const resolveName =
    process.platform === "darwin"
      ? resolveLaunchAgentLabel
      : process.platform === "win32"
        ? (env: GatewayServiceState["env"]) => normalizeWindowsTaskIdentity(resolveTaskName(env))
        : resolveSystemdServiceName;
  // Explicit default metadata selects the same manager; protected command hashes
  // still pin the effective launcher and its environment through normalization.
  // Stable 2026.9.2/2026.9.3 handoffs omit the UID; compare it when recorded.
  return Boolean(
    before.serviceEnv &&
    state.command &&
    verdict &&
    "fingerprint" in verdict &&
    resolveGatewayProfileSuffix(before.serviceEnv.OPENCLAW_PROFILE) ===
      resolveGatewayProfileSuffix(state.env.OPENCLAW_PROFILE) &&
    resolveName(before.serviceEnv) === resolveName(state.env) &&
    (process.platform !== "linux" ||
      before.serviceManagerUid === undefined ||
      (allowIncompleteInspection && observedSystemdManagerUid(state) === undefined) ||
      before.serviceManagerUid === observedSystemdManagerUid(state)) &&
    (refreshDefinition ||
      ("fingerprint" in inspection && inspection.fingerprint === verdict.fingerprint)),
  );
}

export async function revalidateManagedGatewayServiceAfterUpdate(params: {
  state: GatewayServiceState;
  root: string;
  preManagedServiceStop?: Pick<
    PreManagedServiceStop,
    "serviceEnv" | "serviceUpdateVerdict" | "serviceManagerUid"
  >;
  allowInstallRootChange?: boolean;
  /** Restoration still rejects observed identity drift when a native probe fails. */
  allowIncompleteInspection?: boolean;
}): Promise<ManagedGatewayUpdateVerdict> {
  const before = params.preManagedServiceStop;
  const verdict = before?.serviceUpdateVerdict;
  assertGatewayServiceManagementAllowedForUpdate(params.state.env);
  const managerUid = observedSystemdManagerUid(params.state);
  if (
    params.allowIncompleteInspection &&
    before?.serviceManagerUid !== undefined &&
    managerUid !== undefined &&
    managerUid !== before.serviceManagerUid
  ) {
    throw new GatewayServiceUpdateOwnershipError(
      "Gateway service ownership or manager identity changed; inspect it before restarting manually.",
      undefined,
      undefined,
      "service-ownership-changed",
    );
  }
  // Shipped handoffs and package root swaps retain the exact launcher fingerprint.
  const inspection = await inspectManagedGatewayServiceBeforeUpdate({
    ...params,
    retainedCommand: verdict?.kind === "owned" || verdict?.kind === "unresolved",
    allowInstallRootChange: params.allowInstallRootChange && !verdict,
  });
  if (
    (params.allowInstallRootChange ||
      (verdict?.kind === "owned" && verdict.requiresInstallRootRefresh)) &&
    before &&
    verdict?.kind === "owned" &&
    verdict.refreshDefinition &&
    (inspection.kind === "foreign" || inspection.kind === "unresolved") &&
    (params.state.definitionMutationCapability?.kind ?? "writable") === "writable"
  ) {
    const retained = await inspectManagedGatewayServiceBeforeUpdate({
      state: params.state,
      root: verdict.root,
      retainedCommand: true,
      allowIncompleteInspection: params.allowIncompleteInspection,
    });
    // A verified core install can replace its root before rewriting the launcher.
    // Pin the original command even when pnpm has removed its old package directory.
    if (
      matchesStoppedService(
        { ...before, serviceUpdateVerdict: { ...verdict, refreshDefinition: false } },
        params.state,
        retained,
        params.allowIncompleteInspection,
      )
    ) {
      return { ...verdict, requiresInstallRootRefresh: true };
    }
  }
  if (
    before &&
    verdict &&
    (verdict.kind === "owned" || verdict.kind === "unresolved") &&
    !(params.allowIncompleteInspection && inspection.kind === "unavailable") &&
    (inspection.kind !== verdict.kind ||
      !matchesStoppedService(before, params.state, inspection, params.allowIncompleteInspection))
  ) {
    throw new GatewayServiceUpdateOwnershipError(
      inspection.kind === "unavailable"
        ? params.state.runtime?.inspectionFailure?.timeoutMs !== undefined
          ? inspection.message
          : "Gateway service ownership could not be verified because inspection is unavailable. Run `openclaw gateway status --deep` and retry."
        : "Gateway service ownership or manager identity changed; inspect it before restarting manually.",
      undefined,
      inspection.kind === "unavailable" ? inspection.inspectionReason : undefined,
      inspection.kind === "unavailable" ? undefined : "service-ownership-changed",
    );
  }
  return inspection.kind === "owned" && verdict?.kind === "owned" && !verdict.refreshDefinition
    ? { ...inspection, refreshDefinition: false }
    : inspection;
}
