import { setImmediate as nextTurn } from "node:timers/promises";
import type {
  PluginSourceSnapshotScrub,
  PluginSourceSnapshotScrubReport,
} from "./plugin-source-snapshot-shared.js";
import type { PluginRegistry } from "./registry-types.js";

type RegisteredScrub = {
  start(): Promise<PluginSnapshotScrubOutcome>;
  result?: Promise<PluginSnapshotScrubOutcome>;
};
const registries = new WeakMap<PluginRegistry, Set<RegisteredScrub>>();

export function registerPluginSnapshotScrub(
  registry: PluginRegistry,
  start: RegisteredScrub["start"],
) {
  let entries = registries.get(registry);
  if (!entries) {
    registries.set(registry, (entries = new Set()));
  }
  const entry: RegisteredScrub = { start };
  entries.add(entry);
  return () => {
    entries.delete(entry);
  };
}

/** Registration has settled; the scrub driver yields before entering the preparation pool. */
export function startPluginSnapshotScrubs(registry: PluginRegistry): void {
  for (const entry of registries.get(registry) ?? []) {
    entry.result ??= entry.start();
    void entry.result.catch((error: unknown) =>
      process.emitWarning(`Plugin snapshot scrub cleanup failed: ${String(error)}`),
    );
  }
}

export async function settlePluginSnapshotScrubs(registry: PluginRegistry) {
  startPluginSnapshotScrubs(registry);
  return await Promise.all([...(registries.get(registry) ?? [])].map((entry) => entry.result!));
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
