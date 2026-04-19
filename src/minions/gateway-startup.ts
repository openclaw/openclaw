import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveDurabilityMode } from "./durability-config.js";
import { BUILTIN_HANDLERS } from "./handlers/index.js";
import { MinionStore } from "./store.js";
import { MinionWorker } from "./worker.js";

const log = createSubsystemLogger("minions/startup");

let activeWorker: MinionWorker | null = null;
let workerPromise: Promise<void> | null = null;

/**
 * Start the minions worker alongside the gateway. Call once at gateway init.
 * No-op if durability mode is "legacy" or if already started.
 */
export function maybeStartMinionWorker(): void {
  if (activeWorker) {
    return;
  }

  const mode = resolveDurabilityMode();
  if (mode === "legacy") {
    log.info("Minions durability disabled (legacy mode)");
    return;
  }

  try {
    const store = MinionStore.openDefault();
    const worker = new MinionWorker(store, {
      concurrency: 4,
      pollInterval: 5000,
      lockDuration: 30000,
      stalledInterval: 10000,
    });

    for (const h of BUILTIN_HANDLERS) {
      worker.register(h.name, h.handler);
    }

    activeWorker = worker;

    workerPromise = worker.start().catch((err) => {
      log.warn("Minion worker exited with error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    log.info("Minion worker started", {
      handlers: BUILTIN_HANDLERS.map((h) => h.name),
      concurrency: 4,
    });
  } catch (err) {
    log.warn("Failed to start minion worker", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function stopMinionWorker(): void {
  if (activeWorker) {
    activeWorker.stop();
    activeWorker = null;
  }
}

export async function stopMinionWorkerAndWait(): Promise<void> {
  if (activeWorker) {
    activeWorker.stop();
    activeWorker = null;
  }
  if (workerPromise) {
    await workerPromise;
    workerPromise = null;
  }
}
