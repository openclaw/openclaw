/** Exact plugin custody for a monitor, separate from its callers' admission authority. */
import {
  getPluginValueInstance,
  wrapCurrentPluginInstance,
} from "../../plugins/plugin-instance-scope.js";
import type { PluginInstanceConsumer } from "../../plugins/plugin-instance.types.js";
import type {
  ChannelIngressMonitorRetention,
  CreateChannelIngressMonitorOptions,
} from "./ingress-monitor-types.js";
import type { ChannelIngressQueue } from "./ingress-queue.js";

/** Replay-guard retention defaults; changing a value requires a per-channel keyspace audit. */
export const CHANNEL_INGRESS_RETENTION_DEFAULTS = Object.freeze({
  pruneIntervalMs: 60 * 60 * 1_000,
  completedTtlMs: 30 * 24 * 60 * 60 * 1_000,
  completedMaxEntries: 20_000,
  failedTtlMs: 30 * 24 * 60 * 60 * 1_000,
  failedMaxEntries: 20_000,
} satisfies ChannelIngressMonitorRetention);

export function createIngressMonitorOwner<TRaw, TBody, TStoredPayload, TMetadata>(
  params: CreateChannelIngressMonitorOptions<TRaw, TBody, TStoredPayload, TMetadata>,
) {
  const {
    queue: suppliedQueue,
    now: clock = Date.now,
    onError,
    onActivityChange,
    createStoppedError: stoppedError,
    drain = {},
    ...callbacks
  } = params;
  const { onLog, formatError, resolveNonRetryableFailure, ...drainCallbacks } = drain;
  const options = wrapCurrentPluginInstance({ ...callbacks, drain: drainCallbacks });
  const pluginOwner = getPluginValueInstance(options);
  const rawMaintenance = {
    now: clock,
    onError,
    onActivityChange,
    stoppedError,
    onLog,
    formatError,
    resolveNonRetryableFailure,
  };
  let maintenance = rawMaintenance;
  let custody: PluginInstanceConsumer | undefined;
  let unsubscribeResume: (() => void) | undefined;
  type Queue = ChannelIngressQueue<TStoredPayload, TMetadata>;
  let queue: Queue | undefined = typeof suppliedQueue === "function" ? undefined : suppliedQueue;
  let custodyQueue: Queue | undefined;
  const getQueue = (): Queue =>
    (queue ??= typeof suppliedQueue === "function" ? suppliedQueue() : suppliedQueue);
  const getCustodyQueue = (): Queue => {
    const source = getQueue();
    if (!pluginOwner) {
      return source;
    }
    // A shadow target also supports frozen queues. Calls preserve the original receiver.
    custodyQueue ??= new Proxy(
      { ...source },
      {
        get: (_target, key) => {
          const read = () => Reflect.get(source, key, source);
          const value = custody ? custody.run(read) : read();
          return typeof value === "function"
            ? (...args: unknown[]) => {
                const call = () => Reflect.apply(value, source, args);
                // Late settlements use their caller's authority after the monitor releases custody.
                return custody ? custody.run(call) : call();
              }
            : value;
        },
      },
    );
    return custodyQueue;
  };
  const retention =
    options.retention === "standard"
      ? CHANNEL_INGRESS_RETENTION_DEFAULTS
      : { ...CHANNEL_INGRESS_RETENTION_DEFAULTS, ...options.retention };
  const { pruneIntervalMs, ...pruneOptions } = retention;
  let lastPrunedAt = 0;

  const pruneIfDue = async (owner: "admission" | "pump"): Promise<void> => {
    // Zero preserves admission-owned compatibility: prune once per admission, never from a pump.
    if ((owner === "admission") !== pruneIntervalMs <= 0) {
      return;
    }
    const currentTime = maintenance.now();
    if (owner === "pump" && currentTime - lastPrunedAt < pruneIntervalMs) {
      return;
    }
    await (owner === "pump" ? getCustodyQueue() : getQueue()).prune({
      ...pruneOptions,
      now: currentTime,
    });
    lastPrunedAt = currentTime;
  };

  return {
    options,
    pruneIfDue,
    get maintenance() {
      return maintenance;
    },
    now: () => maintenance.now(),
    getQueue,
    getCustodyQueue,
    isPluginQuiesced: () => pluginOwner?.acceptingCalls === false,
    reportError: (error: unknown): void => {
      try {
        maintenance.onError?.(error);
      } catch {
        // Observers cannot corrupt ingress bookkeeping.
      }
    },
    runPump: (pump: () => Promise<void>) =>
      pluginOwner ? pluginOwner.lifecycle.runInBackgroundContext(pump) : pump(),
    start: (wake: () => void) => {
      // A failed lazy queue startup acquires no hold; pause retains the existing one.
      custody ??= pluginOwner?.retainConsumer(undefined, undefined, "custody");
      maintenance = custody ? custody.wrap(rawMaintenance) : rawMaintenance;
      unsubscribeResume ??= pluginOwner?.onResume(wake);
    },
    release: () => {
      unsubscribeResume?.();
      const released = custody;
      custody = undefined;
      released?.release();
      maintenance = rawMaintenance;
    },
  };
}
