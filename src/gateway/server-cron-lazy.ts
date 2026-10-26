// Defers scheduler startup until cron is touched by runtime or API handlers.
import { DEFAULT_CRON_ENABLED } from "../config/cron-limits.js";
import { captureSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker-context.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { createLazyPromiseLoader, createLazyRuntimeMethodBinder } from "../shared/lazy-runtime.js";
import type {
  GatewayCronServiceContract,
  GatewayCronExitWatcherHandoff,
  GatewayCronState,
} from "./server-cron-contract.js";
import type { buildGatewayCronService } from "./server-cron.js";

/** Creates a cron state proxy that imports the real cron service on first use. */
export function createLazyGatewayCronState(
  params: Parameters<typeof buildGatewayCronService>[0],
): GatewayCronState {
  const spawnBroker = getSpawnBroker();
  const runWithReadOnlyWorkers = captureSqliteReadOnlyWorkerScope();
  const env = params.env ?? process.env;
  const storePath = params.storePath;
  const cronEnabled =
    env.OPENCLAW_SKIP_CRON !== "1" && (params.cfg.cron?.enabled ?? DEFAULT_CRON_ENABLED);
  let loaded: GatewayCronState | null = null;
  let stopped = false;
  let lifecycleGeneration = 0;
  let exitWatcherHandoff: GatewayCronExitWatcherHandoff | undefined;
  let exitWatcherHandoffStop: Promise<void> | undefined;
  let schedulingPaused = false;
  const cronStateLoader = createLazyPromiseLoader(
    () =>
      import("./server-cron.js").then(({ buildGatewayCronService }) => {
        loaded = runWithSpawnBroker(spawnBroker, () =>
          runWithReadOnlyWorkers(() => buildGatewayCronService(params)),
        );
        if (schedulingPaused) {
          loaded.cron.pauseScheduling();
        }
        return loaded;
      }),
    { cacheRejections: true },
  );

  const load = async (): Promise<GatewayCronState> => {
    if (loaded) {
      return loaded;
    }
    // Share the same import promise across concurrent API calls so only one
    // scheduler instance is built for a Gateway process.
    return await cronStateLoader.load();
  };
  const bindCron = createLazyRuntimeMethodBinder(load);
  const bindStartedCron = createLazyRuntimeMethodBinder(async () => {
    const resolved = await load();
    // Startup recovery must finish before a new receipt can become running.
    if (!stopped) {
      await cron.start();
    }
    return resolved;
  });

  const stopResolvedCron = async (resolved: GatewayCronState): Promise<void> => {
    if (exitWatcherHandoff) {
      // A cancelled startup must join the exact prepared owner's drain, not
      // prepare or stop another owner after its watchers have been adopted.
      await (exitWatcherHandoffStop ??= exitWatcherHandoff.stopOwner());
    } else if (resolved.cron.stopAndDrain) {
      await resolved.cron.stopAndDrain();
    } else {
      resolved.cron.stop();
      await resolved.stopStreamWatchers();
    }
  };

  const stopLoadedCronAndDrain = async (handoff?: GatewayCronExitWatcherHandoff): Promise<void> => {
    stopped = true;
    lifecycleGeneration += 1;
    exitWatcherHandoff ??= handoff;
    const loading = cronStateLoader.peek();
    const resolved = loaded ?? (loading ? await loading : null);
    if (resolved) {
      await stopResolvedCron(resolved);
    }
  };

  const cron: GatewayCronServiceContract = {
    async start() {
      stopped = false;
      const resolved = await load();
      if (!stopped) {
        await resolved.cron.start();
      }
    },
    stop() {
      stopped = true;
      lifecycleGeneration += 1;
      if (loaded) {
        loaded.cron.stop();
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
            resolved.cron.stop();
          })
          .catch(() => {
            // Failed loading created no service to stop; its caller owns the error.
          });
      }
    },
    async stopAndDrain() {
      await stopLoadedCronAndDrain();
    },
    pauseScheduling() {
      schedulingPaused = true;
      if (loaded) {
        loaded.cron.pauseScheduling();
      }
    },
    resumeScheduling() {
      schedulingPaused = false;
      loaded?.cron.resumeScheduling();
    },
    getSuspensionBlockerCount() {
      return loaded?.cron.getSuspensionBlockerCount?.() ?? 0;
    },
    status: bindCron((state) => state.cron.status.bind(state.cron)),
    list: bindCron((state) => state.cron.list.bind(state.cron)),
    listPage: bindCron((state) => state.cron.listPage.bind(state.cron)),
    add: bindCron((state) => state.cron.add.bind(state.cron)),
    update: bindCron((state) => state.cron.update.bind(state.cron)),
    updateWithPrecondition: bindCron((state) => state.cron.updateWithPrecondition.bind(state.cron)),
    remove: bindCron((state) => state.cron.remove.bind(state.cron)),
    removeStaleJobFamily: bindCron((state) => state.cron.removeStaleJobFamily.bind(state.cron)),
    async removeAgentJobsTransactional(agentId, commit) {
      return await (await load()).cron.removeAgentJobsTransactional(agentId, commit);
    },
    quiesceJobs: bindCron((state) => state.cron.quiesceJobs.bind(state.cron)),
    run: bindStartedCron((state) => state.cron.run.bind(state.cron)),
    enqueueRun: bindStartedCron((state) => state.cron.enqueueRun.bind(state.cron)),
    waitForManualRun: bindCron((state) => state.cron.waitForManualRun.bind(state.cron)),
    readEventSources: bindCron((state) => state.cron.readEventSources.bind(state.cron)),
    runEvent: bindCron((state) => state.cron.runEvent.bind(state.cron)),
    getStoreKey() {
      const storeKey = loaded?.cron.getStoreKey?.();
      if (!storeKey) {
        throw new Error("Cron store is not prepared; read cron jobs first");
      }
      return storeKey;
    },
    getJob(id) {
      return loaded?.cron.getJob(id);
    },
    readJob: bindCron((state) => state.cron.readJob.bind(state.cron)),
    async readScratch(id, options) {
      options?.assertCurrent?.();
      const current = await load();
      options?.assertCurrent?.();
      return await current.cron.readScratch(id, options);
    },
    writeScratch: bindCron((state) => state.cron.writeScratch.bind(state.cron)),
    getDefaultAgentId() {
      return loaded?.cron.getDefaultAgentId();
    },
    async prepareWake() {
      await load();
    },
    async wake(opts) {
      if (!loaded) {
        // A wake should kick off lazy loading but cannot claim success before
        // cron exists and knows whether the target job is wakeable.
        void load();
        return { ok: false };
      }
      return loaded.cron.wake(opts);
    },
  };

  return {
    cron,
    get readHeartbeatSummary() {
      return loaded?.readHeartbeatSummary;
    },
    deferHookWake: async (opts) => {
      const generation = lifecycleGeneration;
      const commitGuard = () => {
        opts.commitGuard();
        if (stopped || lifecycleGeneration !== generation) {
          throw new Error("Scheduled Hook wake owner changed; retry the request");
        }
      };
      commitGuard();
      const current = await load();
      commitGuard();
      const defer = current.deferHookWake;
      if (!defer) {
        throw new Error("Scheduled Hook wake admission is unavailable; restart the Gateway");
      }
      return await defer({ ...opts, commitGuard });
    },
    storePath,
    cronEnabled,
    prepareExitWatcherHandoff: async (): Promise<GatewayCronExitWatcherHandoff | undefined> => {
      const loading = cronStateLoader.peek();
      const resolved = loaded ?? (loading ? await loading : null);
      const handoff = await resolved?.prepareExitWatcherHandoff?.();
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
    // Reload hooks follow the serving lazy owner.
    reconcileExitWatchers: bindCron((state) => state.reconcileExitWatchers.bind(state)),
    reconcileStreamWatchers: bindCron((state) => state.reconcileStreamWatchers.bind(state)),
    async stopStreamWatchers() {
      // Nothing to stop before the heavy cron service is built.
      await loaded?.stopStreamWatchers();
    },
  };
}
