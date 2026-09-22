// Read-only managed Gateway ownership and Node selection for update planning.
import fs from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { err as resultError, ok, type Result } from "@openclaw/normalization-core/result";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { minVersion, validRange, valid } from "semver";
import { detectCurrentSqliteCapabilities, nodeRuntimeFailure } from "../../../node-sqlite.mjs";
import { createConfigIO } from "../../config/io.js";
import { resolveGatewayPort } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveNodeRuntimeInfo } from "../../daemon/runtime-paths.js";
import {
  formatServiceInspectionReason,
  type ServiceInspectionReason,
} from "../../daemon/service-inspection-error.js";
import { summarizeGatewayServiceLayout } from "../../daemon/service-layout.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceState,
} from "../../daemon/service-types.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { readActiveGatewayLockIdentity } from "../../infra/gateway-lock.js";
import { assertGatewayServiceMutationAllowed } from "../../infra/gateway-supervision.js";
import { tryReadJson } from "../../infra/json-files.js";
import { probePortUsage } from "../../infra/ports-probe.js";
import { nodeVersionSatisfiesEngine } from "../../infra/runtime-guard.js";
import { parseTcpPortFromArgs } from "../../infra/tcp-port.js";
import {
  createUpdateFailureFact,
  type UpdateFailureFact,
} from "../../infra/update-failure-facts.js";
import {
  createFreeBsdPkgOwnershipInspection,
  type FreeBsdPkgOwnershipInspection,
} from "../../infra/update-freebsd-pkg-ownership.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import { CLI_NAME } from "../cli-name.js";
import { resolveNodeRunner } from "./shared.js";
import type {
  ManagedGatewayUpdateVerdict,
  PreManagedServiceStop,
} from "./update-command-service-context-types.js";

export type ManagedServiceRootRedirect = {
  root: string;
  previousRoot: string;
};

export function collectServiceInspectionFailureFacts(
  verdict: ManagedGatewayUpdateVerdict | undefined,
): UpdateFailureFact[] | undefined {
  return verdict?.kind === "unavailable"
    ? [
        createUpdateFailureFact({
          check: "managed-service",
          code: verdict.inspectionReason ?? "service-inspection-unavailable",
          message: verdict.message,
        }),
      ]
    : undefined;
}

export class GatewayServiceUpdateOwnershipError extends Error {
  readonly failureFacts: UpdateFailureFact[];

  constructor(message: string, cause: unknown, inspectionReason?: ServiceInspectionReason) {
    super(message, { cause });
    this.name = "GatewayServiceUpdateOwnershipError";
    this.failureFacts = [
      createUpdateFailureFact({
        check: "managed-service",
        code: inspectionReason ?? "service-ownership-unverified",
        message,
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
      "Gateway service ownership changed after database admission; run `openclaw gateway status --deep` and retry.",
      undefined,
      serviceUpdateVerdict.kind === "unavailable"
        ? serviceUpdateVerdict.inspectionReason
        : undefined,
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
    throw new GatewayServiceUpdateOwnershipError(message, err);
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
    state.loadState.status === "unknown" ||
    (state.runtime?.status !== "running" && state.runtime?.status !== "stopped") ||
    (process.platform === "linux" && observedSystemdManagerUid(state) === undefined)
  ) {
    return unavailable();
  }
  const serialized = stableStringify(command);
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

/** Recorded launchers cannot select an update's package, Node, or state without live inspection. */
export async function readManagedGatewayServiceCommandForUpdate(
  env: NodeJS.ProcessEnv,
): Promise<GatewayServiceCommandConfig | null> {
  let service: ReturnType<typeof resolveGatewayService> | undefined;
  try {
    service = resolveGatewayService();
    const state = await readGatewayServiceState(service, {
      env,
      requireEffective: true,
      requireLoadedCommand: true,
      validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
    });
    if (!state.command) {
      return null;
    }
    const inspection = await inspectManagedGatewayServiceBeforeUpdate({ state });
    return inspection.kind === "owned" ? state.command : null;
  } catch (error) {
    if (error instanceof GatewayServiceUpdateOwnershipError && service) {
      // Probe only the invoker's manager; rejected record selectors must not route it.
      const available = await service.isLoaded({ env }).then(
        () => true,
        () => false,
      );
      if (available) {
        throw error;
      }
    }
    return null;
  }
}

type PackageRuntimePreflight = {
  nodeRunner?: string;
  replacedNodeRunner?: string;
  targetVersion?: string;
};

export async function resolvePackageRuntimePreflight(params: {
  target?: { version: string; nodeEngine: string | null };
  installedRoot?: string;
  timeoutMs?: number;
  nodeRunner?: string;
  root?: string;
  shouldRestart?: boolean;
  alreadyCurrent?: boolean;
  service?: PreManagedServiceStop;
}): Promise<Result<PackageRuntimePreflight, string> & { failureFacts?: UpdateFailureFact[] }> {
  const nodeRunner = normalizeOptionalString(
    params.alreadyCurrent
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
  const fallbackNodeRunner =
    params.shouldRestart &&
    nodeRunner &&
    (params.alreadyCurrent
      ? params.service?.running &&
        params.service.serviceUpdateVerdict?.kind === "owned" &&
        params.service.serviceUpdateVerdict.refreshDefinition
      : await gatewayServiceCommandUsesRoot({ root: params.root }))
      ? resolveNodeRunner()
      : undefined;
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
  const runtimeLabel = runtime.nodeRunner
    ? `Node ${runtime.version ?? "unknown"} at ${runtime.nodeRunner}`
    : `Node ${runtime.version ?? "unknown"}`;
  const engineRange = target.nodeEngine ? validRange(target.nodeEngine) : null;
  const minimum = engineRange ? (minVersion(engineRange)?.version ?? "unspecified") : "unspecified";
  return {
    ...resultError<PackageRuntimePreflight, string>(
      [
        `${runtimeLabel} is incompatible with openclaw@${targetVersion}.`,
        ...(runtime.failure ? [runtime.failure] : []),
        `The requested package requires ${target.nodeEngine}.`,
        runtime.nodeRunner
          ? "Use a compatible version of the Node runtime that owns the managed Gateway service, then rerun `openclaw update`."
          : "Use a Node runtime that satisfies the engine range above, then rerun `openclaw update`.",
        "Bare `npm i -g openclaw` can silently install an older compatible release.",
        "After switching Node versions, use `npm i -g openclaw@latest`.",
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

export function resolveManagedServiceNodeRunner(
  command: GatewayServiceCommandConfig | null,
): string | undefined {
  const args = command?.programArguments ?? [];
  // Native heap flags and dev loaders separate the executable from the entrypoint.
  const runner = args.indexOf("gateway") > 1 ? args[0] : undefined;
  const executable = normalizeOptionalString(runner ? path.basename(runner) : undefined);
  return ["node", "node.exe"].includes(executable?.toLowerCase() ?? "") ? runner : undefined;
}

export async function resolveManagedServicePackageUpdatePlan(params: {
  root: string;
  pkgOwnership?: FreeBsdPkgOwnershipInspection;
}): Promise<{ rootRedirect: ManagedServiceRootRedirect | null; nodeRunner?: string }> {
  const pkgOwnership =
    params.pkgOwnership ?? createFreeBsdPkgOwnershipInspection(UPDATE_RUNNER_TIMEOUT_MS);
  await pkgOwnership.assertUnowned(params.root);
  if (!isGatewayServiceManagementAllowedForUpdate(process.env)) {
    return { rootRedirect: null };
  }
  // Root and runtime planning share one effective command; mutation and restart
  // revalidate independently so this snapshot cannot grant later service authority.
  const command = await readManagedGatewayServiceCommandForUpdate(process.env);
  const layout = await summarizeGatewayServiceLayout(command);
  if (!layout?.packageRootReal) {
    return { rootRedirect: null };
  }
  const serviceRoot = layout?.packageRoot;
  await pkgOwnership.assertUnowned(serviceRoot);
  const serviceNode = resolveManagedServiceNodeRunner(command);
  if (
    serviceRoot &&
    layout.packageRootReal &&
    layout.entrypointSourceCheckout !== true &&
    (await tryRealpathOrResolve(params.root)) !== layout.packageRootReal
  ) {
    return {
      rootRedirect: { root: serviceRoot, previousRoot: params.root },
      ...(serviceNode ? { nodeRunner: serviceNode } : {}),
    };
  }
  if (!serviceNode) {
    return { rootRedirect: null };
  }
  const [serviceNodeReal, currentNodeReal] = await Promise.all([
    tryRealpathOrResolve(serviceNode),
    tryRealpathOrResolve(resolveNodeRunner()),
  ]);
  return {
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
        ? await readManagedGatewayServiceCommandForUpdate(params.env ?? process.env)
        : null
      : params.command;
  const layout = await summarizeGatewayServiceLayout(command);
  const serviceRoot = layout?.packageRoot;
  const serviceEntrypoint = layout?.entrypoint;
  if (
    !serviceRoot ||
    !serviceEntrypoint ||
    (!path.isAbsolute(serviceEntrypoint) && !path.win32.isAbsolute(serviceEntrypoint))
  ) {
    return null;
  }
  const [expectedRootReal, serviceRootReal] = await Promise.all([
    tryRealpathOrResolve(expectedRoot),
    tryRealpathOrResolve(serviceRoot),
  ]);
  if (expectedRootReal === serviceRootReal) {
    return true;
  }
  // Paired read-only release mounts have different paths but the same directory
  // identity. Copies of another release must remain foreign.
  const [expected, actual] = await Promise.all(
    [expectedRootReal, serviceRootReal].map((root) => fs.stat(root).catch(() => null)),
  );
  if (expected && actual && expected.dev === actual.dev && expected.ino === actual.ino) {
    return true;
  }
  const managed = command?.managedDefinition;
  if (
    !managed ||
    (await gatewayServiceCommandUsesRoot({ root: expectedRoot, command: managed })) !== true
  ) {
    return false;
  }
  const namespace = path.dirname(expectedRootReal);
  const managedLayout = await summarizeGatewayServiceLayout(managed);
  const stableEntry = path.join(
    namespace,
    "current",
    "dist",
    path.basename(managedLayout?.entrypoint ?? ""),
  );
  if (serviceEntrypoint !== stableEntry) {
    return false;
  }
  // Deployment-owned current points into this installation's releases, either
  // by symlink or by a paired bind mount. Unrelated namespaces remain foreign.
  const releases = path.join(namespace, "releases");
  if (serviceRootReal.startsWith(`${releases}${path.sep}`)) {
    return true;
  }
  try {
    for await (const entry of await fs.opendir(releases)) {
      const candidate = await fs.lstat(path.join(releases, entry.name));
      if (actual && candidate.dev === actual.dev && candidate.ino === actual.ino) {
        return true;
      }
    }
  } catch {
    // Without directory identity proof, the override cannot authorize lifecycle actions.
  }
  return false;
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

/** Describe the selected plan without changing roots, runtime, or service authority. */
export function formatManagedServicePackageUpdatePlan(params: {
  rootRedirect: ManagedServiceRootRedirect | null;
  nodeRunner?: string;
}): Array<{ level: "muted" | "warn"; message: string }> {
  const { rootRedirect, nodeRunner } = params;
  if (rootRedirect) {
    return [
      {
        level: "muted",
        message: `Targeting managed gateway service package root: ${rootRedirect.root}`,
      },
      {
        level: "warn",
        message: `Shell OpenClaw root differs from the managed gateway service root: ${rootRedirect.previousRoot}`,
      },
      {
        level: "muted",
        message: `After the update, make sure \`${CLI_NAME}\` on PATH resolves to the managed service root or reinstall the gateway service from the shell install you want to use.`,
      },
      ...(nodeRunner
        ? [{ level: "muted" as const, message: `Managed gateway service Node: ${nodeRunner}` }]
        : []),
    ];
  }
  return nodeRunner
    ? [
        {
          level: "warn",
          message: `Current Node (${resolveNodeRunner()}) differs from the managed gateway service Node (${nodeRunner}).`,
        },
        {
          level: "muted",
          message:
            "Using the managed service Node for this update so the gateway can start after the upgrade.",
        },
      ]
    : [];
}
