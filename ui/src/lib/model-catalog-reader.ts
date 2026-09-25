import type { GatewayProtocolRequestOptions } from "@openclaw/gateway-client/browser";
import type { ModelCatalogResult } from "../api/types.ts";
import type { ApplicationGateway } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import {
  isModelCatalogRetired,
  modelCatalogKey,
  modelCatalogParams,
  type ModelCatalogReadScope,
} from "./model-catalog-cache.ts";
import {
  loadModelCatalog,
  peekModelCatalog,
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
    presentationKey: number;
  };
  private controller?: AbortController;
  private unsubscribe?: () => void;
  pending = false;
  failed = false;

  constructor(
    private readonly notify: () => void,
    private readonly options: {
      timeoutMs?: GatewayProtocolRequestOptions["timeoutMs"];
      onResult?: (result: ModelCatalogResult) => void;
      onError?: () => void;
    } = {},
  ) {}

  get snapshot(): ModelCatalogPresentation {
    const binding = this.binding;
    if (!binding || !this.owns(binding)) {
      return { models: [], hasSnapshot: false, retired: false };
    }
    const result = peekModelCatalog(binding.client, binding.scope, { allowStale: true });
    return {
      ...result,
      models: result?.models ?? [],
      hasSnapshot: result !== undefined,
      retired: isModelCatalogRetired(binding.client, binding.scope),
    };
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
      presentationKey: gatewayPresentationScope(gateway).key,
    };
    this.binding = binding;
    const unwatchCache = subscribeModelCatalogCache(client, () => {
      if (!this.owns(binding)) {
        return;
      }
      if (this.failed && peekModelCatalog(client, scope)) {
        this.failed = false;
      }
      this.notify();
    });
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
      binding.gateway.snapshot.phase === "connected" &&
      gatewayPresentationScope(binding.gateway).key === binding.presentationKey
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
      this.pending = false;
      this.failed = false;
      this.options.onResult?.(cached);
      this.notify();
      return Promise.resolve(cached);
    }
    const controller = new AbortController();
    this.controller = controller;
    this.pending = true;
    this.failed = false;
    this.notify();
    return loadModelCatalog(binding.client, {
      ...binding.scope,
      signal: controller.signal,
      timeoutMs: this.options.timeoutMs,
    }).then(
      (result) => {
        if (!this.owns(binding) || this.controller !== controller) {
          return undefined;
        }
        this.controller = undefined;
        this.pending = false;
        this.options.onResult?.(result);
        this.notify();
        return result;
      },
      () => {
        if (!this.owns(binding) || this.controller !== controller) {
          return undefined;
        }
        this.controller = undefined;
        this.pending = false;
        this.failed = true;
        this.options.onError?.();
        this.notify();
        return undefined;
      },
    );
  }

  clear(): void {
    this.binding = undefined;
    this.controller?.abort();
    this.controller = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.pending = false;
    this.failed = false;
  }
}
