/** Shared durable channel-ingress admission, pump, retention, and shutdown lifecycle. */
import { formatErrorMessage } from "../../infra/errors.js";
import {
  getGatewayRestartDrainSignal,
  getGatewaySuspendAdmissionPhase,
  isGatewayRestartDraining,
  onGatewaySuspendAdmissionChange,
  waitForGatewayRestartFenceSettlement,
} from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createChannelIngressDrainOwner,
  DEFAULT_INGRESS_START_LIMIT,
  type ChannelIngressDrain,
} from "./ingress-drain.js";
import {
  createChannelIngressAdmission,
  type ChannelIngressAdmissionContext,
} from "./ingress-monitor-admission.js";
import { createAdmissionClaimLock, waitForPending } from "./ingress-monitor-tasks.js";
import type {
  ChannelIngressMonitorDeliveryResult,
  ChannelIngressMonitorFacts,
  ChannelIngressMonitorLifecycle,
  ChannelIngressMonitorRetention,
  CreateChannelIngressMonitorOptions,
} from "./ingress-monitor-types.js";
import type { ChannelIngressQueue } from "./ingress-queue.js";
import {
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
} from "./ingress-retry-policy.js";
import { ChannelIngressUnavailableError } from "./ingress-unavailable.js";

export type {
  ChannelIngressMonitorDeliveryResult,
  ChannelIngressMonitorDrainOptions,
  ChannelIngressMonitorFacts,
  ChannelIngressMonitorLifecycle,
  ChannelIngressMonitorPayloadCodec,
  CreateChannelIngressMonitorOptions,
} from "./ingress-monitor-types.js";

/** Replay-guard retention defaults; changing a value requires a per-channel keyspace audit. */
export const CHANNEL_INGRESS_RETENTION_DEFAULTS = Object.freeze({
  pruneIntervalMs: 60 * 60 * 1_000,
  completedTtlMs: 30 * 24 * 60 * 60 * 1_000,
  completedMaxEntries: 20_000,
  failedTtlMs: 30 * 24 * 60 * 60 * 1_000,
  failedMaxEntries: 20_000,
} satisfies ChannelIngressMonitorRetention);

/**
 * Creates the shared monitor around a durable queue and ingress drain.
 * Channel code keeps transport inspection, payload shape, and delivery policy.
 */
export function createChannelIngressMonitor<TRaw, TBody, TStoredPayload, TMetadata = unknown>(
  options: CreateChannelIngressMonitorOptions<TRaw, TBody, TStoredPayload, TMetadata>,
) {
  const now = options.now ?? Date.now;
  const waitForDeliveryIdleBeforeRepump = options.waitForDeliveryIdleBeforeRepump ?? false;
  const retention =
    options.retention === "standard"
      ? CHANNEL_INGRESS_RETENTION_DEFAULTS
      : { ...CHANNEL_INGRESS_RETENTION_DEFAULTS, ...options.retention };
  const { pruneIntervalMs, ...pruneOptions } = retention;
  const shutdown = new AbortController();
  const drainAbortSignal = options.abortSignal
    ? AbortSignal.any([shutdown.signal, options.abortSignal])
    : shutdown.signal;
  const activeDeliveries = new Set<Promise<unknown>>();
  const activeInspections = new Set<Promise<unknown>>();
  const startLimit = options.drain?.startLimit ?? DEFAULT_INGRESS_START_LIMIT;
  // Released deferrals lend start slots while stop still joins their callbacks.
  // Bound open callbacks to startLimit + this budget; held lanes cannot lend slots.
  const deferredStartCapacityLimit =
    options.drain?.deferredLaneOccupancy === "release" ? startLimit : 0;
  let deferredStartCapacity = 0;
  const deferredClaims = new Set<Promise<void>>();
  type Queue = ChannelIngressQueue<TStoredPayload, TMetadata>;
  const suppliedQueue = options.queue;
  const queueFactory = typeof suppliedQueue === "function" ? suppliedQueue : () => suppliedQueue;
  let queue: Queue | undefined = typeof suppliedQueue === "function" ? undefined : suppliedQueue;
  type Drain = ReturnType<typeof createChannelIngressDrainOwner<TStoredPayload, TMetadata>>;
  let drain: Drain | undefined;
  let running = false;
  let stopped = false;
  let requested = false;
  let pumping: Promise<void> | undefined;
  let drainIdleWake: Promise<void> | undefined;
  let drainIdleWakeRequested = false;
  let restartFenceWake: Promise<void> | undefined;
  let releaseRestartFenceWake = () => {};
  let suspensionDrainPending = false;
  let unsubscribeSuspension: (() => void) | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let lastPrunedAt = 0;
  let admissionTail: Promise<void> = Promise.resolve();
  const withAdmissionClaimLock = createAdmissionClaimLock();
  let stopTask: Promise<void> | undefined;
  let lastReportedActive = false;

  const clearSuspensionSubscription = (): void => {
    suspensionDrainPending = false;
    unsubscribeSuspension?.();
    unsubscribeSuspension = undefined;
  };

  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Observers must not be able to corrupt ingress bookkeeping.
    }
  };

  const publishActivity = (): void => {
    const active =
      activeInspections.size + activeDeliveries.size > 0 ||
      (running && (requested || pumping !== undefined));
    if (active === lastReportedActive) {
      return;
    }
    lastReportedActive = active;
    try {
      options.onActivityChange?.(active);
    } catch (error) {
      reportError(error);
    }
  };

  const createStoppedError = () =>
    options.createStoppedError?.() ?? new Error("Channel ingress monitor is stopped.");

  const getQueue = (): Queue => (queue ??= queueFactory());

  const ensureQueueAvailable = (): void => {
    try {
      getQueue();
    } catch (error) {
      throw new ChannelIngressUnavailableError(
        `Channel ingress queue is unavailable: ${formatErrorMessage(error)}`,
        { cause: error },
      );
    }
  };

  const isAborted = () => drainAbortSignal.aborted;

  const inspect = options.inspectAsync ?? options.inspect;
  const waitForActiveDeliveries = () => waitForPending(() => activeDeliveries);
  // A rejected pump wrapper remains caller-visible; delivery joins observe every outcome.
  const waitForPumpIdle = () => waitForPending(() => (pumping ? [pumping] : []), true);
  const waitForDeferredClaims = () => waitForPending(() => deferredClaims);

  const getDrain = (): Drain => {
    drain ??= createChannelIngressDrainOwner<TStoredPayload, TMetadata>(
      {
        ...options.drain,
        queue: getQueue(),
        abortSignal: drainAbortSignal,
        now,
        retryPolicy: options.drain?.retryPolicy ?? {
          maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
          deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
        },
        formatError: options.drain?.formatError ?? formatErrorMessage,
        dispatchClaimedEvent: async (claim, lifecycle, admittedLaneKey) => {
          // Preparation owns cancellation settlement as well as the inspection read.
          const inspection = (async () => {
            if (shouldStopDispatch() || lifecycle.abortSignal.aborted) {
              await lifecycle.onCancelled?.();
              return undefined;
            }
            let decoded: { version: unknown; body: TBody };
            if (options.payload.storage === "raw-event") {
              const stored = claim.payload as { version?: unknown; rawEvent?: unknown };
              if (!stored || typeof stored.rawEvent !== "string") {
                throw options.payload.createClaimError("invalid-version", claim);
              }
              decoded = { version: stored.version, body: stored.rawEvent as TBody };
            } else {
              decoded = options.payload.decode(claim.payload, { claim });
            }
            if (decoded.version !== options.payload.version) {
              throw options.payload.createClaimError("invalid-version", claim);
            }
            const raw = options.payload.deserialize(decoded.body, { claim });
            if (admittedLaneKey === undefined) {
              const claimedLaneKey = claim.laneKey ?? options.drain?.deriveLaneKey?.(claim);
              const facts = await inspect(raw, {
                phase: "claim",
                claimedId: claim.id,
                claimedLaneKey,
              });
              if (!running || isAborted() || lifecycle.abortSignal.aborted) {
                await lifecycle.onCancelled?.();
                return undefined;
              }
              if (!facts || facts.eventId !== claim.id || facts.laneKey !== claimedLaneKey) {
                throw options.payload.createClaimError("identity-mismatch", claim);
              }
            }
            return { raw };
          })();
          activeInspections.add(inspection);
          publishActivity();
          let prepared: Awaited<typeof inspection>;
          try {
            prepared = await inspection;
          } finally {
            activeInspections.delete(inspection);
            if (!prepared) {
              publishActivity();
            }
          }
          if (!prepared) {
            return { kind: "deferred" };
          }
          const { raw } = prepared;

          let handedOff = false;
          let deferredHandoff = false;
          let releasedStartCapacity = false;
          let deliverySettled = false;
          const releaseStartCapacity = () => {
            if (
              releasedStartCapacity ||
              deliverySettled ||
              deferredStartCapacity >= deferredStartCapacityLimit
            ) {
              return;
            }
            releasedStartCapacity = true;
            deferredStartCapacity += 1;
            // A slot just freed; wake the pump so a waiting lane can use it.
            requestDrain();
          };
          const deferredClaim = options.deferredClaims ? createDeferredCore() : undefined;
          let deferredClaimSettled = false;
          const settleDeferredClaim = () => {
            if (!deferredClaim || deferredClaimSettled) {
              return;
            }
            deferredClaimSettled = true;
            lifecycle.abortSignal.removeEventListener("abort", settleDeferredClaim);
            deferredClaims.delete(deferredClaim.promise);
            deferredClaim.resolve();
          };
          if (options.deferredClaims === "settle-on-abort") {
            lifecycle.abortSignal.addEventListener("abort", settleDeferredClaim, { once: true });
            if (lifecycle.abortSignal.aborted) {
              settleDeferredClaim();
            }
          }
          const trackDeferredClaim = () => {
            if (deferredClaim && !deferredClaimSettled) {
              deferredClaims.add(deferredClaim.promise);
            }
          };
          const settleLifecycle = async (settle: () => void | Promise<void>, deferred = true) => {
            handedOff = true;
            if (deferred) {
              deferredHandoff = true;
            }
            // Settlement can start before delivery returns its deferred handoff.
            trackDeferredClaim();
            try {
              await settle();
              requestDrain();
            } finally {
              settleDeferredClaim();
            }
          };
          const wrappedLifecycle: ChannelIngressMonitorLifecycle = {
            ...lifecycle,
            admission: "exclusive",
            onAdopted: () => settleLifecycle(() => lifecycle.onAdopted(), false),
            onDeferred: () => {
              handedOff = true;
              deferredHandoff = true;
              trackDeferredClaim();
              lifecycle.onDeferred();
              releaseStartCapacity();
            },
            onAdoptionFinalizing: () => {
              handedOff = true;
              deferredHandoff = true;
              trackDeferredClaim();
              lifecycle.onAdoptionFinalizing();
            },
            onFailed: (error) => settleLifecycle(() => lifecycle.onFailed?.(error)),
            onCancelled: () => settleLifecycle(() => lifecycle.onCancelled?.()),
            onAbandoned: () => settleLifecycle(() => lifecycle.onAbandoned()),
          };

          // Adoption can complete before delivery returns; track both lifetimes so stop
          // never drops channel work merely because the durable claim already settled.
          const delivery = Promise.resolve()
            .then(() => {
              if (!running || isAborted() || lifecycle.abortSignal.aborted) {
                return wrappedLifecycle.onCancelled?.();
              }
              return options.deliver(raw, wrappedLifecycle, claim);
            })
            .finally(() => {
              // Remove the settled delivery before failure handling awaits a worker write.
              deliverySettled = true;
              activeDeliveries.delete(delivery);
              if (releasedStartCapacity) {
                releasedStartCapacity = false;
                deferredStartCapacity -= 1;
              }
              publishActivity();
            });
          activeDeliveries.add(delivery);
          publishActivity();
          let result: ChannelIngressMonitorDeliveryResult | void;
          try {
            result = await delivery;
          } catch (error) {
            if (deferredHandoff && deferredClaim && !deferredClaimSettled) {
              await wrappedLifecycle.onFailed?.(error);
              return { kind: "deferred" };
            }
            if (isAborted() || lifecycle.abortSignal.aborted) {
              return { kind: "failed-retryable", error };
            }
            throw error;
          }
          if (result?.kind === "transferred" || result?.kind === "pending") {
            // Receipt transfer owns completion, including after cancellation.
            settleDeferredClaim();
            return result;
          }
          if (result?.kind === "failed-retryable") {
            if (deferredHandoff && deferredClaim && !deferredClaimSettled) {
              await wrappedLifecycle.onFailed?.(result.error);
              return { kind: "deferred" };
            }
            return result;
          }
          // Preserve terminal/handoff outcomes under abort: releasing them could replay delivery.
          if (result?.kind === "completed" && !deferredHandoff) {
            return result;
          }
          if (result?.kind === "deferred" && !deferredHandoff) {
            wrappedLifecycle.onDeferred();
          }
          // The deferred owner must settle its claim even after a conflicting terminal return.
          if (deferredHandoff) {
            return { kind: "deferred" };
          }
          if (isAborted() || lifecycle.abortSignal.aborted) {
            return { kind: "failed-retryable", error: createStoppedError() };
          }
          if (!handedOff) {
            // A policy gate or deliberate no-dispatch is terminal for transport replay.
            await wrappedLifecycle.onAdopted();
          }
          return { kind: "completed" };
        },
      },
      true,
    );
    return drain;
  };

  const pruneIfDue = async (owner: "admission" | "pump"): Promise<void> => {
    // Zero preserves admission-owned compatibility: prune once per admission, never from a pump.
    if ((owner === "admission") !== pruneIntervalMs <= 0) {
      return;
    }
    const currentTime = now();
    if (owner === "pump" && currentTime - lastPrunedAt < pruneIntervalMs) {
      return;
    }
    await getQueue().prune({ ...pruneOptions, now: currentTime });
    lastPrunedAt = currentTime;
  };

  const scheduleDrainIdleWake = (activeDrain: ChannelIngressDrain): void => {
    if (drainIdleWake) {
      drainIdleWakeRequested = true;
      return;
    }
    drainIdleWakeRequested = false;
    const wake = activeDrain.waitForIdle();
    drainIdleWake = wake;
    void wake.then(
      () => {
        if (drainIdleWake !== wake) {
          return;
        }
        const shouldRearm = drainIdleWakeRequested && running && !isAborted();
        drainIdleWake = undefined;
        drainIdleWakeRequested = false;
        if (shouldRearm) {
          scheduleDrainIdleWake(activeDrain);
        }
        requestDrain();
      },
      (error: unknown) => {
        if (drainIdleWake === wake) {
          drainIdleWake = undefined;
          drainIdleWakeRequested = false;
        }
        reportError(error);
      },
    );
  };

  const runPump = async (): Promise<void> => {
    try {
      for (;;) {
        requested = false;
        await pruneIfDue("pump");
        // Stop may win the async prune race; keep lazy drain creation behind this fence.
        if (!running || isAborted()) {
          break;
        }
        const activeDrain = getDrain();
        // Claiming and durable admission are mutually exclusive so a row cannot
        // dispatch before its transport-owned post-append acknowledgement finishes.
        const { started } = await withAdmissionClaimLock(() =>
          activeDrain.drainOnce({
            shouldStop: () =>
              !running ||
              isAborted() ||
              getGatewaySuspendAdmissionPhase() !== "accepting" ||
              activeDeliveries.size + activeInspections.size - deferredStartCapacity >= startLimit,
          }),
        );
        if (waitForDeliveryIdleBeforeRepump) {
          await waitForActiveDeliveries();
          await activeDrain.waitForIdle();
        } else if (started > 0) {
          // Failed-retryable delivery settles after the channel callback returns.
          // Wake once the drain has released or failed those claims.
          scheduleDrainIdleWake(activeDrain);
        }
        if (
          !running ||
          isAborted() ||
          (!requested && (!waitForDeliveryIdleBeforeRepump || started === 0))
        ) {
          break;
        }
      }
    } catch (error) {
      reportError(error);
    } finally {
      pumping = undefined;
      if (!running || isAborted()) {
        requested = false;
      } else if (requested) {
        requestDrain();
      }
      publishActivity();
    }
  };

  const scheduleRestartFenceWake = (): void => {
    if (restartFenceWake) {
      return;
    }
    const localWake = createDeferredCore();
    releaseRestartFenceWake = localWake.resolve;
    restartFenceWake = Promise.race([
      waitForGatewayRestartFenceSettlement(),
      localWake.promise,
    ]).then(() => {
      restartFenceWake = undefined;
      releaseRestartFenceWake = () => {};
      requestDrain();
    });
  };
  drainAbortSignal.addEventListener(
    "abort",
    () => {
      releaseRestartFenceWake();
      clearSuspensionSubscription();
    },
    { once: true },
  );

  const requestDrain = (): void => {
    if (!running || isAborted() || getGatewayRestartDrainSignal().aborted) {
      // A stale request here makes waitForIdle busy-spin on resolved awaits.
      requested = false;
      releaseRestartFenceWake();
      publishActivity();
      return;
    }
    if (isGatewayRestartDraining()) {
      // Keep the request pending until rollback reopens admission or drain commits.
      requested = true;
      scheduleRestartFenceWake();
      publishActivity();
      return;
    }
    if (getGatewaySuspendAdmissionPhase() !== "accepting") {
      // Keep durable rows queued without reporting active ingress while suspension drains.
      suspensionDrainPending = true;
      requested = false;
      publishActivity();
      return;
    }
    suspensionDrainPending = false;
    requested = true;
    if (pumping) {
      publishActivity();
      return;
    }
    pumping = options.runPumpTask ? options.runPumpTask(runPump) : runPump();
    publishActivity();
  };

  const clearPollTimer = () => {
    clearInterval(pollTimer);
    pollTimer = undefined;
  };

  const pause = async (): Promise<void> => {
    running = false;
    requested = false;
    releaseRestartFenceWake();
    clearPollTimer();
    publishActivity();
    await waitForPumpIdle();
  };

  const assertAdmissionOpen = (): void => {
    if (
      (stopped && options.admissionMode !== "durable-after-stop") ||
      (options.admissionMode === "while-running" && !running) ||
      (options.abortSignal?.aborted && options.admissionMode !== "durable-after-stop")
    ) {
      throw createStoppedError();
    }
  };

  const shouldStopDispatch = () =>
    !running ||
    isAborted() ||
    isGatewayRestartDraining() ||
    getGatewayRestartDrainSignal().aborted ||
    getGatewaySuspendAdmissionPhase() !== "accepting";
  const admitRawBatch = createChannelIngressAdmission<TRaw, TBody, TStoredPayload, TMetadata>({
    payload: options.payload,
    reuseAdmissionFactsForFreshClaims: options.reuseAdmissionFactsForFreshClaims,
    appendRetryDelaysMs: options.appendRetryDelaysMs,
    onDurableAdmission: options.onDurableAdmission,
    onAdmissionFailure: options.onAdmissionFailure,
    inspect: (raw) => inspect(raw, { phase: "admission" }),
    getQueue,
    pruneBeforeAdmission: () => pruneIfDue("admission"),
    getIdleDrain: () =>
      // Wrappers own dispatch context; only prepared identities can skip reconciliation.
      // Released deferrals and post-adoption deliveries must finish first.
      !options.runPumpTask &&
      (!options.drain?.reconcileStoredLaneKey || options.reuseAdmissionFactsForFreshClaims) &&
      !waitForDeliveryIdleBeforeRepump &&
      !shouldStopDispatch() &&
      startLimit > 0 &&
      activeDeliveries.size === 0 &&
      activeInspections.size === 0 &&
      !pumping &&
      !requested &&
      !drainIdleWake
        ? getDrain()
        : undefined,
    recoverUntrackedClaim: (idleDrain) => {
      idleDrain.dispose();
      drain = undefined;
      requestDrain();
    },
    scheduleDrainIdleWake,
  });

  const scheduleAdmission = async <T>(
    work: (admitOptions: ChannelIngressAdmissionContext) => Promise<T>,
    admitOptions?: { receivedAt?: number },
  ): Promise<T> => {
    assertAdmissionOpen();
    const receivedAt = admitOptions?.receivedAt ?? now();
    let needsDrain = false;
    // Append retries stay serialized so backoff cannot invert one lane's arrival order.
    const admission = admissionTail.then(() =>
      withAdmissionClaimLock(() =>
        work({
          receivedAt,
          onDurablyAdmitted: (alreadyClaimed) => {
            needsDrain ||= !alreadyClaimed;
          },
        }),
      ),
    );
    admissionTail = admission.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await admission;
    } finally {
      // A lost transport acknowledgement must not strand an already durable row.
      if (needsDrain) {
        requestDrain();
      }
    }
  };

  return {
    admit: (
      raw: TRaw,
      admitOptions?: { receivedAt?: number; facts?: ChannelIngressMonitorFacts },
    ) =>
      scheduleAdmission(async (sharedOptions) => {
        const [result] = await admitRawBatch([raw], {
          ...sharedOptions,
          ...(admitOptions?.facts ? { facts: admitOptions.facts } : {}),
        });
        return result!;
      }, admitOptions),
    admitBatch: (rawEvents: readonly TRaw[], admitOptions?: { receivedAt?: number }) =>
      scheduleAdmission((sharedOptions) => admitRawBatch(rawEvents, sharedOptions), admitOptions),
    start: () => {
      if (running || stopped || isAborted()) {
        return;
      }
      // Fail startup as dead ingress before arming a timer that would repeat the same error.
      ensureQueueAvailable();
      running = true;
      unsubscribeSuspension ??= onGatewaySuspendAdmissionChange((phase) => {
        if (!running) {
          return;
        }
        if (phase !== "accepting") {
          if (requested || pumping) {
            suspensionDrainPending = true;
            requested = false;
            publishActivity();
          }
          return;
        }
        if (suspensionDrainPending) {
          requestDrain();
        }
      });
      pollTimer = setInterval(requestDrain, options.pollIntervalMs);
      pollTimer.unref?.();
      requestDrain();
    },
    ensureQueueAvailable,
    requestDrain,
    pause,
    stop: () => {
      stopTask ??= (async () => {
        stopped = true;
        running = false;
        requested = false;
        clearSuspensionSubscription();
        releaseRestartFenceWake();
        clearPollTimer();
        publishActivity();
        // Every transport callback accepted before stop keeps its durable-append guarantee.
        await admissionTail;
        shutdown.abort(createStoppedError());
        await waitForPumpIdle();
        await waitForPending(() => activeInspections);
        if (options.waitForDeliveryIdleOnStop !== false) {
          await waitForActiveDeliveries();
          await drain?.waitForIdle();
        }
        if (options.deferredClaims && options.deferredClaims !== "manual") {
          await waitForDeferredClaims();
        }
        // Callback grace may expire, but already accepted writes still own their claims.
        await drain?.dispose({ waitForSettlements: true });
      })();
      return stopTask;
    },
    waitForIdle: async () => {
      for (;;) {
        await admissionTail;
        await waitForPumpIdle();
        await waitForPending(() => activeInspections);
        await waitForActiveDeliveries();
        await drain?.waitForIdle();
        // A settled claim may still own a wake for the next queued event.
        await drainIdleWake;
        await restartFenceWake;
        if (
          !drainIdleWake &&
          !pumping &&
          activeInspections.size === 0 &&
          activeDeliveries.size === 0 &&
          !requested
        ) {
          return;
        }
      }
    },
    waitForDeferredClaims,
    waitForPumpIdle,
    isRunning: () => running,
    isStopped: () => stopped,
  };
}
