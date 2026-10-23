import type { GatewayProtocolRequestOptions } from "@openclaw/gateway-client/browser";
import type { ModelCatalogResult } from "../api/types.ts";
import type { ApplicationGateway } from "../app/context.ts";
import {
  modelCatalogKey,
  modelCatalogParams,
  type ModelCatalogReadScope,
} from "./model-catalog-cache.ts";
import {
  loadModelCatalog,
  peekModelCatalog,
  readModelCatalog,
  subscribeModelCatalogCache,
  subscribeModelCatalogChanges,
  type ModelCatalogPresentation,
} from "./model-catalog-store.ts";

/** A view's subscription and request lifetime; display rows remain owned by the catalog cache. */
export class ModelCatalogReader {
  private binding?: {
    gateway: ApplicationGateway;
    client: NonNullable<ApplicationGateway["snapshot"]["client"]>;
    scope: ModelCatalogReadScope;
  };
  private controller?: AbortController;
  private unsubscribe?: () => void;
  failed = false;

  constructor(
    private readonly notify: () => void,
    private readonly options: {
      timeoutMs?: GatewayProtocolRequestOptions["timeoutMs"];
      onResult?: (result: ModelCatalogResult) => void;
      /** Observes admitted reads, including event refreshes; current failures reject. */
      onRead?: (read: Promise<ModelCatalogResult | undefined>) => void;
      onError?: (error: unknown) => void;
    } = {},
  ) {}

  get pending(): boolean {
    return this.controller !== undefined;
  }

  get snapshot(): ModelCatalogPresentation {
    const binding = this.binding;
    return readModelCatalog(binding && this.owns(binding) ? binding.client : null, binding?.scope);
  }

  bind(gateway: ApplicationGateway, scope: ModelCatalogReadScope): boolean {
    const client = gateway.snapshot.client;
    const current = this.binding;
    if (
      current &&
      this.owns(current) &&
      current.gateway === gateway &&
      modelCatalogKey(modelCatalogParams(current.scope)) ===
        modelCatalogKey(modelCatalogParams(scope))
    ) {
      return false;
    }
    this.clear();
    if (!client) {
      return false;
    }
    const binding = {
      gateway,
      client,
      scope,
    };
    this.binding = binding;
    const unwatchCache = subscribeModelCatalogCache(
      client,
      () => {
        if (!this.owns(binding)) {
          return;
        }
        if (this.failed && peekModelCatalog(client, scope)) {
          this.failed = false;
        }
        this.notify();
      },
      () => scope,
    );
    const unwatchEvents = subscribeModelCatalogChanges(
      gateway,
      () => {
        if (this.owns(binding)) {
          void this.read();
        } else {
          this.notify();
        }
      },
      scope,
    );
    this.unsubscribe = () => {
      unwatchCache();
      unwatchEvents();
    };
    return true;
  }

  private owns(binding: NonNullable<ModelCatalogReader["binding"]>): boolean {
    return (
      this.binding === binding &&
      binding.gateway.snapshot.client === binding.client &&
      binding.gateway.snapshot.phase === "connected"
    );
  }

  read(): Promise<ModelCatalogResult | undefined> {
    const binding = this.binding;
    if (!binding || !this.owns(binding)) {
      return Promise.resolve(undefined);
    }
    this.controller?.abort();
    this.controller = undefined;
    const cached = peekModelCatalog(binding.client, binding.scope);
    if (cached) {
      this.failed = false;
      this.options.onResult?.(cached);
      const read = Promise.resolve(cached);
      this.options.onRead?.(read);
      this.notify();
      return read;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.failed = false;
    const read = loadModelCatalog(binding.client, {
      ...binding.scope,
      signal: controller.signal,
      timeoutMs: this.options.timeoutMs,
    }).then(
      (result) => {
        if (!this.owns(binding) || this.controller !== controller) {
          return undefined;
        }
        this.controller = undefined;
        this.options.onResult?.(result);
        this.notify();
        return result;
      },
      (error: unknown) => {
        if (!this.owns(binding) || this.controller !== controller) {
          return undefined;
        }
        this.controller = undefined;
        this.failed = true;
        this.options.onError?.(error);
        this.notify();
        if (this.options.onRead) {
          throw error;
        }
        return undefined;
      },
    );
    this.options.onRead?.(read);
    this.notify();
    // Existing callers consume errors through onError; observers also receive the rejection.
    return this.options.onRead ? read.catch(() => undefined) : read;
  }

  clear(): void {
    this.binding = undefined;
    this.controller?.abort();
    this.controller = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.failed = false;
  }
}
