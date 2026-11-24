import fs from "node:fs/promises";
import path from "node:path";
import { summarizeGatewayServiceLayout } from "../../daemon/service-layout.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readPackageName, readPackageVersion } from "../../infra/package-json.js";
import { inspectSelfAndAncestorPidsSync } from "../../infra/restart-stale-pids.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { listActivePnpmIsolatedGlobalPackages } from "../../infra/update-global.js";
import { inspectUpdateRunDriver, type UpdateRunDriver } from "../../infra/update-run-driver.js";
import { getUpdateRun, listUpdateRuns } from "../../infra/update-run-ledger.js";
import { listUpdateRunsAsync } from "../../infra/update-run-reader.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { formatCliCommand } from "../command-format.js";
import {
  GatewayServiceUpdateOwnershipError,
  inspectManagedGatewayServiceBeforeUpdate,
  readGatewayServiceStateForUpdate,
} from "./update-command-service-plan.js";

/*
 * Shipped updaters 2026.11.4 through 2026.11.6 leave a pnpm-installed Gateway stopped after a
 * same-schema hop: they revalidate the unchanged service definition against the global entry
 * pnpm has just repointed into a new versioned store directory, refuse the restart and end
 * `service-revalidation-failed`. They run this package's Doctor after the swap, with service
 * repair and activation disallowed, and never hand it the restart. Nothing in this package can
 * restart the Gateway then, so Doctor (during the update) and the status readers (after it) name
 * the verified recovery instead.
 *
 * The same updaters also publish a launcher that still names their removed update stage, which
 * this package's Doctor repairs. A fixed updater relocates the launcher itself, so a repaired
 * staged launcher is the marker that tells a shipped driver from a fixed one; the driver's
 * version cannot, because fixed and unfixed builds share version lines.
 */

// Verified in this state: `gateway restart` alone fails while the unit names the old package.
// Both commands carry the profile and container the reader runs under.
function recoveryCommands(env: NodeJS.ProcessEnv) {
  return [
    formatCliCommand("openclaw gateway install --force", env),
    formatCliCommand("openclaw gateway restart", env),
  ] as const;
}

export function formatRefusedRestartRecovery(env: NodeJS.ProcessEnv = process.env): string {
  const [install, restart] = recoveryCommands(env);
  return `Run \`${install}\`, then \`${restart}\`.`;
}

// Doctor reports this during the update, before the updater decides; it promises nothing more.
export function formatRefusedRestartNotice(env: NodeJS.ProcessEnv = process.env): string {
  const [install, restart] = recoveryCommands(env);
  return `If this updater leaves the Gateway stopped, run \`${install}\` and then \`${restart}\`.`;
}

type ServiceFacts = { packageRoot?: string; owned: boolean; writable: boolean; running: boolean };
type InspectService = (root: string) => Promise<ServiceFacts | undefined>;

/**
 * The pnpm home a package directory belongs to, whichever store holds it: the global
 * virtual store (`<home>/store/v<N>/links/@/openclaw/<version>/<hash>/node_modules/openclaw`),
 * a project's own store for tarball installs
 * (`<home>/global/v<N>/<project>/node_modules/.pnpm/openclaw@<spec>/node_modules/openclaw`), or
 * pnpm 11.28's group store (`<home>/global/v<N>/<group>/.pnpm/openclaw@<version>_…/…/openclaw`).
 */
function parsePnpmPackageHome(root: string) {
  const match = /^(.+)[/\\](?:store|global)[/\\](v\d+)[/\\].+[/\\]node_modules[/\\]openclaw$/u.exec(
    root,
  );
  return match ? { home: match[1]!, layout: match[2]! } : undefined;
}

/** The service still names another version's package in the running package's pnpm home. */
async function inspectPnpmSwitch(
  root: string,
  inspectService: InspectService,
): Promise<{ skip: string } | { service: ServiceFacts; from: string; to: string }> {
  const realRoot = await fs.realpath(root).catch(() => undefined);
  const running = realRoot ? parsePnpmPackageHome(realRoot) : undefined;
  const version = realRoot ? await readPackageVersion(realRoot) : null;
  if (!realRoot || !running || !version) {
    return { skip: `the running package ${realRoot ?? root} is not in a pnpm home` };
  }
  const service = await inspectService(realRoot);
  const previous = service?.packageRoot ? parsePnpmPackageHome(service.packageRoot) : undefined;
  // A pruned previous entry has no manifest to prove what it was; those readers stay silent.
  const previousVersion =
    service?.packageRoot && (await readPackageName(service.packageRoot)) === "openclaw"
      ? await readPackageVersion(service.packageRoot)
      : null;
  if (
    !service?.packageRoot ||
    !previous ||
    previous.home !== running.home ||
    previous.layout !== running.layout ||
    service.packageRoot === realRoot ||
    !previousVersion ||
    previousVersion === version
  ) {
    return {
      skip: `the service runs ${service?.packageRoot ?? "no readable package"}, not another version in ${running.home}`,
    };
  }
  // Another global project in the same home can still own that version; only a package no
  // active project resolves to is this installation's previous generation.
  const active = await listActivePnpmIsolatedGlobalPackages({
    globalRoot: path.join(running.home, "global", running.layout),
  });
  for (const { packageRoot } of active) {
    if ((await fs.realpath(packageRoot).catch(() => undefined)) === service.packageRoot) {
      return { skip: `another pnpm global project still uses ${service.packageRoot}` };
    }
  }
  return { service, from: previousVersion, to: version };
}

/**
 * The one decision every reader shares: on macOS or Linux, the service this pnpm installation
 * owns and may rewrite still names another version's package in the same pnpm home (possibly
 * pruned). Only then is reinstalling the definition from this package the verified recovery.
 */
async function inspectRefusedRestartService(
  root: string,
  inspectService: InspectService,
): Promise<{ skip: string } | { service: ServiceFacts; from: string; to: string }> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    return { skip: `the recovery is not verified on ${process.platform}` };
  }
  const pnpm = await inspectPnpmSwitch(root, inspectService);
  if ("skip" in pnpm) {
    return pnpm;
  }
  return !pnpm.service.owned
    ? { skip: `the service at ${pnpm.service.packageRoot} is not owned by this installation` }
    : !pnpm.service.writable
      ? { skip: "the service definition is not writable" }
      : pnpm;
}

/**
 * Holds only for this package's Doctor run by a shipped updater that disallows service repair:
 * one running update run whose live driver is this process's ancestor, a pnpm install, and a
 * service this installation owns and may rewrite that still names its previous store entry.
 */
export async function inspectShippedRestartGate(params: {
  root: string;
  env: NodeJS.ProcessEnv;
  isDriverAncestor: (driver: UpdateRunDriver) => boolean;
  inspectService: InspectService;
}): Promise<{ runId: string } | { skip: string } | undefined> {
  const { env } = params;
  if (
    !isTruthyEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS) ||
    env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR !== "0" ||
    env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION !== "0"
  ) {
    return undefined;
  }
  // Shipped drivers pass the run id to the post-plugin Doctor only. The package-step Doctor
  // is identified by descending from the recorded live driver; the CLI entry can respawn
  // itself, so the driver is an ancestor and not necessarily the parent.
  const runId = env[UPDATE_RUN_ID_ENV]?.trim();
  const options = { env };
  const candidates = runId
    ? [getUpdateRun(runId, options)]
    : listUpdateRuns({ active: true, limit: 10 }, options);
  const runs = candidates.filter((run) => {
    const driver = run?.origin.driver;
    return (
      run?.status === "running" &&
      driver &&
      inspectUpdateRunDriver(driver) === "alive" &&
      (runId || params.isDriverAncestor(driver))
    );
  });
  const run = runs.length === 1 ? runs[0] : undefined;
  if (!run) {
    return {
      skip: `${runs.length} running update runs with a live driver ${runId ? `match ${runId}` : "above this Doctor"} (${candidates.length} candidates)`,
    };
  }
  const service = await inspectRefusedRestartService(params.root, params.inspectService);
  return "skip" in service ? service : { runId: run.runId };
}

/** The recorded driver is this process's live ancestor, by PID and start identity. */
function isLiveDriverAncestor(driver: UpdateRunDriver): boolean {
  const ancestry = inspectSelfAndAncestorPidsSync(undefined, {
    requireVerifiedParent: true,
    throughPid: driver.pid,
  });
  return ancestry.pids.has(driver.pid) && inspectUpdateRunDriver(driver) === "alive";
}

// The service is read as the user's own CLI would, without the updater's continuation markers.
// Service selectors (OPENCLAW_SYSTEMD_UNIT, OPENCLAW_LAUNCHD_LABEL, the profile) stay, so the
// inspected service is the one the named commands act on.
function withoutUpdaterMarkers(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !key.startsWith("OPENCLAW_UPDATE_") &&
        key !== "OPENCLAW_SERVICE_REPAIR_POLICY" &&
        key !== "OPENCLAW_COMPATIBILITY_HOST_VERSION" &&
        key !== "OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META",
    ),
  );
}

async function inspectGatewayServiceFacts(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<ServiceFacts | undefined> {
  const state = await readGatewayServiceStateForUpdate(
    resolveGatewayService(),
    withoutUpdaterMarkers(env),
  );
  if (!state.command) {
    return undefined;
  }
  const packageRoot = (await summarizeGatewayServiceLayout(state.command))?.packageRootReal;
  const verdict = await inspectManagedGatewayServiceBeforeUpdate({
    root,
    state,
    allowInstallRootChange: true,
  }).catch((error: unknown) => {
    // Install-owner, start-refusal and dueling-manager services are someone else's to repair.
    if (error instanceof GatewayServiceUpdateOwnershipError) {
      return undefined;
    }
    throw error;
  });
  if (!verdict) {
    return { packageRoot, owned: false, writable: false, running: state.running };
  }
  return {
    packageRoot,
    // A pruned previous entry is someone else's to prove: without the owner's verdict the
    // readers stay silent and the existing guidance stands.
    owned:
      verdict.kind === "owned" &&
      verdict.requiresInstallRootRefresh === true &&
      verdict.root === packageRoot,
    // An absent capability is writable to the existing owners as well (service-layout.ts).
    writable: (state.definitionMutationCapability?.kind ?? "writable") === "writable",
    running: state.running,
  };
}

/**
 * Doctor step after its launcher repair: the verified recovery, once, when a shipped updater
 * (the launcher it published still named its stage) is about to refuse this pnpm Gateway's
 * restart. Doctor returns it as an update warning, which shipped updaters render in their
 * final report and record for `openclaw update status`. Skips are silent.
 */
export async function resolveShippedRestartNotice(params: {
  root: string;
  /** Inspection errors only; the updater captures this Doctor's stderr. */
  diagnose: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  inspectService?: InspectService;
  isDriverAncestor?: (driver: UpdateRunDriver) => boolean;
}): Promise<string | undefined> {
  const env = params.env ?? process.env;
  try {
    const gate = await inspectShippedRestartGate({
      root: params.root,
      env,
      isDriverAncestor: params.isDriverAncestor ?? isLiveDriverAncestor,
      inspectService: params.inspectService ?? ((root) => inspectGatewayServiceFacts(root, env)),
    });
    return gate && !("skip" in gate)
      ? formatRefusedRestartNotice(withoutUpdaterMarkers(env))
      : undefined;
  } catch (error) {
    params.diagnose(`Gateway restart recovery note skipped: ${formatErrorMessage(error)}.`);
    return undefined;
  }
}

/**
 * After the update: a `service-revalidation-failed` run whose service is still in the refused
 * state above has the verified recovery. The stored run alone cannot tell this from a genuinely
 * foreign service; the live service read decides.
 */
export async function resolveRefusedRestartRecovery(params: {
  run: Pick<UpdateRunRecord, "status" | "reason" | "before" | "after">;
  activeRoot: string | null | undefined;
  env?: NodeJS.ProcessEnv;
  inspectService?: InspectService;
}): Promise<string | undefined> {
  const { run, activeRoot } = params;
  if (run.status !== "failed" || run.reason !== "service-revalidation-failed" || !activeRoot) {
    return undefined;
  }
  const env = params.env ?? process.env;
  const service = await inspectRefusedRestartService(
    activeRoot,
    params.inspectService ?? ((root) => inspectGatewayServiceFacts(root, env)),
  );
  // Only this run's own switch: it moved the install from the version the stopped service
  // still runs to the active one. A Gateway someone has since brought back needs nothing.
  return "skip" in service ||
    service.service.running ||
    run.before.version !== service.from ||
    run.after.version !== service.to
    ? undefined
    : formatRefusedRestartRecovery(env);
}

/** The same decision for the latest recorded update run, for readers without a run at hand. */
export async function readRefusedRestartRecovery(params: {
  activeRoot: string | null | undefined;
  /** The state the ledger lives in; the service is read as the caller selected it. */
  stateEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  inspectService?: InspectService;
}): Promise<string | undefined> {
  const { stateEnv, ...service } = params;
  const [run] = await listUpdateRunsAsync({ limit: 1 }, stateEnv ? { env: stateEnv } : {});
  return run ? resolveRefusedRestartRecovery({ run, ...service }) : undefined;
}
