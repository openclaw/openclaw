// Read-only managed Gateway ownership and runtime selection for update planning.
import fs from "node:fs/promises";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createConfigIO } from "../../config/io.js";
import { resolveGatewayPort } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isBunRuntime } from "../../daemon/runtime-binary.js";
import { resolvePinnedDaemonRuntimePath } from "../../daemon/runtime-paths.js";
import {
  formatServiceInspectionReason,
  ServiceStartRefusalError,
  type ServiceInspectionReason,
} from "../../daemon/service-inspection-error.js";
import {
  gatewayServiceCommandMatchesRoot,
  resolveGatewayServiceInstallationRefreshRoot,
  resolveManagedServiceNodeRunner,
  summarizeGatewayServiceLayout,
} from "../../daemon/service-layout.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import {
  hasGatewayServiceDefinitionOverrides,
  type GatewayServiceCommandConfig,
  type GatewayServiceState,
  type GatewayServiceUnitInspection,
} from "../../daemon/service-types.js";
import {
  readGatewayServiceState,
  resolveGatewayService,
  type GatewayService,
} from "../../daemon/service.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { readActiveGatewayLockIdentity } from "../../infra/gateway-lock.js";
import { assertGatewayServiceMutationAllowed } from "../../infra/gateway-supervision.js";
import { formatInstallOwnerMessage, readInstallOwner } from "../../infra/install-owner.js";
import { probePortUsage } from "../../infra/ports-probe.js";
import { parseTcpPortFromArgs } from "../../infra/tcp-port.js";
import {
  createUpdateFailureFact,
  type UpdateFailureFact,
} from "../../infra/update-failure-facts.js";
import {
  createFreeBsdPkgOwnershipInspection,
  type FreeBsdPkgOwnershipInspection,
} from "../../infra/update-freebsd-pkg-ownership.js";
import type { UPDATE_PREFLIGHT_DETAILS } from "../../infra/update-preflight-details.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { resolveNodeRunner } from "./shared.js";
import type {
  ManagedGatewayUpdateVerdict,
  ManagedServicePackageUpdatePlan,
} from "./update-command-service-context-types.js";
import { resolveUpdateServiceHeapEnv } from "./update-command-service-env.js";

export class GatewayServiceUpdateOwnershipError extends Error {
  readonly failureFacts: UpdateFailureFact[];

  constructor(
    message: string | { message: string; failureFacts: UpdateFailureFact[] },
    cause: unknown,
    inspectionReason?: ServiceInspectionReason,
    code?: keyof typeof UPDATE_PREFLIGHT_DETAILS,
  ) {
    super(
      typeof message === "string"
        ? inspectionReason
          ? formatServiceInspectionReason(inspectionReason)
          : message
        : message.message,
      { cause },
    );
    this.name = "GatewayServiceUpdateOwnershipError";
    this.failureFacts =
      typeof message !== "string"
        ? message.failureFacts
        : [
            createUpdateFailureFact({
              check: "managed-service",
              code: inspectionReason ?? code ?? "service-ownership-unverified",
              message: this.message,
            }),
          ];
  }
}

export function assertGatewayServiceAdmissionUnchanged(
  expectedService: { serviceUpdateVerdict?: ManagedGatewayUpdateVerdict } | undefined,
  serviceUpdateVerdict: ManagedGatewayUpdateVerdict,
): void {
  const expectedVerdict = expectedService?.serviceUpdateVerdict;
  if (expectedVerdict && expectedVerdict.kind !== serviceUpdateVerdict.kind) {
    throw new GatewayServiceUpdateOwnershipError(
      serviceUpdateVerdict.kind === "unavailable"
        ? "Gateway service ownership could not be verified because inspection is unavailable. Run `openclaw gateway status --deep` and retry."
        : "Gateway service ownership changed after database admission; run `openclaw gateway status --deep` and retry.",
      undefined,
      serviceUpdateVerdict.kind === "unavailable"
        ? serviceUpdateVerdict.inspectionReason
        : undefined,
      serviceUpdateVerdict.kind === "unavailable" ? undefined : "service-ownership-changed",
    );
  }
  if (
    expectedVerdict?.kind === "owned" &&
    serviceUpdateVerdict.kind === "owned" &&
    expectedVerdict.fingerprint !== serviceUpdateVerdict.fingerprint
  ) {
    // Permission to refresh a writable definition after install does not allow
    // its environment to change between database admission and native preparation.
    throw new GatewayServiceUpdateOwnershipError(
      "Gateway service definition changed after database admission; retry against its current configuration.",
      undefined,
      undefined,
      "service-definition-changed",
    );
  }
}

export function resolveGatewayServiceManagementBlockMessageForUpdate(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  try {
    assertGatewayServiceManagementAllowedForUpdate(env);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function assertGatewayServiceManagementAllowedForUpdate(
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    assertGatewayServiceMutationAllowed("manage the gateway service during update", env);
  } catch (err) {
    throw new GatewayServiceUpdateOwnershipError(
      err instanceof Error ? err.message : String(err),
      err,
      undefined,
      "service-mutation-refused",
    );
  }
}

export function isGatewayServiceManagementAllowedForUpdate(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveGatewayServiceManagementBlockMessageForUpdate(env) === undefined;
}

export const GATEWAY_SERVICE_INSPECTION_WARNING =
  "Gateway service inspection is unavailable; automatic service restart was skipped. Restart the Gateway you launched manually after the update. Any recorded service definition was left unchanged; inspect it with `openclaw gateway status --deep`.";

function serviceInspectionWarningMessage(state: GatewayServiceState): string {
  if (state.inspectionReason) {
    return `${GATEWAY_SERVICE_INSPECTION_WARNING} ${formatServiceInspectionReason(state.inspectionReason)}`;
  }
  if (process.platform === "freebsd") {
    return `${GATEWAY_SERVICE_INSPECTION_WARNING} On FreeBSD, use the Gateway's rc.d or foreground process owner for service management.`;
  }
  const runtime = state.runtime;
  const tasksCurrent = runtime?.systemd?.tasksCurrent;
  if (
    process.platform === "linux" &&
    runtime?.status === "unknown" &&
    (runtime.state === "inactive" || runtime.state === "failed") &&
    !runtime.pid &&
    tasksCurrent !== undefined &&
    tasksCurrent > 0
  ) {
    return `${GATEWAY_SERVICE_INSPECTION_WARNING} Processes remain in the systemd service cgroup (${tasksCurrent} tasks). Have their owner stop them before state maintenance.`;
  }
  const detail = runtime?.inspectionFailure?.detail;
  return GATEWAY_SERVICE_INSPECTION_WARNING + (detail ? ` ${detail}` : "");
}

export function observedSystemdManagerUid(state: GatewayServiceState): number | undefined {
  const uid = state.runtime?.systemd?.managerUid;
  return typeof uid === "number" && Number.isInteger(uid) && uid >= 0 && uid < 0xffffffff
    ? uid
    : undefined;
}

export async function inspectManagedGatewayServiceBeforeUpdate(params: {
  root?: string;
  state: GatewayServiceState;
  retainedCommand?: boolean;
  allowIncompleteInspection?: boolean;
  allowInstallRootChange?: boolean;
}): Promise<ManagedGatewayUpdateVerdict> {
  const { state } = params;
  const refusal = state.runtime?.systemd?.startRefusal;
  if (refusal) {
    throw new GatewayServiceUpdateOwnershipError(
      refusal.message,
      new ServiceStartRefusalError(refusal),
      undefined,
      "service-mutation-refused",
    );
  }
  const { command } = state;
  const unavailable = (): ManagedGatewayUpdateVerdict => ({
    kind: "unavailable",
    message: serviceInspectionWarningMessage(state),
    ...(state.inspectionReason ? { inspectionReason: state.inspectionReason } : {}),
  });
  if (!command) {
    return !state.installed &&
      state.loadState.status === "not-loaded" &&
      !state.running &&
      state.runtime?.missingUnit &&
      (await readActiveGatewayLockIdentity({ env: state.env, requireInspection: true }).then(
        (identity) => !identity,
        () => false,
      )) &&
      (await probePortUsage(await resolveUpdatedGatewayRestartPort({ serviceEnv: state.env }))) ===
        "free"
      ? { kind: "absent" }
      : unavailable();
  }
  // Direct Windows actions are readable, but the updater cannot restore them
  // through its managed CMD/VBS definition and control owners.
  if (process.platform === "win32" && !command.sourcePath) {
    return unavailable();
  }
  if (
    !params.allowIncompleteInspection &&
    (state.loadState.status === "unknown" ||
      (state.runtime?.status !== "running" && state.runtime?.status !== "stopped") ||
      (process.platform === "linux" && observedSystemdManagerUid(state) === undefined))
  ) {
    return unavailable();
  }
  // Updaters through 2026.9.4 omit selection provenance and known-empty systemd overrides.
  // Keep their fingerprint while discovery and runtime pinning retain the full snapshot.
  const { startupEntryPaths: _startupEntryPaths, ...fingerprintCommand } = command;
  if (!hasGatewayServiceDefinitionOverrides(fingerprintCommand)) {
    delete fingerprintCommand.managedDefinition;
    delete fingerprintCommand.managedOverrides;
  }
  const serialized = stableStringify(fingerprintCommand);
  if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) {
    return unavailable();
  }
  // The service's payload owner also controls updates invoked from another installation.
  const layout = await summarizeGatewayServiceLayout(command);
  const installOwner = await readInstallOwner(layout?.packageRootReal ?? null);
  if (installOwner) {
    throw new GatewayServiceUpdateOwnershipError(
      formatInstallOwnerMessage(installOwner),
      undefined,
      undefined,
      "service-mutation-refused",
    );
  }
  // Early selection verifies the service's own package before it may redirect the invoker.
  const root = params.root ?? layout?.packageRootReal;
  if (!root) {
    return unavailable();
  }
  // Lifecycle authority follows the effective launcher, not the writable base
  // that a drop-in may replace with a different installation.
  const ownsRoot = await gatewayServiceCommandUsesRoot({ root, command });
  if (ownsRoot === null && !params.retainedCommand) {
    return unavailable();
  }
  if (ownsRoot === false) {
    const serviceRoot = params.allowInstallRootChange
      ? await resolveGatewayServiceInstallationRefreshRoot({ root, state })
      : undefined;
    if (serviceRoot) {
      return {
        kind: "owned",
        root: serviceRoot,
        fingerprint: sha256Hex(serialized),
        refreshDefinition: true,
        requiresInstallRootRefresh: true,
      };
    }
    return { kind: "foreign" };
  }
  const fingerprint = sha256Hex(serialized);
  return ownsRoot
    ? {
        kind: "owned",
        root,
        fingerprint,
        refreshDefinition: (state.definitionMutationCapability?.kind ?? "writable") === "writable",
      }
    : { kind: "unresolved", root, fingerprint };
}

/** Update ownership requires the effective loaded command and an admitted manager route. */
export function readGatewayServiceStateForUpdate(
  service: GatewayService,
  env: NodeJS.ProcessEnv | undefined,
  timeoutMs?: number,
  inspection?: { managerUid: number | undefined; assertCurrent: () => void },
): Promise<GatewayServiceState> {
  const read = (loadForInspection?: GatewayServiceUnitInspection) =>
    readGatewayServiceState(service, {
      env,
      requireEffective: true,
      requireLoadedCommand: true,
      loadForInspection,
      validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
      timeoutMs,
    })
      .then((state) => ({
        ...state,
        env: resolveUpdateServiceHeapEnv(state.env, env, state.command?.programArguments),
      }))
      .catch((error: unknown) => {
        if (error instanceof ServiceStartRefusalError) {
          throw new GatewayServiceUpdateOwnershipError(
            error.message,
            error,
            undefined,
            "service-mutation-refused",
          );
        }
        throw error;
      });
  if (process.platform !== "linux" || inspection?.managerUid === undefined) {
    return read();
  }
  const { managerUid } = inspection;
  // systemd may collect a stopped unit; loading its metadata retains both owners.
  return withGatewayServiceOperationLock(env ?? process.env, async (assertNative) => {
    const assertCurrent = () => {
      assertNative();
      inspection.assertCurrent();
    };
    assertCurrent();
    const state = await read({ managerUid, assertCurrent, assertReadCurrent: assertNative });
    assertCurrent();
    return state;
  });
}

/** Manager availability is distinct from a loaded unit; uncertain cleanup remains fatal. */
export function isUpdateServiceManagerAvailable(inspect: Promise<boolean>): Promise<boolean> {
  return inspect.then(
    () => true,
    (error: unknown) => {
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      return false;
    },
  );
}

/** Recorded launchers cannot select an update's package, Node, or state without live inspection. */
export async function readManagedGatewayServiceForUpdate(
  env: NodeJS.ProcessEnv,
  root?: string,
  allowInstallRootChange = false,
) {
  return await withCommandProcessScope(async () => {
    let service: ReturnType<typeof resolveGatewayService> | undefined;
    try {
      service = resolveGatewayService();
      const state = await readGatewayServiceStateForUpdate(service, env);
      if (!state.command) {
        return null;
      }
      const inspection = await inspectManagedGatewayServiceBeforeUpdate({
        state,
        root,
        allowInstallRootChange,
      });
      return inspection.kind === "owned"
        ? { ...state, command: state.command, verdict: inspection }
        : null;
    } catch (error) {
      if (
        hasCommandProcessCleanupError(error) ||
        (error instanceof GatewayServiceUpdateOwnershipError &&
          error.cause instanceof ServiceStartRefusalError)
      ) {
        throw error;
      }
      if (error instanceof GatewayServiceUpdateOwnershipError && service) {
        // Probe only the invoker's manager; rejected record selectors must not route it.
        const available = await isUpdateServiceManagerAvailable(service.isLoaded({ env }));
        if (available) {
          throw error;
        }
      }
      return null;
    }
  });
}

export async function tryRealpathOrResolve(value: string): Promise<string> {
  return await fs.realpath(path.resolve(value)).catch(() => path.resolve(value));
}

export async function resolveManagedServicePackageUpdatePlan(params: {
  root: string;
  pkgOwnership?: FreeBsdPkgOwnershipInspection;
  rebind?: boolean;
}): Promise<ManagedServicePackageUpdatePlan> {
  const pkgOwnership =
    params.pkgOwnership ?? createFreeBsdPkgOwnershipInspection(UPDATE_RUNNER_TIMEOUT_MS);
  await pkgOwnership.assertUnowned(params.root);
  const plan: ManagedServicePackageUpdatePlan = {
    rootRedirect: null,
    serviceUnitTarget: "not inspected (service management unavailable)",
  };
  if (!isGatewayServiceManagementAllowedForUpdate(process.env)) {
    return plan;
  }
  // Root and runtime planning share one effective command; mutation and restart
  // revalidate independently so this snapshot cannot grant later service authority.
  const inspected = await readManagedGatewayServiceForUpdate(process.env);
  const command = inspected?.command ?? null;
  const layout = await summarizeGatewayServiceLayout(command);
  plan.serviceUnitTarget = layout?.entrypoint ?? "no service entrypoint found";
  if (!layout?.packageRootReal) {
    return plan;
  }
  const serviceRoot = layout?.packageRoot;
  await pkgOwnership.assertUnowned(serviceRoot);
  const differentRoot = (await tryRealpathOrResolve(params.root)) !== layout.packageRootReal;
  if (layout.entrypointSourceCheckout && differentRoot) {
    return plan;
  }
  const executable = command?.programArguments[0];
  const serviceBun = executable && isBunRuntime(executable);
  const serviceNode = serviceBun
    ? await resolvePinnedDaemonRuntimePath(executable, "bun", inspected?.env ?? process.env)
    : resolveManagedServiceNodeRunner(command);
  if (
    serviceNode &&
    (differentRoot ||
      serviceBun ||
      (await tryRealpathOrResolve(serviceNode)) !==
        (await tryRealpathOrResolve(resolveNodeRunner())))
  ) {
    plan.nodeRunner = serviceNode;
  }
  if (serviceRoot && differentRoot) {
    // Only an owned, writable definition can move from serving A to invoking B.
    // Bun and protected definitions retain the existing service-root update path.
    if (
      !serviceBun &&
      params.rebind !== false &&
      process.platform !== "win32" &&
      !hasGatewayServiceDefinitionOverrides(command) &&
      inspected?.verdict.refreshDefinition === true
    ) {
      plan.serviceRoot = serviceRoot;
    } else {
      plan.rootRedirect = { root: serviceRoot, previousRoot: params.root };
    }
  }
  return plan;
}

export async function gatewayServiceCommandUsesRoot(params: {
  root: string | undefined;
  env?: NodeJS.ProcessEnv;
  command?: GatewayServiceCommandConfig | null;
}): Promise<boolean | null> {
  const expectedRoot = normalizeOptionalString(params.root);
  if (!expectedRoot) {
    return null;
  }
  const command =
    params.command === undefined
      ? isGatewayServiceManagementAllowedForUpdate(params.env ?? process.env)
        ? ((await readManagedGatewayServiceForUpdate(params.env ?? process.env))?.command ?? null)
        : null
      : params.command;
  return await gatewayServiceCommandMatchesRoot(expectedRoot, command);
}

export async function resolveUpdatedGatewayRestartPort(params: {
  config?: OpenClawConfig;
  processEnv?: NodeJS.ProcessEnv;
  serviceEnv?: NodeJS.ProcessEnv;
  serviceCommand?: GatewayServiceCommandConfig | null;
}): Promise<number> {
  const env = params.serviceEnv ?? params.processEnv ?? process.env;
  let config = params.config;
  if (params.serviceCommand) {
    // Preserved launchers keep their explicit port and their own config context;
    // refresh callers omit the old command and use the intended new configuration.
    const port = parseTcpPortFromArgs(params.serviceCommand.programArguments);
    if (port !== null) {
      return port;
    }
  }
  if (params.serviceCommand || !config) {
    config = await createConfigIO({
      env,
      observe: false,
      pluginValidation: "skip",
      suppressFutureVersionWarning: true,
    }).readBestEffortConfig();
  }
  return resolveGatewayPort(config, env);
}
