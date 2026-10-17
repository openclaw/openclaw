import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import { truncateUtf8Prefix } from "../../utils/utf8-truncate.js";
import type { DesktopRfbAttachment } from "./attachment.js";
import type { DesktopAudioSource } from "./managed-linux-audio.js";

const DEFAULT_LINGER_MS = 60_000;
const MAX_OBSERVERS = 8;
const log = createSubsystemLogger("gateway/desktop");

export class DesktopSessionStaleOwnerError extends Error {
  constructor() {
    super("Desktop session owner epoch is stale");
    this.name = "DesktopSessionStaleOwnerError";
  }
}

export class DesktopSessionStoppedError extends Error {
  constructor() {
    super("Desktop session stopped before connecting");
    this.name = "DesktopSessionStoppedError";
  }
}

type DesktopSessionObserver = {
  control: boolean;
  operatorName?: string;
  /** Epoch the observer token was minted against; a stale token must not reach a newer entry. */
  ownerEpoch: number;
  close(code: number, reason: string): void;
};

type DesktopSessionAcquireResult = {
  attachment: DesktopRfbAttachment;
  auth?: "vnc-password" | "ard-account";
  vncPassword?: string;
  resolveAudio?: () => DesktopAudioSource | undefined;
  /** Internal setup detail; project only a fixed availability code to viewers. */
  readonly audioUnavailableReason?: string;
};

type DesktopSessionAcquireRequest = {
  sourceKey: string;
  ownerEpoch: number;
  /** Lifecycle events stop this exact owner; the stop promise joins initialization. */
  start: (
    isCurrent: () => boolean,
    stop: () => Promise<void>,
  ) => Promise<DesktopSessionAcquireResult>;
  teardown?: () => Promise<void>;
  /** Release source resources only after initialization and transport teardown have joined. */
  dispose?: () => Promise<void>;
};

type DesktopSessionActivateRequest = Omit<DesktopSessionAcquireRequest, "start">;
type DesktopSessionStartResult = DesktopSessionAcquireResult | undefined;

type DesktopSessionEntry = {
  sourceKey: string;
  ownerEpoch: number;
  initialization?: Promise<void>;
  stopPromise?: Promise<void>;
  stopFailed?: boolean;
  ready: Deferred<DesktopSessionStartResult>;
  readySettled: boolean;
  observers: Set<DesktopSessionObserver>;
  observerReservations: Set<symbol>;
  activities: Set<symbol>;
  controller?: DesktopSessionObserver;
  lingerTimer?: ReturnType<typeof setTimeout>;
  teardown?: DesktopSessionAcquireRequest["teardown"];
  dispose?: DesktopSessionAcquireRequest["dispose"];
  pendingStreams: Map<string, { stream: Duplex; reservation: { release(): void } }>;
};

/** Owns per-source desktop sessions and their connected observer lifetimes. */
export function createDesktopSessionRegistry(
  deps: {
    lingerMs?: number;
  } = {},
) {
  const lingerMs = deps.lingerMs ?? DEFAULT_LINGER_MS;
  const entries = new Map<string, DesktopSessionEntry>();
  const owners = new Set<DesktopSessionEntry>();
  const claimedOwnerEpochs = new Map<string, number>();
  const controlListeners = new Set<{
    sourceKey: string;
    ownerEpoch: number;
    changed(controlled: boolean): void;
  }>();
  const notifyControl = (entry: DesktopSessionEntry) => {
    for (const listener of controlListeners) {
      if (listener.sourceKey === entry.sourceKey && listener.ownerEpoch === entry.ownerEpoch) {
        listener.changed(entry.controller !== undefined);
      }
    }
  };

  const claimOwnerEpoch = (sourceKey: string, ownerEpoch: number): boolean => {
    const claimedEpoch = claimedOwnerEpochs.get(sourceKey);
    if (claimedEpoch !== undefined && ownerEpoch < claimedEpoch) {
      throw new DesktopSessionStaleOwnerError();
    }
    if (claimedEpoch === undefined || ownerEpoch > claimedEpoch) {
      claimedOwnerEpochs.set(sourceKey, ownerEpoch);
      return true;
    }
    return false;
  };

  const isCurrent = (entry: DesktopSessionEntry) =>
    entries.get(entry.sourceKey) === entry && !entry.stopPromise;

  const entryForOwner = (sourceKey: string, ownerEpoch: number) => {
    const entry = entries.get(sourceKey);
    return entry?.ownerEpoch === ownerEpoch && !entry.stopPromise ? entry : undefined;
  };

  const closeObserver = (observer: DesktopSessionObserver, code: number, reason: string) => {
    try {
      observer.close(code, reason);
    } catch {
      // Observer cleanup remains authoritative when the transport close callback fails.
    }
  };

  const stopEntry = (entry: DesktopSessionEntry, retryFailed = true): Promise<void> => {
    if (entry.stopPromise && (!entry.stopFailed || !retryFailed)) {
      return entry.stopPromise;
    }
    // Publish cleanup ownership before observer callbacks can reenter Stop.
    const stopped = createDeferredCore();
    entry.stopPromise = stopped.promise;
    entry.stopFailed = false;
    // Idle expiry and transport exit have no caller to report cleanup failure to.
    void stopped.promise.catch((error: unknown) => {
      log.warn(`Desktop session cleanup failed: ${String(error)}`, { sourceKey: entry.sourceKey });
    });
    void (async () => {
      clearTimeout(entry.lingerTimer);
      entry.lingerTimer = undefined;
      for (const observer of entry.observers) {
        entry.observers.delete(observer);
        closeObserver(observer, 1012, "desktop tunnel closed");
      }
      entry.observers.clear();
      entry.controller = undefined;
      notifyControl(entry);
      for (const pending of entry.pendingStreams.values()) {
        pending.reservation.release();
        pending.stream.destroy();
      }
      entry.pendingStreams.clear();
      entry.observerReservations.clear();
      entry.activities.clear();
      if (!entry.readySettled) {
        entry.readySettled = true;
        entry.ready.reject(new DesktopSessionStoppedError());
      }
      // Teardown brackets initialization so a source can stop the currently published
      // transport, then dispose anything initialization publishes before it settles.
      await entry.teardown?.();
      await entry.initialization?.catch(() => undefined);
      await entry.teardown?.();
      await entry.dispose?.();
    })()
      .then(() => {
        owners.delete(entry);
        if (entries.get(entry.sourceKey) === entry) {
          entries.delete(entry.sourceKey);
        }
      })
      .then(stopped.resolve, (error: unknown) => {
        // Only a lifecycle stop retries cleanup; acquisition reuses the recorded failure.
        entry.stopFailed = true;
        stopped.reject(error);
      });
    return stopped.promise;
  };

  const stopEntries = (pending: DesktopSessionEntry[], retryFailed = true): Promise<void> => {
    const stopped = Promise.allSettled(pending.map((entry) => stopEntry(entry, retryFailed))).then(
      (outcomes) => {
        const failure = outcomes.find((outcome) => outcome.status === "rejected");
        if (failure) {
          throw failure.reason;
        }
      },
    );
    // Each owner reports its failure; background callers may leave the joined result unawaited.
    void stopped.catch(() => undefined);
    return stopped;
  };

  const scheduleLinger = (entry: DesktopSessionEntry): void => {
    if (
      !isCurrent(entry) ||
      entry.observers.size > 0 ||
      entry.observerReservations.size > 0 ||
      entry.activities.size > 0
    ) {
      return;
    }
    clearTimeout(entry.lingerTimer);
    entry.lingerTimer = setTimeout(() => void stopEntry(entry), lingerMs);
    entry.lingerTimer.unref?.();
  };

  const waitForReady = async (entry: DesktopSessionEntry): Promise<DesktopSessionStartResult> => {
    const result = await entry.ready.promise;
    // Every observation gets an idle attachment window, including same-epoch reuse.
    scheduleLinger(entry);
    return result;
  };

  async function startSession(
    request:
      | DesktopSessionAcquireRequest
      | (DesktopSessionActivateRequest & { start: () => Promise<undefined> }),
  ): Promise<DesktopSessionStartResult> {
    claimOwnerEpoch(request.sourceKey, request.ownerEpoch);
    const current = entries.get(request.sourceKey);
    if (current && request.ownerEpoch === current.ownerEpoch && !current.stopPromise) {
      return await waitForReady(current);
    }

    const previous = [...owners].filter((entry) => entry.sourceKey === request.sourceKey);
    const failed = previous.find((entry) => entry.stopFailed);
    if (failed) {
      await failed.stopPromise;
    }
    const ready = createDeferredCore<DesktopSessionStartResult>();
    void ready.promise.catch(() => undefined);
    const entry: DesktopSessionEntry = {
      sourceKey: request.sourceKey,
      ownerEpoch: request.ownerEpoch,
      ready,
      readySettled: false,
      observers: new Set(),
      observerReservations: new Set(),
      activities: new Set(),
      pendingStreams: new Map(),
    };
    entries.set(request.sourceKey, entry);
    owners.add(entry);
    entry.initialization = Promise.resolve().then(async () => {
      await stopEntries(previous, false);
      if (!isCurrent(entry)) {
        return;
      }
      // A replacement owns source resources only after its predecessor has drained.
      entry.teardown = request.teardown;
      entry.dispose = request.dispose;
      const result = await request.start(
        () => isCurrent(entry),
        () => stopEntry(entry),
      );
      if (!isCurrent(entry)) {
        return;
      }
      entry.readySettled = true;
      entry.ready.resolve(result);
    });
    void entry.initialization.catch((error: unknown) => {
      if (!entry.readySettled) {
        entry.readySettled = true;
        entry.ready.reject(error instanceof Error ? error : new Error("Desktop session failed"));
      }
      void stopEntry(entry);
    });
    return await waitForReady(entry);
  }

  async function acquire(
    request: DesktopSessionAcquireRequest,
  ): Promise<DesktopSessionAcquireResult> {
    const result = await startSession(request);
    if (!result) {
      throw new Error("Desktop session attachment is unavailable");
    }
    return result;
  }

  async function activate(request: DesktopSessionActivateRequest): Promise<void> {
    await startSession({ ...request, start: async () => undefined });
  }

  function attachObserver(sourceKey: string, observer: DesktopSessionObserver) {
    // A stale control token must never evict the controller of a newer owner.
    const entry = entryForOwner(sourceKey, observer.ownerEpoch);
    if (
      !entry?.readySettled ||
      entry.observers.size + entry.observerReservations.size >= MAX_OBSERVERS
    ) {
      return undefined;
    }
    clearTimeout(entry.lingerTimer);
    entry.lingerTimer = undefined;
    if (observer.control && entry.controller) {
      const previous = entry.controller;
      entry.observers.delete(previous);
      entry.controller = undefined;
      // WebSocket close reasons allow 123 UTF-8 bytes, including the takeover marker.
      const reason = observer.operatorName
        ? `control-taken:${observer.operatorName}`
        : "control-taken";
      closeObserver(previous, 4000, truncateUtf8Prefix(reason, 123));
    }
    const attached = { ...observer };
    entry.observers.add(attached);
    if (attached.control) {
      entry.controller = attached;
      notifyControl(entry);
    }
    return {
      release() {
        if (!entry.observers.delete(attached)) {
          return;
        }
        if (entry.controller === attached) {
          entry.controller = undefined;
          notifyControl(entry);
        }
        scheduleLinger(entry);
      },
    };
  }

  function takeControl(sourceKey: string, ownerEpoch: number): void {
    const entry = entries.get(sourceKey);
    const claimedEpoch = claimedOwnerEpochs.get(sourceKey);
    if (
      (entry && entry.ownerEpoch !== ownerEpoch) ||
      (claimedEpoch !== undefined && claimedEpoch !== ownerEpoch)
    ) {
      throw new DesktopSessionStaleOwnerError();
    }
    if (!entry || entry.stopPromise || !entry.controller) {
      return;
    }
    const previous = entry.controller;
    entry.observers.delete(previous);
    entry.controller = undefined;
    // The observer bridge retires input synchronously; the UI reconnects view-only.
    closeObserver(previous, 4000, "control-taken:Agent");
    notifyControl(entry);
    scheduleLinger(entry);
  }

  function reserveObserver(sourceKey: string, ownerEpoch: number) {
    const entry = entryForOwner(sourceKey, ownerEpoch);
    if (!entry || entry.observers.size + entry.observerReservations.size >= MAX_OBSERVERS) {
      return undefined;
    }
    return retain(entry, entry.observerReservations);
  }

  function createStream(params: { sourceKey: string; ownerEpoch: number; onStopped(): void }) {
    const controller = new AbortController();
    let ticket: { cancel(): void } | undefined;
    let invocation: Promise<unknown> | undefined;
    let reservation: ReturnType<typeof reserveObserver>;
    let attachment: ReturnType<typeof publishStream>;
    let stream: Duplex | undefined;
    let unclaimedTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const retire = () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearTimeout(unclaimedTimer);
      ticket?.cancel();
      controller.abort();
      if (!attachment) {
        reservation?.release();
      }
      stream?.destroy();
    };
    const stopStream = async () => {
      retire();
      await invocation?.catch(() => undefined);
      params.onStopped();
    };
    return {
      signal: controller.signal,
      get stopped() {
        return stopped;
      },
      reserve() {
        reservation = reserveObserver(params.sourceKey, params.ownerEpoch);
        return reservation !== undefined;
      },
      async connect<T extends { stream: Duplex }>(
        pending: { attached: Promise<T>; cancel(): void },
        invoke: () => Promise<{ error?: { message?: string } | null }>,
      ): Promise<T> {
        ticket = pending;
        const operation = invoke();
        invocation = operation;
        // A stream invocation settles only after its splice closes; it cannot signal readiness.
        const finished = operation.then((result) => {
          throw new Error(
            result.error?.message?.trim() || "node desktop stream closed before attachment",
          );
        });
        void finished.catch(() => undefined);
        void operation
          .finally(() => {
            retire();
            params.onStopped();
          })
          .catch(() => undefined);
        const attached = await Promise.race([pending.attached, finished]);
        stream = attached.stream;
        if (stopped) {
          stream.destroy();
        }
        return attached;
      },
      publish() {
        if (reservation && stream) {
          attachment = publishStream({ ...params, reservation, stream });
        }
        return attachment;
      },
      expireAt(expiresAtMs: number) {
        unclaimedTimer = setTimeout(
          () => {
            if (attachment && hasPendingStream(params.sourceKey, attachment)) {
              void stopStream();
            }
          },
          Math.max(0, expiresAtMs - Date.now()),
        );
        unclaimedTimer.unref?.();
      },
      stop: stopStream,
    };
  }

  function retain(entry: DesktopSessionEntry, consumers: Set<symbol>) {
    const activity = Symbol("desktop-consumer");
    consumers.add(activity);
    clearTimeout(entry.lingerTimer);
    entry.lingerTimer = undefined;
    return {
      isCurrent: () => isCurrent(entry) && consumers.has(activity),
      release() {
        if (consumers.delete(activity)) {
          scheduleLinger(entry);
        }
      },
    };
  }

  /** Keep an active desktop consumer alive independently of browser observers. */
  function retainActivity(sourceKey: string, ownerEpoch: number) {
    const entry = entryForOwner(sourceKey, ownerEpoch);
    return entry?.readySettled ? retain(entry, entry.activities) : undefined;
  }

  function publishStream(params: {
    sourceKey: string;
    ownerEpoch: number;
    stream: Duplex;
    reservation: NonNullable<ReturnType<typeof reserveObserver>>;
  }) {
    const entry = entryForOwner(params.sourceKey, params.ownerEpoch);
    if (
      !entry ||
      params.stream.destroyed ||
      params.stream.readableEnded ||
      params.stream.writableEnded
    ) {
      params.reservation.release();
      params.stream.destroy();
      return undefined;
    }
    const streamId = randomUUID();
    const pending = { stream: params.stream, reservation: params.reservation };
    entry.pendingStreams.set(streamId, pending);
    params.stream.once("close", () => {
      if (entry.pendingStreams.get(streamId) === pending) {
        entry.pendingStreams.delete(streamId);
        params.reservation.release();
      }
    });
    return { kind: "stream", streamId } as const;
  }

  function claimStream(sourceKey: string, attachment: { kind: "stream"; streamId: string }) {
    const entry = entries.get(sourceKey);
    const pending = entry?.pendingStreams.get(attachment.streamId);
    if (!entry || !pending) {
      return undefined;
    }
    entry.pendingStreams.delete(attachment.streamId);
    pending.reservation.release();
    const stream = pending.stream;
    if (stream.destroyed || stream.readableEnded || stream.writableEnded) {
      stream.destroy();
      return undefined;
    }
    return stream;
  }

  function hasPendingStream(sourceKey: string, attachment: { kind: "stream"; streamId: string }) {
    return entries.get(sourceKey)?.pendingStreams.has(attachment.streamId) ?? false;
  }

  function stop(sourceKey: string, ownerEpoch?: number): Promise<void> {
    return stopEntries(
      [...owners].filter(
        (entry) =>
          entry.sourceKey === sourceKey &&
          (ownerEpoch === undefined || ownerEpoch === entry.ownerEpoch),
      ),
    );
  }

  /**
   * Retires only owners strictly older than the claimant. An equal epoch shares the
   * session, so fencing must not tear down a peer that claimed the same generation.
   */
  function stopSuperseded(sourceKey: string, ownerEpoch: number): Promise<void> {
    return stopEntries(
      [...owners].filter((entry) => entry.sourceKey === sourceKey && entry.ownerEpoch < ownerEpoch),
    );
  }

  function stopAll(): Promise<void> {
    return stopEntries([...owners]);
  }

  return {
    acquire,
    activate,
    attachObserver,
    takeControl,
    claimStream,
    createStream,
    retainActivity,
    hasActivity: (sourceKey: string, ownerEpoch: number) => {
      const entry = entryForOwner(sourceKey, ownerEpoch);
      return Boolean(
        entry &&
        (entry.observers.size > 0 ||
          entry.observerReservations.size > 0 ||
          entry.activities.size > 0),
      );
    },
    hasController: (sourceKey: string, ownerEpoch: number) =>
      entryForOwner(sourceKey, ownerEpoch)?.controller !== undefined,
    onControlChanged: (
      sourceKey: string,
      ownerEpoch: number,
      changed: (controlled: boolean) => void,
    ) => {
      const listener = { sourceKey, ownerEpoch, changed };
      controlListeners.add(listener);
      return () => {
        controlListeners.delete(listener);
      };
    },
    claimOwnerEpoch,
    isOwnerEpochCurrent: (sourceKey: string, ownerEpoch: number) =>
      claimedOwnerEpochs.get(sourceKey) === ownerEpoch,
    stop,
    stopSuperseded,
    stopAll,
  };
}

export type DesktopSessionRegistry = ReturnType<typeof createDesktopSessionRegistry>;
