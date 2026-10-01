// Gateway cron lazy loader.
// Defers scheduler startup until cron is touched by runtime or API handlers.
import type { CliDeps } from "../cli/deps.types.js";
import { DEFAULT_CRON_ENABLED } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { captureSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker-context.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { createLazyPromiseLoader, createLazyRuntimeMethodBinder } from "../shared/lazy-runtime.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";
import type { GatewayCronExitWatcherHandoff, GatewayCronState } from "./server-cron.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

type LazyGatewayCronParams = {
  cfg: OpenClawConfig;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  env?: NodeJS.ProcessEnv;
  scheduler: GatewayScheduler;
  /**
   * Resolves the live Gateway request context for scheduler-triggered runs.
   * RPC-triggered runs inherit one from the caller; timer-triggered runs have
   * no request of their own, so trusted built-in tools would otherwise see none.
   */
  resolveGatewayContext?: () => GatewayRequestContext | undefined;
};

type LoadedGatewayCronState = {
  state: GatewayCronState;
  phase: "idle" | "starting" | "started" | "stopped";
  startPromise: Promise<void> | null;
  startGeneration: number | null;
  schedulingPaused: boolean;
  underlyingStartAttempted: boolean;
};

/** Creates a cron state proxy that imports the real cron service on first use. */
export function createLazyGatewayCronState(params: LazyGatewayCronParams): GatewayCronState {
  const spawnBroker = getSpawnBroker();
  const runWithReadOnlyWorkers = captureSqliteReadOnlyWorkerScope();
  const env = params.env ?? process.env;
  const storePath = resolveCronJobsStorePathFromConfig(params.cfg, env);
  const cronEnabled =
    env.OPENCLAW_SKIP_CRON !== "1" && (params.cfg.cron?.enabled ?? DEFAULT_CRON_ENABLED);
  let loaded: LoadedGatewayCronState | null = null;
  let stopped = false;
  let exitWatcherHandoff: GatewayCronExitWatcherHandoff | undefined;
  let exitWatcherHandoffStop: Promise<void> | undefined;
  let lifecycleGeneration = 0;
  let schedulingPaused = false;
  const schedulingResumeWaiters = new Set<() => void>();
  const releaseSchedulingResumeWaiters = () => {
    const waiters = Array.from(schedulingResumeWaiters);
    schedulingResumeWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  };
  const waitForSchedulingResume = async () => {
    if (!schedulingPaused) {
      return;
    }
    await new Promise<void>((resolve) => {
      schedulingResumeWaiters.add(resolve);
    });
  };
  const cronStateLoader = createLazyPromiseLoader(
    () =>
      import("./server-cron.js").then(({ buildGatewayCronService }) => {
        loaded = {
          state: runWithSpawnBroker(spawnBroker, () =>
            runWithReadOnlyWorkers(() => buildGatewayCronService(params)),
          ),
          phase: "idle",
          startPromise: null,
          startGeneration: null,
          schedulingPaused: false,
          underlyingStartAttempted: false,
        };
        if (schedulingPaused) {
          loaded.state.cron.pauseScheduling();
          loaded.schedulingPaused = true;
        }
        return loaded;
      }),
    { cacheRejections: true },
  );

  const load = async (): Promise<LoadedGatewayCronState> => {
    if (loaded) {
      return loaded;
    }
    // Share the same import promise across concurrent API calls so only one
    // scheduler instance is built for a Gateway process.
    return await cronStateLoader.load();
  };
  const bindCron = createLazyRuntimeMethodBinder(load);

  const stopResolvedCron = async (resolved: LoadedGatewayCronState): Promise<void> => {
    resolved.phase = "stopped";
    resolved.underlyingStartAttempted = false;
    if (exitWatcherHandoff) {
      // A cancelled startup must join the exact prepared owner's drain, not
      // prepare or stop another owner after its watchers have been adopted.
      await (exitWatcherHandoffStop ??= exitWatcherHandoff.stopOwner());
    } else if (resolved.state.cron.stopAndDrain) {
      await resolved.state.cron.stopAndDrain();
    } else {
      resolved.state.cron.stop();
      await resolved.state.stopStreamWatchers();
    }
  };

  const stopLoadedCronAndDrain = async (handoff?: GatewayCronExitWatcherHandoff): Promise<void> => {
    stopped = true;
    exitWatcherHandoff ??= handoff;
    lifecycleGeneration += 1;
    releaseSchedulingResumeWaiters();
    const loading = cronStateLoader.peek();
    const resolved = loaded ?? (loading ? await loading : null);
    if (resolved) {
      await stopResolvedCron(resolved);
    }
  };

  const cron: GatewayCronServiceContract = {
    async start() {
      stopped = false;
      const generation = lifecycleGeneration;
      const startCancelled = () => stopped || generation !== lifecycleGeneration;
      const resolved = await load();
      const hasStarted = () => resolved.phase === "started";
      if (startCancelled()) {
        return;
      }
      if (hasStarted()) {
        return;
      }
      if (resolved.startPromise) {
        const pendingGeneration = resolved.startGeneration;
        try {
          await resolved.startPromise;
        } catch (err) {
          if (pendingGeneration === generation) {
            throw err;
          }
        }
        if (startCancelled() || hasStarted()) {
          return;
        }
        if (pendingGeneration !== generation) {
          await cron.start();
          return;
        }
      }
      resolved.phase = "starting";
      resolved.startGeneration = generation;
      const startPromise = (async () => {
        await waitForSchedulingResume();
        if (startCancelled()) {
          resolved.phase = "stopped";
          return;
        }
        if (resolved.schedulingPaused) {
          resolved.state.cron.resumeScheduling();
          resolved.schedulingPaused = false;
        }
        resolved.underlyingStartAttempted = true;
        try {
          await resolved.state.cron.start();
        } catch (err) {
          resolved.phase = startCancelled() ? "stopped" : "idle";
          throw err;
        }
        if (startCancelled()) {
          await stopResolvedCron(resolved);
          return;
        }
        if (schedulingPaused) {
          resolved.state.cron.pauseScheduling();
          resolved.schedulingPaused = true;
        }
        // Arm process watchers for jobs loaded from the store at startup (no
        // change event fires for already-persisted jobs).
        try {
          if (resolved.state.cronEnabled) {
            await Promise.all([
              resolved.state.reconcileExitWatchers(),
              resolved.state.reconcileStreamWatchers(),
            ]);
          }
        } catch (err) {
          resolved.phase = startCancelled() ? "stopped" : "started";
          throw err;
        }
        if (startCancelled()) {
          await stopResolvedCron(resolved);
          return;
        }
        resolved.phase = "started";
      })();
      resolved.startPromise = startPromise;
      try {
        await startPromise;
      } finally {
        if (resolved.startPromise === startPromise) {
          resolved.startPromise = null;
          resolved.startGeneration = null;
        }
      }
    },
    stop() {
      stopped = true;
      lifecycleGeneration += 1;
      releaseSchedulingResumeWaiters();
      if (loaded) {
        loaded.phase = "stopped";
        loaded.underlyingStartAttempted = false;
        loaded.state.cron.stop();
        return;
      }
      const loading = cronStateLoader.peek();
      if (loading) {
        // Stop may happen while the dynamic import is still in flight; attach a
        // cleanup continuation instead of forcing cron to load synchronously.
        void loading
          .then((resolved) => {
            if (!stopped) {
              return;
            }
            resolved.phase = "stopped";
            resolved.underlyingStartAttempted = false;
            resolved.state.cron.stop();
          })
          .catch(() => {});
      }
    },
    async stopAndDrain() {
      await stopLoadedCronAndDrain();
    },
    pauseScheduling() {
      schedulingPaused = true;
      if (loaded) {
        loaded.state.cron.pauseScheduling();
        loaded.schedulingPaused = true;
      }
    },
    resumeScheduling() {
      schedulingPaused = false;
      releaseSchedulingResumeWaiters();
      // A rejected catch-up can still leave live scheduling; the service owns readiness.
      if (loaded && loaded.schedulingPaused && loaded.underlyingStartAttempted) {
        loaded.state.cron.resumeScheduling();
        loaded.schedulingPaused = false;
      }
    },
    getSuspensionBlockerCount() {
      const loadedBlockers = loaded?.state.cron.getSuspensionBlockerCount?.() ?? 0;
      return loaded?.phase === "starting" ? Math.max(1, loadedBlockers) : loadedBlockers;
    },
    status: bindCron(({ state }) => state.cron.status.bind(state.cron)),
    list: bindCron(({ state }) => state.cron.list.bind(state.cron)),
    listPage: bindCron(({ state }) => state.cron.listPage.bind(state.cron)),
    add: bindCron(({ state }) => state.cron.add.bind(state.cron)),
    update: bindCron(({ state }) => state.cron.update.bind(state.cron)),
    updateWithPrecondition: bindCron(({ state }) =>
      state.cron.updateWithPrecondition.bind(state.cron),
    ),
    remove: bindCron(({ state }) => state.cron.remove.bind(state.cron)),
    removeStaleJobFamily: bindCron(({ state }) => state.cron.removeStaleJobFamily.bind(state.cron)),
    async removeAgentJobsTransactional(agentId, commit) {
      return await (await load()).state.cron.removeAgentJobsTransactional(agentId, commit);
    },
    quiesceJobs: bindCron(({ state }) => state.cron.quiesceJobs.bind(state.cron)),
    run: bindCron(({ state }) => state.cron.run.bind(state.cron)),
    enqueueRun: bindCron(({ state }) => state.cron.enqueueRun.bind(state.cron)),
    waitForManualRun: bindCron(({ state }) => state.cron.waitForManualRun.bind(state.cron)),
    getJob(id) {
      return loaded?.state.cron.getJob(id);
    },
    readJob: bindCron(({ state }) => state.cron.readJob.bind(state.cron)),
    async readScratch(id, options) {
      options?.assertCurrent?.();
      const current = await load();
      options?.assertCurrent?.();
      return await current.state.cron.readScratch(id, options);
    },
    writeScratch: bindCron(({ state }) => state.cron.writeScratch.bind(state.cron)),
    getDefaultAgentId() {
      return loaded?.state.cron.getDefaultAgentId();
    },
    async prepareWake() {
      await load();
    },
    wake(opts) {
      if (!loaded) {
        // A wake should kick off lazy loading but cannot claim success before
        // cron exists and knows whether the target job is wakeable.
        void load();
        return { ok: false };
      }
      return loaded.state.cron.wake(opts);
    },
  };

  return {
    cron,
    storePath,
    cronEnabled,
    prepareExitWatcherHandoff: async (): Promise<GatewayCronExitWatcherHandoff | undefined> => {
      const loading = cronStateLoader.peek();
      const resolved = loaded ?? (loading ? await loading : null);
      const handoff = await resolved?.state.prepareExitWatcherHandoff?.();
      if (!handoff) {
        return undefined;
      }
      return {
        ...handoff,
        stopOwner: async () => {
          await stopLoadedCronAndDrain(handoff);
        },
      };
    },
    // Reload rules invoke these hooks on whatever cronState is live; the lazy
    // proxy must forward every GatewayCronState member or hot reloads silently
    // no-op until a gateway restart (system-owned cron cadence changes never applied).
    reconcileExitWatchers: bindCron(({ state }) => state.reconcileExitWatchers.bind(state)),
    reconcileStreamWatchers: bindCron(({ state }) => state.reconcileStreamWatchers.bind(state)),
    async stopStreamWatchers() {
      // Nothing to stop before the heavy cron service is built.
      await loaded?.state.stopStreamWatchers();
    },
    reconcileSystemJobs: bindCron(({ state }) => state.reconcileSystemJobs.bind(state)),
  };
}
