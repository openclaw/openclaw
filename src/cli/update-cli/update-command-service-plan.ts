// Read-only managed Gateway ownership and Node selection for update planning.
import fs from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { err as resultError, ok, type Result } from "@openclaw/normalization-core/result";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { compare, minVersion, Range, satisfies as satisfiesRange, validRange, valid } from "semver";
import { detectCurrentSqliteCapabilities, nodeRuntimeFailure } from "../../../node-sqlite.mjs";
import { SUPPORTED_NODE_VERSION_RANGE } from "../../../node-version.mjs";
import { createConfigIO } from "../../config/io.js";
import { resolveGatewayPort } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveNodeRuntimeInfo } from "../../daemon/runtime-paths.js";
import {
  formatServiceInspectionReason,
  type ServiceInspectionReason,
} from "../../daemon/service-inspection-error.js";
import {
  gatewayServiceCommandMatchesRoot,
  resolveGatewayServiceInstallationRefreshRoot,
  resolveManagedServiceNodeRunner,
  summarizeGatewayServiceLayout,
} from "../../daemon/service-layout.js";
import {
  hasGatewayServiceDefinitionOverrides,
  type GatewayServiceCommandConfig,
  type GatewayServiceState,
} from "../../daemon/service-types.js";
import {
  readGatewayServiceState,
  resolveGatewayService,
  type GatewayService,
} from "../../daemon/service.js";
import { isContainerEnvironment } from "../../infra/container-environment.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { readActiveGatewayLockIdentity } from "../../infra/gateway-lock.js";
import { assertGatewayServiceMutationAllowed } from "../../infra/gateway-supervision.js";
import { tryReadJson } from "../../infra/json-files.js";
import { probePortUsage } from "../../infra/ports-probe.js";
import { nodeVersionSatisfiesEngine } from "../../infra/runtime-guard.js";
import { parseTcpPortFromArgs } from "../../infra/tcp-port.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
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
import {
  createRuntimeUpdateRecoverySteps,
  formatUpdateRecoverySteps,
  type UpdateRecoveryStep,
} from "../../shared/update-outcome.js";
import { resolveNodeVersionManager } from "../../shared/version-manager-path.js";
import { formatCliCommand } from "../command-format.js";
import { quoteCliArg, quotePowerShellArg } from "../quote-cli-arg.js";
import { resolveNodeRunner } from "./shared.js";
import type { PackageRuntimeRecovery } from "./update-command-node-runtime-resolution.js";
import type {
  ManagedGatewayUpdateVerdict,
  PreManagedServiceStop,
} from "./update-command-service-context-types.js";
import { resolveServiceRecoveryContext } from "./update-command-service-env.js";

export type ManagedServiceRootRedirect = {
  root: string;
  previousRoot: string;
};

export class GatewayServiceUpdateOwnershipError extends Error {
  readonly failureFacts: UpdateFailureFact[];

  constructor(
    message: string,
    cause: unknown,
    inspectionReason?: ServiceInspectionReason,
    code?: keyof typeof UPDATE_PREFLIGHT_DETAILS,
  ) {
    super(inspectionReason ? formatServiceInspectionReason(inspectionReason) : message, { cause });
    this.name = "GatewayServiceUpdateOwnershipError";
    this.failureFacts = [
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
    const message = err instanceof Error ? err.message : String(err);
    throw new GatewayServiceUpdateOwnershipError(
      message,
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
    return (
      `${GATEWAY_SERVICE_INSPECTION_WARNING} ` +
      "On FreeBSD, use the Gateway's rc.d or foreground process owner for service management."
    );
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
  return detail
    ? `${GATEWAY_SERVICE_INSPECTION_WARNING} ${detail}`
    : GATEWAY_SERVICE_INSPECTION_WARNING;
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
  if (
    !params.allowIncompleteInspection &&
    (state.loadState.status === "unknown" ||
      (state.runtime?.status !== "running" && state.runtime?.status !== "stopped") ||
      (process.platform === "linux" && observedSystemdManagerUid(state) === undefined))
  ) {
    return unavailable();
  }
  // Stable updaters through 2026.9.4 omit known-empty systemd override metadata.
  // Keep their fingerprint while the full snapshot retains authored defaults for runtime pinning.
  const {
    managedDefinition: _managedDefinition,
    managedOverrides: _managedOverrides,
    ...effectiveCommand
  } = command;
  const serialized = stableStringify(
    hasGatewayServiceDefinitionOverrides(command) ? command : effectiveCommand,
  );
  if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) {
    return unavailable();
  }
  // Early selection verifies the service's own package before it may redirect the invoker.
  const root = params.root ?? (await summarizeGatewayServiceLayout(command))?.packageRootReal;
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
): Promise<GatewayServiceState> {
  return readGatewayServiceState(service, {
    env,
    requireEffective: true,
    requireLoadedCommand: true,
    validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
    timeoutMs,
  });
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
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      if (error instanceof GatewayServiceUpdateOwnershipError && service) {
        // Probe only the invoker's manager; rejected record selectors must not route it.
        const available = await service.isLoaded({ env }).then(
          () => true,
          (probeError: unknown) => {
            if (hasCommandProcessCleanupError(probeError)) {
              throw probeError;
            }
            return false;
          },
        );
        if (available) {
          throw error;
        }
      }
      return null;
    }
  });
}

export type PackageRuntimePreflight = {
  nodeRunner?: string;
  replacedNodeRunner?: string;
  targetVersion?: string;
};

export async function resolvePackageRuntimePreflight(params: {
  channel?: UpdateChannel;
  requestedChannel?: UpdateChannel | null;
  target?: { version: string; nodeEngine: string | null };
  installedRoot?: string;
  timeoutMs?: number;
  nodeRunner?: string;
  root?: string;
  shouldRestart?: boolean;
  alreadyCurrent?: boolean;
  service?: PreManagedServiceStop;
  invocationCwd?: string;
  /** An already-current source checkout retains its launcher across a global-prefix switch. */
  sourceRoot?: string;
  fallbackNodeRunner?: string;
  runtimeRecovery?: PackageRuntimeRecovery;
}): Promise<
  Result<PackageRuntimePreflight, string> & {
    failureFacts?: UpdateFailureFact[];
    recoverySteps?: UpdateRecoveryStep[];
  }
> {
  return await withCommandProcessScope(async () => {
    const nodeRunner = normalizeOptionalString(
      params.alreadyCurrent &&
        !(
          params.service?.serviceUpdateVerdict?.kind === "owned" &&
          params.service.serviceUpdateVerdict.requiresInstallRootRefresh
        )
        ? (params.service?.serviceNodeRunner ?? params.nodeRunner)
        : params.nodeRunner,
    );
    const unchanged = (): PackageRuntimePreflight => (nodeRunner ? { nodeRunner } : {});
    let target = params.target;
    if (!target && params.installedRoot) {
      const manifest = asNullableRecord(
        await tryReadJson<unknown>(path.join(params.installedRoot, "package.json"), {
          maxBytes: 1024 * 1024,
        }),
      );
      const version = normalizeOptionalString(manifest?.version);
      if (!version) {
        return resultError(
          "Cannot inspect the installed OpenClaw runtime requirement; repair its package.json before retrying openclaw update.",
        );
      }
      target = {
        version,
        nodeEngine: normalizeOptionalString(asNullableRecord(manifest?.engines)?.node) ?? null,
      };
    }
    if (!target) {
      return ok(unchanged());
    }
    const runtime = await resolvePackageRuntimeForPreflight({
      nodeRunner,
      timeoutMs: params.timeoutMs,
    });
    const satisfies = runtime.failure
      ? false
      : nodeVersionSatisfiesEngine(runtime.version, target.nodeEngine);
    const targetVersion = target.version;
    const unchangedRuntime = { ...unchanged(), targetVersion };
    if (satisfies === true) {
      return ok(unchangedRuntime);
    }
    const canRefreshCurrentService =
      params.service?.running &&
      params.service.serviceUpdateVerdict?.kind === "owned" &&
      params.service.serviceUpdateVerdict.refreshDefinition;
    const fallbackNodeRunner =
      params.fallbackNodeRunner ??
      (params.shouldRestart &&
      nodeRunner &&
      (params.alreadyCurrent
        ? canRefreshCurrentService
        : await gatewayServiceCommandUsesRoot({ root: params.root }))
        ? resolveNodeRunner()
        : undefined);
    if (nodeRunner && fallbackNodeRunner && fallbackNodeRunner !== nodeRunner) {
      const fallbackRuntime = await resolvePackageRuntimeForPreflight({
        nodeRunner: fallbackNodeRunner,
        timeoutMs: params.timeoutMs,
      });
      const fallbackSatisfies = fallbackRuntime.failure
        ? false
        : nodeVersionSatisfiesEngine(fallbackRuntime.version, target.nodeEngine);
      if (fallbackSatisfies === true) {
        return ok({
          nodeRunner: fallbackNodeRunner,
          replacedNodeRunner: nodeRunner,
          targetVersion,
        });
      }
    }
    if (satisfies !== false) {
      return ok(unchangedRuntime);
    }
    if (params.runtimeRecovery && target.nodeEngine) {
      const { resolveTargetNodeRuntime } =
        await import("./update-command-node-runtime-resolution.js");
      const recovered = await resolveTargetNodeRuntime({
        engine: target.nodeEngine,
        recovery: params.runtimeRecovery,
        timeoutMs: params.timeoutMs,
      });
      if (recovered) {
        return ok({
          nodeRunner: recovered,
          replacedNodeRunner: nodeRunner ?? resolveNodeRunner(),
          targetVersion,
        });
      }
    }
    const runtimeLabel = runtime.nodeRunner
      ? `Node ${runtime.version ?? "unknown"} at ${runtime.nodeRunner}`
      : `Node ${runtime.version ?? "unknown"}`;
    const engineRange = target.nodeEngine ? validRange(target.nodeEngine) : null;
    const minimum = engineRange
      ? (minVersion(engineRange)?.version ?? "unspecified")
      : "unspecified";
    const recommendation = minimumSupportedNodeVersion(engineRange ?? "*");
    const requirement = target.nodeEngine ? `Node ${target.nodeEngine}` : "a working Node runtime";
    const verdict = params.service?.serviceUpdateVerdict;
    const context =
      verdict?.kind === "owned" && params.service?.serviceEnv
        ? resolveServiceRecoveryContext({
            serviceEnv: params.service.serviceEnv,
            serviceDefinitionEnv: params.service.serviceDefinitionEnv,
            invocationCwd: params.invocationCwd,
          })
        : undefined;
    const env = context?.env ?? params.service?.serviceEnv ?? process.env;
    const recoveryVersion = valid(targetVersion);
    const recoveryChannel =
      params.requestedChannel ??
      (params.channel === "extended-stable" ? params.channel : undefined);
    const recoveryTarget = [
      "openclaw update",
      recoveryChannel ? `--channel ${recoveryChannel}` : "",
      params.sourceRoot || params.channel === "extended-stable" ? "" : `--tag ${recoveryVersion}`,
    ]
      .filter(Boolean)
      .join(" ");
    const retainedRoot = params.sourceRoot ?? params.root ?? params.installedRoot;
    const retainedEntry = retainedRoot ? path.resolve(retainedRoot, "openclaw.mjs") : undefined;
    const continuation = retainedEntry
      ? formatCliCommand(recoveryTarget, env).replace(
          /^openclaw\b/,
          () =>
            `node ${process.platform === "win32" ? quotePowerShellArg(retainedEntry) : quoteCliArg(retainedEntry)}`,
        )
      : undefined;
    const recoverySteps =
      recommendation && recoveryVersion
        ? createRuntimeUpdateRecoverySteps({
            nodeVersion: recommendation,
            targetVersion: recoveryVersion,
            manager: resolveNodeVersionManager(
              await tryRealpathOrResolve(runtime.nodeRunner ?? resolveNodeRunner()),
              env,
            ),
            container: isContainerEnvironment(),
            contextCommand: context?.command,
            continuation,
          })
        : undefined;
    if (
      recoverySteps?.at(-1)?.kind === "continue-update" &&
      params.alreadyCurrent &&
      nodeRunner &&
      params.service?.serviceNodeRunner &&
      !canRefreshCurrentService
    ) {
      recoverySteps.splice(-1, 0, {
        kind: "select-runtime",
        instruction: `The Gateway service still selects ${nodeRunner}. Before continuing, have its deployment owner select Node ${recommendation} in the service definition while retaining its installation, service account, and state/config selectors. Switching the shell runtime alone does not update that service definition.`,
      });
    }
    const upgrade = recoverySteps
      ? `Recovery:\n${formatUpdateRecoverySteps(recoverySteps)}`
      : recommendation
        ? "Select a published OpenClaw version before installing it under a supported Node runtime."
        : `No Node version satisfies both this range and this updater's supported range (${SUPPORTED_NODE_VERSION_RANGE}). This candidate version cannot be run by this updater with a supported Node release; install a supported Node and select a compatible OpenClaw target.`;
    return {
      ...(recoverySteps ? { recoverySteps } : {}),
      ...resultError<PackageRuntimePreflight, string>(
        [
          `openclaw@${targetVersion} requires ${requirement}; selected runtime is ${runtimeLabel}.`,
          ...(runtime.failure ? [runtime.failure] : []),
          upgrade,
        ].join("\n"),
      ),
      failureFacts: [
        createUpdateFailureFact({
          check: "node-runtime",
          code: "node-runtime-preflight",
          affectedKey: "engines.node",
          message: `Target package: openclaw@${valid(targetVersion) ?? "unknown"}; Minimum Node engine: ${minimum}; Running Node: ${valid(runtime.version ?? "") ?? "unknown"}`,
        }),
      ],
    };
  });
}

function minimumSupportedNodeVersion(engineRange: string): string | undefined {
  const candidate = new Range(engineRange);
  return new Range(SUPPORTED_NODE_VERSION_RANGE).set
    .flatMap((supported) =>
      candidate.set.flatMap((required) => {
        const intersection = [...supported, ...required].map((entry) => entry.value).join(" ");
        const minimum = minVersion(intersection);
        if (!minimum) {
          return [];
        }
        // Node's release contract excludes prereleases, even when engines allow them.
        const release = `${minimum.major}.${minimum.minor}.${minimum.patch}`;
        return satisfiesRange(release, intersection) ? [release] : [];
      }),
    )
    .toSorted(compare)[0];
}

async function resolvePackageRuntimeForPreflight(params: {
  nodeRunner?: string;
  timeoutMs?: number;
}): Promise<{ version: string | null; nodeRunner?: string; failure: string | null }> {
  const nodeRunner = normalizeOptionalString(params.nodeRunner);
  if (!nodeRunner) {
    const version = process.versions.node ?? null;
    return {
      version,
      failure: nodeRuntimeFailure(version, await detectCurrentSqliteCapabilities()),
    };
  }
  const runtime = await resolveNodeRuntimeInfo(
    nodeRunner,
    process.env,
    params.timeoutMs ?? UPDATE_RUNNER_TIMEOUT_MS,
  );
  return {
    version: runtime.status === "probe-failed" ? null : runtime.version,
    failure:
      runtime.status === "probe-failed" ? runtime.error.message : (runtime.capabilityError ?? null),
    nodeRunner,
  };
}

async function tryRealpathOrResolve(value: string): Promise<string> {
  return await fs.realpath(path.resolve(value)).catch(() => path.resolve(value));
}

export async function resolveManagedServicePackageUpdatePlan(params: {
  root: string;
  pkgOwnership?: FreeBsdPkgOwnershipInspection;
  rebind?: boolean;
}): Promise<{
  rootRedirect: ManagedServiceRootRedirect | null;
  serviceRoot?: string;
  nodeRunner?: string;
  serviceUnitTarget?: string;
}> {
  const pkgOwnership =
    params.pkgOwnership ?? createFreeBsdPkgOwnershipInspection(UPDATE_RUNNER_TIMEOUT_MS);
  await pkgOwnership.assertUnowned(params.root);
  if (!isGatewayServiceManagementAllowedForUpdate(process.env)) {
    return {
      rootRedirect: null,
      serviceUnitTarget: "not inspected (service management unavailable)",
    };
  }
  // Root and runtime planning share one effective command; mutation and restart
  // revalidate independently so this snapshot cannot grant later service authority.
  const inspected = await readManagedGatewayServiceForUpdate(process.env);
  const command = inspected?.command ?? null;
  const layout = await summarizeGatewayServiceLayout(command);
  const serviceUnitTarget = layout?.entrypoint ?? "no service entrypoint found";
  if (!layout?.packageRootReal) {
    return { rootRedirect: null, serviceUnitTarget };
  }
  const serviceRoot = layout?.packageRoot;
  await pkgOwnership.assertUnowned(serviceRoot);
  const serviceNode = resolveManagedServiceNodeRunner(command);
  if (
    layout.entrypointSourceCheckout &&
    (await tryRealpathOrResolve(params.root)) !== layout.packageRootReal
  ) {
    return { rootRedirect: null, serviceUnitTarget };
  }
  if (
    serviceRoot &&
    layout.entrypointSourceCheckout !== true &&
    (await tryRealpathOrResolve(params.root)) !== layout.packageRootReal
  ) {
    // Only an owned, writable definition can move from serving A to invoking B.
    // Windows/overridden definitions retain the existing service-root update path.
    const canRebind =
      params.rebind !== false &&
      process.platform !== "win32" &&
      !hasGatewayServiceDefinitionOverrides(command) &&
      inspected?.verdict.refreshDefinition === true;
    return {
      serviceUnitTarget,
      ...(canRebind
        ? { rootRedirect: null, serviceRoot }
        : { rootRedirect: { root: serviceRoot, previousRoot: params.root } }),
      ...(serviceNode ? { nodeRunner: serviceNode } : {}),
    };
  }
  if (!serviceNode) {
    return { rootRedirect: null, serviceUnitTarget };
  }
  const [serviceNodeReal, currentNodeReal] = await Promise.all([
    tryRealpathOrResolve(serviceNode),
    tryRealpathOrResolve(resolveNodeRunner()),
  ]);
  return {
    serviceUnitTarget,
    rootRedirect: null,
    ...(serviceNodeReal !== currentNodeReal ? { nodeRunner: serviceNode } : {}),
  };
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
