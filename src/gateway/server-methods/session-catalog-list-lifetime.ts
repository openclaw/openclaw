import type {
  SessionCatalog,
  SessionCatalogHost,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionCatalogListProviderParams } from "../../plugins/session-catalog.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../../process/gateway-work-admission.js";
import { captureAsyncWorkTracker } from "../../shared/async-work-scope.js";
import type { SessionCatalogInstances } from "./session-catalog-entry-snapshot.js";

export const SESSION_CATALOG_LIST_LIFETIME_MS = 60_000;

export type CatalogListProgressSubscriber = (
  catalog: SessionCatalog,
  instances: SessionCatalogInstances,
) => void;

type CatalogPublication = { catalog: SessionCatalog; instances: SessionCatalogInstances };
type CatalogSubscriber = {
  current?: {
    publish: CatalogListProgressSubscriber;
    isCurrent: () => boolean;
    prepare?: () => Promise<void> | undefined;
    signal?: AbortSignal;
    trackWork: ReturnType<typeof captureAsyncWorkTracker>;
  };
  queued: Map<string, Map<string, CatalogPublication>>;
  preparing: boolean;
  remove: () => void;
};

// Native work still owns its admitted resources after delivery expires.
class CatalogListWork {
  private pending = 0;
  private listing = true;
  private releaseRoot: (() => void) | undefined;

  begin(retainRoot = false): void {
    this.pending++;
    if (retainRoot) {
      this.releaseRoot ??= retainGatewayRootWorkAdmissionContinuation() ?? undefined;
    }
  }

  end(): void {
    this.pending--;
    this.finish();
  }

  finishListing(): void {
    this.listing = false;
    this.finish();
  }

  private finish(): void {
    if (!this.listing && this.pending === 0) {
      this.releaseRoot?.();
      this.releaseRoot = undefined;
    }
  }
}

// Keep raw completion reactions outside the provider frame so a hung promise
// cannot retain its request captures after the delivery callback is detached.
function trackCatalogCompletion(
  completion: Promise<void>,
  work: CatalogListWork,
  trackWork: ReturnType<typeof captureAsyncWorkTracker>,
  signal: AbortSignal,
  settled: () => void,
): void {
  work.begin();
  let delivery: { signal: AbortSignal; settled: () => void } | undefined = { signal, settled };
  const close = () => {
    const current = delivery;
    // Abort reasons can retain request frames through Error stacks.
    delivery = undefined;
    current?.signal.removeEventListener("abort", close);
    current?.settled();
  };
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) {
    close();
  }
  const finish = () => {
    work.end();
    close();
  };
  void trackWork(() => completion.then(finish, finish));
}

function createProviderCallbacks(
  onHost: ((host: SessionCatalogHost) => void) | undefined,
  registerCompletion: ((completion: Promise<void>) => void) | undefined,
) {
  let publish = onHost;
  let register = registerCompletion;
  return {
    onHost: (host: SessionCatalogHost) => publish?.(host),
    waitUntil: (completion: Promise<void>) => {
      if (!register) {
        throw new Error("Session catalog completion registration is closed");
      }
      register(completion);
    },
    releasePublisher: () => {
      publish = undefined;
    },
    closeRegistration: () => {
      register = undefined;
    },
  };
}

/** The aggregate response can finish before the native host publications it owns. */
export class SessionCatalogListLifetime {
  private readonly controller = new AbortController();
  private readonly catalogIds: ReadonlySet<string>;
  private readonly subscribers = new Map<string, CatalogSubscriber>();
  private readonly publishers = new Set<() => void>();
  private removeAbortListener: (() => void) | undefined;
  private isCurrent: (() => boolean) | undefined;
  private listing = true;
  private pending = 0;
  private readonly work = new CatalogListWork();
  private readonly deadline: ReturnType<typeof setTimeout>;
  private readonly sourceSignal: AbortSignal;

  constructor(
    isCurrent: () => boolean,
    signals: readonly AbortSignal[],
    catalogIds: readonly string[],
  ) {
    this.catalogIds = new Set(catalogIds);
    this.isCurrent = isCurrent;
    // This bounds delivery captures, not custody of native work that ignores abort.
    this.deadline = setTimeout(
      () => this.retire(new Error("Session catalog list expired")),
      SESSION_CATALOG_LIST_LIFETIME_MS,
    );
    this.deadline.unref();
    const signal = (this.sourceSignal = AbortSignal.any([...signals]));
    const retire = () => this.retire(signal.reason);
    this.removeAbortListener = () => signal.removeEventListener("abort", retire);
    signal.addEventListener("abort", retire, { once: true });
    if (signal.aborted) {
      retire();
    }
  }

  private active(): boolean {
    if (this.sourceSignal.aborted) {
      this.retire(this.sourceSignal.reason);
      return false;
    }
    try {
      if (this.isCurrent?.()) {
        return true;
      }
    } catch {
      // A lost context is retirement, never permission to use a successor.
    }
    this.retire();
    return false;
  }

  readonly assertCurrent = (): void => {
    this.active();
    this.controller.signal.throwIfAborted();
  };

  subscribe(
    key: string,
    publish: CatalogListProgressSubscriber,
    isCurrent: () => boolean,
    signal?: AbortSignal,
    prepare?: () => Promise<void> | undefined,
  ): void {
    this.subscribers.get(key)?.remove();
    if (!this.active() || signal?.aborted || !isCurrent()) {
      return;
    }
    const subscriber: CatalogSubscriber = {
      current: { publish, isCurrent, prepare, signal, trackWork: captureAsyncWorkTracker() },
      queued: new Map(),
      preparing: false,
      remove: () => {
        subscriber.current?.signal?.removeEventListener("abort", subscriber.remove);
        subscriber.current = undefined;
        subscriber.queued.clear();
        this.subscribers.delete(key);
        this.releaseUnusedPublishers();
      },
    };
    this.subscribers.set(key, subscriber);
    signal?.addEventListener("abort", subscriber.remove, { once: true });
  }

  publish(catalog: SessionCatalog, instances: SessionCatalogInstances): void {
    if (!this.active() || !this.catalogIds.has(catalog.id)) {
      return;
    }
    for (const [key, subscriber] of this.subscribers) {
      if (!this.currentSubscriber(key, subscriber)) {
        subscriber.remove();
        continue;
      }
      // Retain one frame per selected catalog/observed host, independent of update churn.
      const hosts = subscriber.queued.get(catalog.id) ?? new Map<string, CatalogPublication>();
      for (const host of catalog.hosts) {
        hosts.set(host.hostId, { catalog: { ...catalog, hosts: [host] }, instances });
      }
      if (hosts.size) {
        subscriber.queued.set(catalog.id, hosts);
      }
      if (!subscriber.preparing) {
        this.deliverSubscriber(key, subscriber);
      }
    }
  }

  private currentSubscriber(key: string, subscriber: CatalogSubscriber): boolean {
    return (
      this.subscribers.get(key) === subscriber &&
      this.active() &&
      subscriber.current?.isCurrent() === true
    );
  }

  private deliverSubscriber(key: string, subscriber: CatalogSubscriber): void {
    while (!subscriber.preparing && this.currentSubscriber(key, subscriber)) {
      const current = subscriber.current;
      if (!current) {
        return;
      }
      const preparation = current.prepare?.();
      if (preparation) {
        subscriber.preparing = true;
        this.pending++;
        this.work.begin();
        void current.trackWork(() =>
          this.deliverPreparedSubscriber(key, subscriber, preparation).catch(() => undefined),
        );
        return;
      }
      const publication = this.takeQueuedPublication(subscriber);
      if (!publication) {
        return;
      }
      current.publish(publication.catalog, publication.instances);
    }
  }

  private takeQueuedPublication(subscriber: CatalogSubscriber): CatalogPublication | undefined {
    for (const [catalogId, hosts] of subscriber.queued) {
      const next = hosts.entries().next().value;
      if (next) {
        hosts.delete(next[0]);
      }
      if (!hosts.size) {
        subscriber.queued.delete(catalogId);
      }
      if (next) {
        return next[1];
      }
    }
    return undefined;
  }

  private async deliverPreparedSubscriber(
    key: string,
    subscriber: CatalogSubscriber,
    preparation: Promise<void>,
  ): Promise<void> {
    try {
      await preparation;
      while (this.currentSubscriber(key, subscriber)) {
        const next = subscriber.current?.prepare?.();
        if (next) {
          await next;
          continue;
        }
        const publication = this.takeQueuedPublication(subscriber);
        if (!publication) {
          return;
        }
        subscriber.current?.publish(publication.catalog, publication.instances);
      }
    } finally {
      subscriber.queued.clear();
      subscriber.preparing = false;
      this.pending--;
      this.work.end();
      this.finish();
    }
  }

  async runProvider<T>(
    onHost: ((host: SessionCatalogHost) => void) | undefined,
    run: (
      params: Required<Pick<SessionCatalogListProviderParams, "onHost" | "waitUntil" | "signal">>,
    ) => Promise<T>,
  ): Promise<T> {
    const trackWork = captureAsyncWorkTracker();
    const controller = new AbortController();
    const signal = AbortSignal.any([this.sourceSignal, this.controller.signal, controller.signal]);
    let listing = true;
    let pending = 0;
    const releasePublisher = () => {
      callbacks.releasePublisher();
      this.publishers.delete(releasePublisher);
    };
    this.publishers.add(releasePublisher);
    this.pending += 1;
    this.work.begin(true);
    const settle = () => {
      pending -= 1;
      this.pending -= 1;
      if (!listing && pending === 0) {
        releasePublisher();
      }
      this.finish();
    };
    const callbacks = createProviderCallbacks(
      (host) => {
        if (this.active()) {
          onHost?.(host);
        }
      },
      (completion) => {
        pending += 1;
        this.pending += 1;
        trackCatalogCompletion(completion, this.work, trackWork, signal, settle);
      },
    );
    try {
      signal.throwIfAborted();
      return await trackWork(() =>
        run({ signal, onHost: callbacks.onHost, waitUntil: callbacks.waitUntil }),
      );
    } catch (error) {
      releasePublisher();
      controller.abort(error);
      throw error;
    } finally {
      listing = false;
      callbacks.closeRegistration();
      this.pending -= 1;
      this.work.end();
      if (pending === 0) {
        releasePublisher();
      }
      this.finish();
    }
  }

  finishListing(): void {
    this.listing = false;
    // Node retains composites with listeners. Native producers receive the
    // source signal directly so response cleanup does not cancel their work.
    this.removeAbortListener?.();
    this.removeAbortListener = undefined;
    this.work.finishListing();
    this.releaseUnusedPublishers();
    this.finish();
  }

  private releaseUnusedPublishers(): void {
    // Active lists can gain followers; settled lists cannot. Retirement clears every capture.
    if (this.isCurrent && (this.listing || this.subscribers.size > 0)) {
      return;
    }
    for (const release of this.publishers) {
      release();
    }
  }

  private finish(): void {
    if (this.listing || this.pending > 0) {
      return;
    }
    this.retire();
  }

  retire(reason?: unknown): void {
    clearTimeout(this.deadline);
    // Clear captured clients and snapshots immediately, even when a producer ignores abort.
    this.isCurrent = undefined;
    for (const subscriber of this.subscribers.values()) {
      subscriber.remove();
    }
    this.releaseUnusedPublishers();
    this.removeAbortListener?.();
    this.removeAbortListener = undefined;
    this.controller.abort(reason);
  }
}
