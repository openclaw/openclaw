import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import {
  resolveServiceEntrypoint,
  summarizeGatewayServiceLayout,
} from "../../daemon/service-layout.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { readArchiveEntry } from "../../infra/archive.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { acquireFileLock } from "../../infra/file-lock.js";
import { resolveOsHomeRelativePath } from "../../infra/home-dir.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import { readPackageName, readPackageVersion } from "../../infra/package-json.js";
import { pathEntryExists } from "../../infra/path-existence.js";
import { inspectSelfAndAncestorPidsSync } from "../../infra/restart-stale-pids.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import {
  canResolveRegistryVersionForPackageTarget,
  listActivePnpmIsolatedGlobalPackages,
  resolveExpectedInstalledVersionFromSpec,
} from "../../infra/update-global.js";
import { resolveSystemdScopeLauncher } from "../../infra/update-managed-service-handoff-launcher.js";
import { recordedUpdateRunDrivers } from "../../infra/update-run-activity.js";
import { inspectUpdateRunDriver, type UpdateRunDriver } from "../../infra/update-run-driver.js";
import { getUpdateRun, listUpdateRuns } from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import { runCommandWithTimeout } from "../../process/exec-runner.js";
import { sleep } from "../../utils/sleep.js";
import {
  inspectManagedGatewayServiceBeforeUpdate,
  readGatewayServiceStateForUpdate,
} from "./update-command-service-plan.js";

/*
 * Compatibility for shipped updaters that leave a pnpm-installed Gateway stopped. Updaters
 * through 2026.11.5, and 2026.11.6/2026.11.10 builds without the retained-root revalidation
 * fix, inspect the unchanged service definition against the global entry pnpm has just
 * repointed into a new versioned store directory, so the restart is refused and the run ends
 * `service-revalidation-failed`. They run this package's Doctor after the swap but never hand
 * it the restart when the schema is unchanged. That Doctor leaves one detached waiter. Once the
 * updater and any handoff helper are gone, it reruns `openclaw update` pinned to the installed
 * version: this package's fixed updater then refreshes the definition (keeping the service's
 * port and options), restarts and verifies the Gateway, and records its own run. The waiter
 * itself never writes a service or a run. Remove this module once no supported upgrade path
 * starts from such an updater.
 *
 * The driver's version cannot tell a fixed 2026.11.6 or 2026.11.10 build from an unfixed one, so
 * the gate does not use it. Under a fixed driver the waiter only polls the run until it ends
 * with another outcome, then exits.
 */
// The shipped driver's remaining work after Doctor (plugin convergence, post-plugin Doctor,
// revalidation and recovery, then the handoff helper's restore and triage) runs under per-step
// timeouts; two of them bound it. Past the bound the waiter exits without acting or writing.
const DRIVER_EXIT_WAIT_MS = 2 * DEFAULT_UPDATE_STEP_TIMEOUT_MS;
// A full package reinstall took about 4 minutes in test cells; allow slow hosts and registries.
const UPDATE_COMMAND_TIMEOUT_MS = 60 * 60_000;
const POLL_MS = 2_000;
const FINISHER_COMMAND = "finish-gateway-restart";
export const FINISHER_NOTICE =
  "If this updater leaves the Gateway stopped, OpenClaw will rerun `openclaw update` for the installed version after the updater exits.";
// Verified in the failed state: `gateway restart` alone exits 78 on the old definition.
export const MANUAL_RECOVERY_NOTICE =
  "If this updater leaves the Gateway stopped, run `openclaw gateway install --force`, then `openclaw gateway restart`, or ask this instance's agent with `openclaw triage`.";

type ServiceFacts = { packageRoot?: string; owned: boolean; writable: boolean; running: boolean };

export type FinisherDeps = {
  /** Ledger and child environment: the Doctor's, without the updater's markers. */
  env: NodeJS.ProcessEnv;
  inspectService: (root: string) => Promise<ServiceFacts | undefined>;
  runUpdate: (args: string[]) => Promise<void>;
  withServiceLock: <T>(operation: () => Promise<T>) => Promise<T>;
  lockDir: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

/**
 * The pnpm 11+ home a package directory belongs to, whichever store holds it: the global
 * virtual store (`<home>/store/v<N>/links/@/openclaw/<version>/<hash>/node_modules/openclaw`),
 * a project's own store for tarball installs
 * (`<home>/global/v<N>/<project>/node_modules/.pnpm/openclaw@<spec>/node_modules/openclaw`), or
 * pnpm 11.28's group store (`<home>/global/v<N>/<group>/.pnpm/openclaw@<version>_…/…/openclaw`).
 * The active-entry check below, not this shape, decides which package is current.
 */
function parsePnpmPackageHome(root: string) {
  const match = /^(.+)[/\\](?:store|global)[/\\](v\d+)[/\\].+[/\\]node_modules[/\\]openclaw$/u.exec(
    root,
  );
  return match ? { home: match[1]!, layout: match[2]! } : undefined;
}

/**
 * The running package is the active pnpm global entry, and the service still names another
 * version's package in this same pnpm home, which pnpm may already have pruned.
 */
async function inspectPnpmSwitch(
  root: string,
  deps: Pick<FinisherDeps, "inspectService">,
): Promise<{ skip: string } | { service: ServiceFacts; version: string }> {
  const realRoot = await fs.realpath(root).catch(() => undefined);
  const running = realRoot ? parsePnpmPackageHome(realRoot) : undefined;
  const version = realRoot ? await readPackageVersion(realRoot) : null;
  if (!realRoot || !running || !version) {
    return { skip: `the running package ${realRoot ?? root} is not in a pnpm 11+ home` };
  }
  const active = await listActivePnpmIsolatedGlobalPackages({
    globalRoot: path.join(running.home, "global", running.layout),
  });
  const activeReal = await Promise.all(
    active.map((entry) => fs.realpath(entry.packageRoot).catch(() => undefined)),
  );
  if (!activeReal.includes(realRoot)) {
    return { skip: `no active pnpm global entry resolves to ${realRoot}` };
  }
  const service = await deps.inspectService(realRoot);
  const previous = service?.packageRoot ? parsePnpmPackageHome(service.packageRoot) : undefined;
  // A pruned entry no longer has a manifest; its path still places it in this home.
  const present = service?.packageRoot ? await pathEntryExists(service.packageRoot) : false;
  if (
    !service?.packageRoot ||
    !previous ||
    previous.home !== running.home ||
    previous.layout !== running.layout ||
    service.packageRoot === realRoot ||
    (present &&
      ((await readPackageName(service.packageRoot)) !== "openclaw" ||
        (await readPackageVersion(service.packageRoot)) === version))
  ) {
    return {
      skip: `the service runs ${service?.packageRoot ?? "no readable package"}, not another version in ${running.home}`,
    };
  }
  return { service, version };
}

/** The Doctor gate: holds only for this package's Doctor run by a shipped updater. */
export async function inspectShippedRestartGate(params: {
  root: string;
  env: NodeJS.ProcessEnv;
  isDriverAncestor: (driver: UpdateRunDriver) => boolean;
  inspectService: FinisherDeps["inspectService"];
}): Promise<{ runId: string } | { skip: string } | undefined> {
  const { env } = params;
  if (
    (process.platform !== "linux" && process.platform !== "darwin") ||
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
  const pnpm = await inspectPnpmSwitch(params.root, params);
  if ("skip" in pnpm) {
    return pnpm;
  }
  return !pnpm.service.owned
    ? { skip: `the service at ${pnpm.service.packageRoot} is not owned by this installation` }
    : !pnpm.service.writable
      ? { skip: "the service definition is not writable" }
      : { runId: run.runId };
}

/** The recorded driver is this process's live ancestor, by PID and start identity. */
function isLiveDriverAncestor(driver: UpdateRunDriver): boolean {
  const ancestry = inspectSelfAndAncestorPidsSync(undefined, {
    requireVerifiedParent: true,
    throughPid: driver.pid,
  });
  return ancestry.pids.has(driver.pid) && inspectUpdateRunDriver(driver) === "alive";
}

/**
 * Repeat the source the user updated from when it is pinned to the installed version: an exact
 * version, or a local tarball (absolute or `~/`) whose manifest names that version. A dist-tag,
 * range, URL, Git ref or relative path can resolve elsewhere, so it falls back to the version.
 */
export async function resolveHandOffTag(
  recorded: string | undefined,
  installedVersion: string,
): Promise<string> {
  const tag = recorded?.trim();
  if (!tag) {
    return installedVersion;
  }
  if (canResolveRegistryVersionForPackageTarget(tag)) {
    const exact = resolveExpectedInstalledVersionFromSpec(
      "openclaw",
      tag.startsWith("openclaw@") ? tag : `openclaw@${tag}`,
    );
    return exact === installedVersion ? tag : installedVersion;
  }
  const file = tag.replace(/^file:/u, "");
  if (!/\.(?:tgz|tar\.gz)$/iu.test(file) || !(path.isAbsolute(file) || file.startsWith("~/"))) {
    return installedVersion;
  }
  const manifest = await readArchiveEntry(resolveOsHomeRelativePath(file), "package/package.json", {
    maxBytes: 1024 * 1024,
  })
    .then((bytes): unknown => JSON.parse(bytes.toString("utf8")))
    .catch(() => undefined);
  return isRecord(manifest) && manifest.name === "openclaw" && manifest.version === installedVersion
    ? tag
    : installedVersion;
}

/** Until each is provably gone, a driver or handoff helper may still restore or triage. */
function updateProcessesMayRun(run: UpdateRunRecord): boolean {
  const helper = run.origin.managedHandoff?.helper;
  return [...recordedUpdateRunDrivers(run), ...(helper ? [helper] : [])].some(
    (driver) => inspectUpdateRunDriver(driver) !== "dead",
  );
}

type FinisherOutcome = "duplicate" | "timed-out" | "not-needed" | "yielded" | "handed-off";

/** Waits for the shipped updater to exit, then hands the refused restart to `openclaw update`. */
export async function runShippedRestartFinisher(params: {
  runId: string;
  root: string;
  deps: FinisherDeps;
  onReady?: (ready: boolean) => void;
}): Promise<FinisherOutcome> {
  const { runId, deps } = params;
  const options = { env: deps.env };
  let lock: Awaited<ReturnType<typeof acquireFileLock>>;
  // One waiter per run, without blocking anyone else. The existing owners are exclusive per
  // installation or service, so holding one through the wait would refuse the very `openclaw
  // update` or `gateway restart` this waiter must yield to: the update executor and the
  // managed-handoff lease refuse a new update while held (and the lease has no row kind for
  // this), and the service operation lock serializes every Gateway command and is taken only
  // around the recheck below. A file lock keyed by run id excludes only a twin waiter, and is
  // reclaimed only after its holder is definitely dead.
  try {
    await fs.mkdir(deps.lockDir, { recursive: true, mode: 0o700 });
    lock = await acquireFileLock(path.join(deps.lockDir, `gateway-finisher-${sha256Hex(runId)}`), {
      retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
      stale: DRIVER_EXIT_WAIT_MS + UPDATE_COMMAND_TIMEOUT_MS,
      staleRecovery: "remove-if-definitely-stale",
    });
  } catch {
    params.onReady?.(false);
    return "duplicate";
  }
  params.onReady?.(true);
  try {
    const deadline = deps.now() + DRIVER_EXIT_WAIT_MS;
    let run = getUpdateRun(runId, options);
    while (run && (run.status === "running" || updateProcessesMayRun(run))) {
      if (deps.now() >= deadline) {
        // The run may still succeed; leave its record to its own updater.
        return "timed-out";
      }
      await deps.sleep(POLL_MS);
      run = getUpdateRun(runId, options);
    }
    // A data-at-risk mark keeps the updater's own recovery guidance; never restart over it.
    if (
      run?.status !== "failed" ||
      run.reason !== "service-revalidation-failed" ||
      run.verification.recovery?.serviceRestartSafe === false
    ) {
      return "not-needed";
    }
    const createdAtMs = run.createdAtMs;
    // Under the service lock a user's install or restart finishes first; its result decides.
    // A lock that cannot be taken, or is borrowed by a handoff, means someone else is acting.
    const version = await deps
      .withServiceLock(async () => {
        const later = listUpdateRuns({ limit: 5 }, options).filter(
          (other) => other.createdAtMs >= createdAtMs,
        );
        // Includes this run: a second row is a newer update, and an active row is one in flight.
        if (later.length > 1 || listUpdateRuns({ active: true, limit: 1 }, options).length) {
          return undefined;
        }
        // A helper that restored the old definition and started it left a working Gateway.
        const pnpm = await inspectPnpmSwitch(params.root, deps);
        return !("skip" in pnpm) &&
          !pnpm.service.running &&
          pnpm.service.owned &&
          pnpm.service.writable
          ? pnpm.version
          : undefined;
      })
      .catch(() => undefined);
    if (!version) {
      return "yielded";
    }
    // From here the update owns admission: it refuses a concurrent update and revalidates the
    // service itself, so the short gap after the lock release cannot double-apply anything.
    await deps.runUpdate([
      "update",
      "--tag",
      await resolveHandOffTag(run.target.tag, version),
      "--yes",
      "--json",
    ]);
    return "handed-off";
  } finally {
    await lock.release();
  }
}

function stripUpdaterEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
  const state = await readGatewayServiceStateForUpdate(resolveGatewayService(), env);
  if (!state.command) {
    return undefined;
  }
  const layout = await summarizeGatewayServiceLayout(state.command);
  // pnpm can prune the previous entry; its path still names it in the unit's command.
  const entrypoint = resolveServiceEntrypoint(state.command);
  const marker = `${path.sep}node_modules${path.sep}openclaw${path.sep}`;
  const lexicalRoot = entrypoint?.includes(marker)
    ? entrypoint.slice(0, entrypoint.lastIndexOf(marker) + marker.length - 1)
    : undefined;
  const packageRoot = layout?.packageRootReal ?? lexicalRoot;
  const verdict = await inspectManagedGatewayServiceBeforeUpdate({
    root,
    state,
    allowInstallRootChange: true,
  });
  return {
    packageRoot,
    owned:
      (verdict.kind === "owned" &&
        verdict.requiresInstallRootRefresh === true &&
        verdict.root === packageRoot) ||
      // The fixed updater proves a pruned entry against this global root itself.
      (packageRoot !== undefined && !(await pathEntryExists(packageRoot))),
    // An absent capability is writable to the existing owners as well (service-layout.ts).
    writable: (state.definitionMutationCapability?.kind ?? "writable") === "writable",
    running: state.running,
  };
}

/** Doctor step: leave the waiter only when the gate holds, and say what will happen. */
export async function maybeLeaveShippedRestartFinisher(params: {
  root: string | null;
  log: (message: string) => void;
  /** Update-time diagnostics only: the updater captures this Doctor's stderr. */
  diagnose: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  spawnFinisher?: (
    root: string,
    runId: string,
    diagnose: (message: string) => void,
  ) => Promise<SpawnOutcome>;
  inspectService?: FinisherDeps["inspectService"];
  isDriverAncestor?: (driver: UpdateRunDriver) => boolean;
}): Promise<void> {
  const env = params.env ?? process.env;
  if (!params.root || !isTruthyEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS)) {
    return;
  }
  const diagnose = (message: string) => params.diagnose(`Gateway restart handoff: ${message}.`);
  let gate: Awaited<ReturnType<typeof inspectShippedRestartGate>>;
  try {
    gate = await inspectShippedRestartGate({
      root: params.root,
      env,
      isDriverAncestor: params.isDriverAncestor ?? isLiveDriverAncestor,
      inspectService:
        params.inspectService ?? ((root) => inspectGatewayServiceFacts(root, stripUpdaterEnv(env))),
    });
  } catch (error) {
    // Any doubt leaves the shipped updater's outcome and recovery guidance unchanged.
    diagnose(`skipped: ${formatErrorMessage(error)}`);
    return;
  }
  if (!gate) {
    return;
  }
  if ("skip" in gate) {
    diagnose(`skipped: ${gate.skip}`);
    return;
  }
  const outcome = await (params.spawnFinisher ?? spawnFinisher)(
    params.root,
    gate.runId,
    diagnose,
  ).catch((error: unknown) => {
    diagnose(`the waiter could not start: ${formatErrorMessage(error)}`);
    return "failed" as const;
  });
  if (outcome !== "duplicate") {
    params.log(outcome === "ready" ? FINISHER_NOTICE : MANUAL_RECOVERY_NOTICE);
  }
}

type SpawnOutcome = "ready" | "duplicate" | "failed";

async function spawnOnce(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, {
    cwd: os.homedir(),
    env,
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let timer: NodeJS.Timeout | undefined;
  const outcome = await new Promise<SpawnOutcome | "exited">((resolve) => {
    timer = setTimeout(() => resolve("failed"), 60_000);
    child.once("message", (message) =>
      resolve(isRecord(message) && message.ready === true ? "ready" : "duplicate"),
    );
    child.once("error", () => resolve("exited"));
    child.once("exit", () => resolve("exited"));
  });
  clearTimeout(timer);
  if (outcome !== "ready" && child.exitCode === null) {
    child.kill("SIGTERM");
  }
  if (child.connected) {
    child.disconnect();
  }
  child.unref();
  return outcome;
}

/** Detached from the Doctor's process group so the updater's custody checks never see it. */
async function spawnFinisher(
  root: string,
  runId: string,
  diagnose: (message: string) => void,
): Promise<SpawnOutcome> {
  const entry = await resolveGatewayInstallEntrypoint(root);
  if (!entry) {
    diagnose(`the waiter could not start: no CLI entrypoint under ${root}`);
    return "failed";
  }
  const env = stripUpdaterEnv(process.env);
  const args = [entry, "update", FINISHER_COMMAND, "--run-id", runId];
  // A Gateway-initiated update runs this Doctor inside the shipped helper's transient
  // `openclaw-update-*.service`, whose KillMode=control-group would kill the waiter with it.
  let scoped: ReturnType<typeof resolveSystemdScopeLauncher> | undefined;
  try {
    scoped =
      process.platform === "linux"
        ? resolveSystemdScopeLauncher({
            serviceEnv: env,
            unit: `openclaw-update-restart-${runId.replace(/[^A-Za-z0-9_.:@-]+/gu, "-")}.scope`,
            executable: process.execPath,
            args,
          })
        : undefined;
  } catch {
    scoped = undefined;
  }
  const outcome = scoped ? await spawnOnce(scoped.command, scoped.args, env) : "exited";
  if (scoped && outcome !== "ready" && outcome !== "duplicate") {
    diagnose(
      `the scoped waiter ${outcome === "failed" ? "timed out" : "exited"} before it was ready; starting it without a scope`,
    );
  }
  // A scope the user manager refused exits before signalling; a plain detached waiter remains.
  const settled = outcome === "exited" ? await spawnOnce(process.execPath, args, env) : outcome;
  if (settled !== "ready" && settled !== "duplicate") {
    diagnose(
      `the waiter could not start: it ${settled === "failed" ? "timed out" : "exited"} before it was ready`,
    );
  }
  return settled === "exited" ? "failed" : settled;
}

/** `openclaw update finish-gateway-restart` entry; only the Doctor above starts it. */
export async function finishShippedRestartCommand(runId: string): Promise<void> {
  const env = { ...process.env };
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
  });
  const entry = root ? await resolveGatewayInstallEntrypoint(root) : undefined;
  if (!root || !entry) {
    throw new Error("The OpenClaw package root for the Gateway restart could not be resolved.");
  }
  await runShippedRestartFinisher({
    runId,
    root,
    onReady: (ready) => {
      process.send?.({ ready });
      process.disconnect?.();
    },
    deps: {
      env,
      inspectService: (serviceRoot) => inspectGatewayServiceFacts(serviceRoot, env),
      runUpdate: async (args) => {
        // The update reports and records its own outcome; this waiter only starts it.
        await runCommandWithTimeout([process.execPath, entry, ...args], {
          env,
          timeoutMs: UPDATE_COMMAND_TIMEOUT_MS,
        });
      },
      withServiceLock: (operation) => withGatewayServiceOperationLock(env, () => operation()),
      lockDir: resolvePreferredOpenClawTmpDir({ purpose: "coordination" }),
      now: Date.now,
      sleep,
    },
  });
}
