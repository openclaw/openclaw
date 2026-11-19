import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGatewayPort } from "../../config/paths.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { summarizeGatewayServiceLayout } from "../../daemon/service-layout.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { acquireFileLock } from "../../infra/file-lock.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import { readPackageName, readPackageVersion } from "../../infra/package-json.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { listActivePnpmIsolatedGlobalPackages } from "../../infra/update-global.js";
import { resolveSystemdScopeLauncher } from "../../infra/update-managed-service-handoff-launcher.js";
import {
  inspectUpdateRunDriver,
  readUpdateRunDriver,
  sameUpdateRunDriver,
  type UpdateRunDriver,
} from "../../infra/update-run-driver.js";
import {
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunDiagnostic,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { SHIPPED_RESTART_FINISHER_STEP } from "../../infra/update-run-restart-finished.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import { runCommandWithTimeout } from "../../process/exec-runner.js";
import { sleep } from "../../utils/sleep.js";
import {
  confirmGatewayReachable,
  resolveGatewayRestartProbeContext,
  waitForGatewayHttpReadiness,
} from "../daemon-cli/restart-health-probe.js";
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
 * it the restart when the schema is unchanged. That Doctor leaves one detached finisher which,
 * after the updater exits, refreshes the definition and starts the Gateway through the ordinary
 * `gateway install --force` and `gateway start` owners. Remove this module once no supported
 * upgrade path starts from such an updater.
 *
 * The driver's version cannot tell a fixed 2026.11.6 or 2026.11.10 build from an unfixed one, so
 * the gate does not use it. Under a fixed driver the gate can still hold; the finisher then only
 * polls the run until it leaves `running` with another outcome and exits without acting.
 */
// The shipped driver's remaining work after Doctor (plugin convergence, post-plugin Doctor,
// revalidation and its recovery attempt) runs under per-step timeouts; two of them bound it.
const DRIVER_EXIT_WAIT_MS = 2 * DEFAULT_UPDATE_STEP_TIMEOUT_MS;
// `gateway start` waits for readiness itself; this bounds each command on slow hosts.
const SERVICE_COMMAND_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 2_000;
// A finished run accepts only diagnostics; a `warning:` row is shown in that run's report,
// and with the verification below it lets readers present the update as completed.
const RECOVERY_STEP = SHIPPED_RESTART_FINISHER_STEP;
const FINISHER_COMMAND = "finish-gateway-restart";
export const FINISHER_NOTICE =
  "If this updater leaves the Gateway stopped, OpenClaw will try to restart it after the updater exits.";
// Verified in the failed state: `gateway restart` alone exits 78 on the old definition.
const RECOVERY_HINT =
  "The Gateway is still stopped; run `openclaw gateway install --force`, then `openclaw gateway restart`, or ask this instance's agent with `openclaw triage`.";

type ServiceFacts = { packageRoot?: string; owned: boolean; writable: boolean; running: boolean };

export type FinisherDeps = {
  /** Ledger and child environment: the Doctor's, without the updater's markers. */
  env: NodeJS.ProcessEnv;
  inspectService: (root: string) => Promise<ServiceFacts | undefined>;
  probeGateway: () => Promise<{ version?: string; ready: boolean; port?: number } | undefined>;
  runCli: (args: string[]) => Promise<{ code: number | null; output: string }>;
  withServiceLock: <T>(operation: () => Promise<T>) => Promise<T>;
  lockDir: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

/** `<home>/store/v<N>/links/@/openclaw/<version>/<hash>/node_modules/openclaw`, pnpm 11+. */
function parsePnpmStoreEntry(root: string) {
  const match =
    /^(.+)[/\\]store[/\\](v\d+)[/\\]links[/\\]@[/\\]openclaw[/\\]([^/\\]+)[/\\][^/\\]+[/\\]node_modules[/\\]openclaw$/u.exec(
      root,
    );
  return match ? { home: match[1]!, layout: match[2]!, version: match[3]! } : undefined;
}

/**
 * The running package is the active pnpm global entry, and the service still names this same
 * pnpm home's entry for an earlier version. Anything else is not this compatibility case.
 */
async function inspectPnpmSwitch(root: string, deps: Pick<FinisherDeps, "inspectService">) {
  const realRoot = await fs.realpath(root).catch(() => undefined);
  const running = realRoot ? parsePnpmStoreEntry(realRoot) : undefined;
  if (!realRoot || !running || (await readPackageVersion(realRoot)) !== running.version) {
    return undefined;
  }
  const active = await listActivePnpmIsolatedGlobalPackages({
    globalRoot: path.join(running.home, "global", running.layout),
  });
  const activeReal = await Promise.all(
    active.map((entry) => fs.realpath(entry.packageRoot).catch(() => undefined)),
  );
  if (!activeReal.includes(realRoot)) {
    return undefined;
  }
  const service = await deps.inspectService(realRoot);
  const previous = service?.packageRoot ? parsePnpmStoreEntry(service.packageRoot) : undefined;
  if (
    !service?.packageRoot ||
    !previous ||
    previous.home !== running.home ||
    previous.layout !== running.layout ||
    previous.version === running.version ||
    (await readPackageName(service.packageRoot)) !== "openclaw"
  ) {
    return undefined;
  }
  return { service, version: running.version };
}

/** The Doctor gate: true only for this package's Doctor run by a shipped, unfixed updater. */
export async function inspectShippedRestartGate(params: {
  root: string;
  env: NodeJS.ProcessEnv;
  parent?: UpdateRunDriver;
  inspectService: FinisherDeps["inspectService"];
}): Promise<{ runId: string } | undefined> {
  const { env } = params;
  if (
    (process.platform !== "linux" && process.platform !== "darwin") ||
    !isTruthyEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS) ||
    env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR !== "0" ||
    env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION !== "0"
  ) {
    return undefined;
  }
  // Shipped drivers pass the run id to the post-plugin Doctor only; the package-step
  // Doctor is identified by being the recorded driver's own child.
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
      (runId || (params.parent && sameUpdateRunDriver(driver, params.parent)))
    );
  });
  const run = runs.length === 1 ? runs[0] : undefined;
  if (!run) {
    return undefined;
  }
  const pnpm = await inspectPnpmSwitch(params.root, params);
  return pnpm?.service.owned && pnpm.service.writable ? { runId: run.runId } : undefined;
}

type FinisherOutcome = "duplicate" | "not-needed" | "yielded" | "restarted" | "gave-up";

/** Waits for the shipped driver to exit, then finishes the restart it refused. */
export async function runShippedRestartFinisher(params: {
  runId: string;
  root: string;
  deps: FinisherDeps;
  onReady?: (ready: boolean) => void;
}): Promise<FinisherOutcome> {
  const { runId, deps } = params;
  const options = { env: deps.env };
  let lock: Awaited<ReturnType<typeof acquireFileLock>>;
  // One finisher per run, without blocking anyone else. The existing owners are exclusive per
  // installation or service, so holding one through the wait would refuse the very `openclaw
  // update` or `gateway restart` this finisher must yield to: the update executor and the
  // managed-handoff lease refuse a new update while held (and the lease has no row kind for
  // this), and the service operation lock serializes every Gateway command and is
  // taken only around the recheck below. A file lock keyed by run id excludes only a twin
  // finisher, and is reclaimed only after its holder is definitely dead.
  try {
    await fs.mkdir(deps.lockDir, { recursive: true, mode: 0o700 });
    lock = await acquireFileLock(path.join(deps.lockDir, `gateway-finisher-${sha256Hex(runId)}`), {
      retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
      stale: DRIVER_EXIT_WAIT_MS + 2 * SERVICE_COMMAND_TIMEOUT_MS,
      staleRecovery: "remove-if-definitely-stale",
    });
  } catch {
    params.onReady?.(false);
    return "duplicate";
  }
  params.onReady?.(true);
  const giveUp = (reason: string): FinisherOutcome => {
    recordUpdateRunDiagnostic(
      runId,
      `Automatic Gateway restart after the installed updater exited stopped: ${reason}. ${RECOVERY_HINT}`,
      options,
      RECOVERY_STEP,
    );
    return "gave-up";
  };
  try {
    const deadline = deps.now() + DRIVER_EXIT_WAIT_MS;
    let run = getUpdateRun(runId, options);
    while (
      run &&
      (run.status === "running" ||
        (run.origin.driver && inspectUpdateRunDriver(run.origin.driver) === "alive"))
    ) {
      if (deps.now() >= deadline) {
        return giveUp(
          `the installed updater was still running after ${DRIVER_EXIT_WAIT_MS / 60_000} minutes`,
        );
      }
      await deps.sleep(POLL_MS);
      run = getUpdateRun(runId, options);
    }
    if (run?.status !== "failed" || run.reason !== "service-revalidation-failed") {
      return "not-needed";
    }
    // Under the service lock a user's install or restart finishes first; its result decides.
    const decision = await deps.withServiceLock(async () => {
      const createdAtMs = run?.createdAtMs ?? 0;
      // This run is among those created at or after it; any other one is a newer update.
      const sinceThisRun = listUpdateRuns({ limit: 5 }, options).filter(
        (other) => other.createdAtMs >= createdAtMs,
      );
      if (sinceThisRun.length > 1) {
        return "yielded" as const;
      }
      if (run?.verification.recovery?.serviceRestartSafe === false) {
        return `the update recorded data at risk (${run.verification.recovery.dataAtRisk})`;
      }
      const pnpm = await inspectPnpmSwitch(params.root, deps);
      if (!pnpm || pnpm.service.running || (await deps.probeGateway())) {
        return "yielded" as const;
      }
      if (!pnpm.service.owned || !pnpm.service.writable) {
        return "the service definition is not writable by this installation";
      }
      return { version: pnpm.version };
    });
    if (decision === "yielded") {
      return "yielded";
    }
    if (typeof decision === "string") {
      return giveUp(decision);
    }
    for (const args of [
      ["gateway", "install", "--force", "--json"],
      ["gateway", "start", "--json"],
    ]) {
      const result = await deps.runCli(args);
      if (result.code !== 0) {
        return giveUp(
          `\`openclaw ${args.slice(0, -1).join(" ")}\` exited ${result.code ?? "by signal"}: ${result.output.trim().slice(-400) || "no output"}`,
        );
      }
    }
    const serving = await deps.probeGateway();
    if (serving?.version !== decision.version || !serving.ready) {
      return giveUp(
        `the Gateway did not report ready on ${decision.version} (observed ${serving?.version ?? "no Gateway"})`,
      );
    }
    recordUpdateRunVerification(
      runId,
      {
        serviceRunning: true,
        runningVersion: serving.version,
        versionMatch: true,
        readyz: true,
        settled: true,
        // `update status` probes this port to show current health beside the record.
        ...(serving.port ? { port: serving.port } : {}),
      },
      options,
    );
    recordUpdateRunDiagnostic(
      runId,
      `The installed updater refused the Gateway restart; after it exited, the service definition was refreshed and OpenClaw ${serving.version} is serving.`,
      options,
      RECOVERY_STEP,
    );
    return "restarted";
  } catch (error) {
    return giveUp(formatErrorMessage(error));
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
  const verdict = await inspectManagedGatewayServiceBeforeUpdate({
    root,
    state,
    allowInstallRootChange: true,
  });
  return {
    packageRoot: layout?.packageRootReal,
    owned:
      verdict.kind === "owned" &&
      verdict.requiresInstallRootRefresh === true &&
      verdict.root === layout?.packageRootReal,
    writable: (state.definitionMutationCapability?.kind ?? "writable") === "writable",
    running: state.running,
  };
}

/** Doctor step: leave the finisher only when the gate holds, and say so only when it is left. */
export async function maybeLeaveShippedRestartFinisher(params: {
  root: string | null;
  log: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  spawnFinisher?: (root: string, runId: string) => Promise<boolean>;
  inspectService?: FinisherDeps["inspectService"];
}): Promise<void> {
  const env = params.env ?? process.env;
  if (!params.root || !isTruthyEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS)) {
    return;
  }
  try {
    const gate = await inspectShippedRestartGate({
      root: params.root,
      env,
      parent: readUpdateRunDriver(process.ppid),
      inspectService:
        params.inspectService ?? ((root) => inspectGatewayServiceFacts(root, stripUpdaterEnv(env))),
    });
    if (gate && (await (params.spawnFinisher ?? spawnFinisher)(params.root, gate.runId))) {
      params.log(FINISHER_NOTICE);
    }
  } catch {
    // Any doubt leaves the shipped updater's outcome and recovery guidance unchanged.
  }
}

/** Detached from the Doctor's process group so the updater's custody checks never see it. */
async function spawnFinisher(root: string, runId: string): Promise<boolean> {
  const entry = await resolveGatewayInstallEntrypoint(root);
  if (!entry) {
    return false;
  }
  const env = stripUpdaterEnv(process.env);
  const args = [entry, "update", FINISHER_COMMAND, "--run-id", runId];
  // A Gateway-initiated update runs this Doctor inside the shipped helper's transient
  // `openclaw-update-*.service`, whose KillMode=control-group would kill the finisher with it.
  const launcher =
    process.platform === "linux"
      ? (() => {
          try {
            return resolveSystemdScopeLauncher({
              serviceEnv: env,
              unit: `openclaw-update-restart-${runId.replace(/[^A-Za-z0-9_.:@-]+/gu, "-")}.scope`,
              executable: process.execPath,
              args,
            });
          } catch {
            return undefined;
          }
        })()
      : undefined;
  const child = spawn(launcher?.command ?? process.execPath, launcher?.args ?? args, {
    cwd: os.homedir(),
    env,
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 60_000);
    child.once("message", (message) => {
      clearTimeout(timer);
      resolve(isRecord(message) && message.ready === true);
    });
    child.once("error", () => resolve(false));
    child.once("exit", () => resolve(false));
  });
  if (!ready && child.exitCode === null) {
    child.kill("SIGTERM");
  }
  if (child.connected) {
    child.disconnect();
  }
  child.unref();
  return ready;
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
  const probeContext = async () => {
    const context = await resolveGatewayRestartProbeContext(env);
    return { context, port: resolveGatewayPort(context.config, env) };
  };
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
      probeGateway: async () => {
        const { context, port } = await probeContext();
        const gateway = await confirmGatewayReachable({ port, ...context, env });
        if (!gateway.reachable) {
          return undefined;
        }
        const http = await waitForGatewayHttpReadiness({
          requireChannelHealth: false,
          config: context.config,
          port,
          attempts: 1,
          deadlineAt: performance.now() + 3_000,
          delayMs: 0,
        });
        return {
          version: gateway.gatewayVersion ?? undefined,
          ready: http.coreReady ?? (http.healthz === 200 && http.readyz === 200),
          port,
        };
      },
      runCli: async (args) => {
        const result = await runCommandWithTimeout([process.execPath, entry, ...args], {
          env,
          timeoutMs: SERVICE_COMMAND_TIMEOUT_MS,
        });
        return { code: result.code, output: `${result.stdout}\n${result.stderr}` };
      },
      withServiceLock: (operation) => withGatewayServiceOperationLock(env, () => operation()),
      lockDir: resolvePreferredOpenClawTmpDir({ purpose: "coordination" }),
      now: Date.now,
      sleep,
    },
  });
}
