import { setImmediate as nextTurn } from "node:timers/promises";
import { throwSettledAggregate } from "../infra/error-graph-internal.js";
import { PluginInventoryRetiredError } from "./plugin-instance-error.js";
import { getPluginInstance, type PluginInstanceHandle } from "./plugin-instance-scope.js";
import type {
  PluginSourceSnapshotScrub,
  PluginSourceSnapshotScrubReport,
} from "./plugin-source-snapshot-shared.js";
import type { PluginRegistry } from "./registry-types.js";

type RegisteredScrub = {
  registry: RegistryScrubs;
  start(): Promise<PluginSnapshotScrubOutcome>;
  cancel(): Promise<void>;
  result?: Promise<PluginSnapshotScrubOutcome>;
  settled?: boolean;
  lifetime?: ScrubLifetime;
};
type RegistryScrubs = {
  entries: Set<RegisteredScrub>;
  started: boolean;
  stopped: boolean;
  lifetime?: ScrubLifetime;
};
type ScrubLifetime = {
  current?: RegistryScrubs;
  started: boolean;
  stopped: boolean;
  pending: Set<RegisteredScrub>;
};
const registries = new WeakMap<PluginRegistry, RegistryScrubs>();
const instanceScrubs = new WeakMap<PluginInstanceHandle, RegisteredScrub>();

function registryScrubs(registry: PluginRegistry): RegistryScrubs {
  let owner = registries.get(registry);
  if (!owner) {
    registries.set(registry, (owner = { entries: new Set(), started: false, stopped: false }));
  }
  return owner;
}

function trackEntry(entry: RegisteredScrub, lifetime: ScrubLifetime | undefined) {
  if (lifetime && !entry.settled) {
    entry.lifetime = lifetime;
    lifetime.pending.add(entry);
  }
}

function startEntry(entry: RegisteredScrub, lifetime?: ScrubLifetime) {
  trackEntry(entry, lifetime);
  if (!entry.result) {
    entry.result = Promise.resolve().then(() => entry.start());
    const settle = () => {
      entry.settled = true;
      entry.lifetime?.pending.delete(entry);
      entry.lifetime = undefined;
    };
    void entry.result.then(settle, (error: unknown) => {
      settle();
      process.emitWarning(`Plugin snapshot scrub cleanup failed: ${String(error)}`);
    });
  }
  return entry.result;
}

export function registerPluginSnapshotScrub(
  instance: PluginInstanceHandle,
  start: RegisteredScrub["start"],
  cancel: RegisteredScrub["cancel"],
) {
  if (!instance.owner || instance.owner.revoked || !instance.acceptingCalls) {
    throw new PluginInventoryRetiredError();
  }
  const owner = registryScrubs(instance.owner.registry);
  const entry: RegisteredScrub = { registry: owner, start, cancel };
  owner.entries.add(entry);
  instanceScrubs.set(instance, entry);
  const remove = () => {
    entry.registry.entries.delete(entry);
    if (instanceScrubs.get(instance) === entry) {
      instanceScrubs.delete(instance);
    }
  };
  instance.onModuleDispose(remove);
  if (owner.started && !owner.stopped && !owner.lifetime?.stopped) {
    void startEntry(entry, owner.lifetime);
  }
  return remove;
}

/** Publication has adopted exact live instances before selecting their scrub owner. */
function adoptInstanceScrubs(registry: PluginRegistry, current: RegistryScrubs) {
  for (const record of registry.plugins) {
    const instance = getPluginInstance(record);
    const entry = instance && instanceScrubs.get(instance);
    if (
      !instance ||
      !entry ||
      instance.owner?.registry !== registry ||
      instance.owner.revoked ||
      !instance.acceptingCalls ||
      instance.disposing
    ) {
      continue;
    }
    entry.registry.entries.delete(entry);
    entry.registry = current;
    if (!entry.settled) {
      current.entries.add(entry);
    }
  }
}

/** Registration has settled; the scrub driver yields before entering the preparation pool. */
export function startPluginSnapshotScrubs(
  registry: PluginRegistry,
): Promise<PluginSnapshotScrubOutcome[]> {
  const owner = registryScrubs(registry);
  if (owner.stopped || owner.lifetime?.stopped) {
    return Promise.resolve([]);
  }
  owner.started = true;
  return Promise.all([...owner.entries].map((entry) => startEntry(entry, owner.lifetime)));
}

/** The Gateway owner selects generations; only post-ready starts their background work. */
export function createPluginSnapshotScrubOwner(registry: PluginRegistry) {
  const lifetime: ScrubLifetime = { started: false, stopped: false, pending: new Set() };
  let stopping: Promise<void> | undefined;
  const publish = (next: PluginRegistry) => {
    if (lifetime.stopped) {
      return;
    }
    const current = registryScrubs(next);
    adoptInstanceScrubs(next, current);
    current.lifetime = lifetime;
    lifetime.current = current;
    for (const entry of current.entries) {
      if (entry.result) {
        trackEntry(entry, lifetime);
      }
    }
    if (lifetime.started) {
      // Individual entry failures already report their diagnostics.
      void startPluginSnapshotScrubs(next).catch(() => {});
    }
  };
  publish(registry);
  return {
    publish,
    start() {
      lifetime.started = true;
      if (lifetime.stopped || !lifetime.current) {
        return Promise.resolve([]);
      }
      lifetime.current.started = true;
      return Promise.all([...lifetime.current.entries].map((entry) => startEntry(entry, lifetime)));
    },
    stop() {
      if (!stopping) {
        lifetime.stopped = true;
        const entries = new Set([...lifetime.pending, ...(lifetime.current?.entries ?? [])]);
        lifetime.current = undefined;
        stopping = Promise.allSettled([...entries].map(async (entry) => await entry.cancel())).then(
          (results) =>
            throwSettledAggregate(results, "Plugin source snapshot scrub shutdown failed"),
        );
      }
      return stopping;
    },
  };
}

/** Stop the worker cursors before the registry releases their retained source custody. */
export async function stopPluginSnapshotScrubs(registry: PluginRegistry): Promise<void> {
  const owner = registries.get(registry);
  if (!owner) {
    return;
  }
  owner.stopped = true;
  const results = await Promise.allSettled(
    [...owner.entries].map(async (entry) => await entry.cancel()),
  );
  throwSettledAggregate(results, "Plugin source snapshot scrub shutdown failed");
}

export type PluginSnapshotScrubOutcome = {
  status: "passed" | "failed" | "cancelled";
  report?: PluginSourceSnapshotScrubReport;
  error?: unknown;
};

/** The existing preparation pool grants each bounded scrub step only while foreground work is idle. */
export function createPluginSnapshotScrub(params: {
  create(): PluginSourceSnapshotScrub;
  waitForIdle(signal: AbortSignal): Promise<void>;
  onFailure(error: unknown): Promise<void>;
}) {
  const controller = new AbortController();
  let task: Promise<PluginSnapshotScrubOutcome> | undefined;
  let last: PluginSourceSnapshotScrubReport | undefined;
  const run = async (): Promise<PluginSnapshotScrubOutcome> => {
    let cursor: PluginSourceSnapshotScrub | undefined;
    try {
      // Startup's promise continuations settle before the first worker request.
      await nextTurn(undefined, { signal: controller.signal });
      await params.waitForIdle(controller.signal);
      controller.signal.throwIfAborted();
      cursor = params.create();
      do {
        await params.waitForIdle(controller.signal);
        controller.signal.throwIfAborted();
        last = await cursor.step({ maxFiles: 16, maxBytes: 256 * 1024 });
        if (!last.done) {
          await nextTurn(undefined, { signal: controller.signal });
        }
      } while (!last.done);
      return { status: "passed", report: last };
    } catch (error) {
      if (controller.signal.aborted) {
        return { status: "cancelled", report: last };
      }
      await params.onFailure(error);
      return { status: "failed", report: last, error };
    } finally {
      // Session shutdown owns cancellation cleanup after this in-flight step has joined.
      if (!controller.signal.aborted) {
        await cursor?.dispose();
      }
    }
  };
  return {
    start() {
      return (task ??= controller.signal.aborted
        ? Promise.resolve({ status: "cancelled", report: last })
        : run());
    },
    async cancel() {
      controller.abort();
      return await (task ?? Promise.resolve({ status: "cancelled", report: last }));
    },
  };
}

/** Wait only between bounded scrub steps; foreground preparation retains priority. */
export async function waitForPluginPreparationIdle(params: {
  signal: AbortSignal;
  isRetired(): boolean;
  isIdle(): boolean;
  idleWaiters: Set<() => void>;
}) {
  const { signal } = params;
  for (;;) {
    signal.throwIfAborted();
    if (params.isRetired()) {
      throw new Error("Plugin preparation worker has closed");
    }
    if (params.isIdle()) {
      await nextTurn(undefined, { signal });
      if (params.isIdle()) {
        return;
      }
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        params.idleWaiters.delete(notify);
        signal.removeEventListener("abort", abort);
      };
      const notify = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Plugin preparation aborted", { cause: signal.reason }),
        );
      };
      params.idleWaiters.add(notify);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}
