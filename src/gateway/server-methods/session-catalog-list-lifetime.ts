import type {
  SessionCatalog,
  SessionCatalogHost,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionCatalogListProviderParams } from "../../plugins/session-catalog.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../../process/gateway-work-admission.js";
import { captureAsyncWorkTracker } from "../../shared/async-work-scope.js";
import type { SessionCatalogInstances } from "./session-catalog-entry-snapshot.js";

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

/** The aggregate response can finish before the native host publications it owns. */
export class SessionCatalogListLifetime {
  private readonly controller = new AbortController();
  private readonly catalogIds: ReadonlySet<string>;
  private readonly subscribers = new Map<string, CatalogSubscriber>();
  private readonly publishers = new Set<() => void>();
  private readonly removeAbortListeners: Array<() => void> = [];
  private isCurrent: (() => boolean) | undefined;
  private listing = true;
  private pending = 0;
  private releaseRoot: (() => void) | undefined;

  constructor(
    isCurrent: () => boolean,
    signals: readonly AbortSignal[],
    catalogIds: readonly string[],
  ) {
    this.catalogIds = new Set(catalogIds);
    this.isCurrent = isCurrent;
    for (const signal of signals) {
      if (signal.aborted) {
        this.retire(signal.reason);
        break;
      }
      const retire = () => this.retire(signal.reason);
      signal.addEventListener("abort", retire, { once: true });
      this.removeAbortListeners.push(() => signal.removeEventListener("abort", retire));
    }
  }

  private active(): boolean {
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
    let publish = onHost;
    const controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, controller.signal]);
    let listing = true;
    let pending = 0;
    const releasePublisher = () => {
      publish = undefined;
      this.publishers.delete(releasePublisher);
    };
    this.publishers.add(releasePublisher);
    const settle = () => {
      pending -= 1;
      this.pending -= 1;
      if (!listing && pending === 0) {
        releasePublisher();
      }
      this.finish();
    };
    try {
      signal.throwIfAborted();
      // Completion callbacks can arrive from a different async context; both owners
      // belong to this listing, and finishListing releases zero-background lists.
      this.releaseRoot ??= retainGatewayRootWorkAdmissionContinuation() ?? undefined;
      return await run({
        signal,
        onHost: (host) => {
          if (this.active()) {
            publish?.(host);
          }
        },
        waitUntil: (completion) => {
          if (!listing) {
            throw new Error("Session catalog completion registration is closed");
          }
          // Retirement closes delivery, not accounting for work already started.
          // Join the publication finalizer before the Gateway releases its dependencies.
          pending += 1;
          this.pending += 1;
          void trackWork(() => completion.then(settle, settle));
        },
      });
    } catch (error) {
      releasePublisher();
      controller.abort(error);
      throw error;
    } finally {
      listing = false;
      if (pending === 0) {
        releasePublisher();
      }
    }
  }

  finishListing(): void {
    this.listing = false;
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
    this.releaseRoot?.();
    this.releaseRoot = undefined;
  }

  retire(reason?: unknown): void {
    // Clear captured clients and snapshots immediately, even when a producer ignores abort.
    this.isCurrent = undefined;
    for (const subscriber of this.subscribers.values()) {
      subscriber.remove();
    }
    this.releaseUnusedPublishers();
    for (const remove of this.removeAbortListeners.splice(0)) {
      remove();
    }
    this.controller.abort(reason);
  }
}
