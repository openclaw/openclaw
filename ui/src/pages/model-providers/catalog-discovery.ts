// Demand-driven catalog discovery for the Models settings page.
//
// The initial page load uses the fast prepared catalog
// so full discovery stays out of first navigation. Opening a default-model picker
// signals interest; the first open for this core-data snapshot and explicit retries
// refresh the Gateway-owned catalog. Completed reopens read its current publication.
// Pending opens share this page's request without disturbing the saved selection.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { loadModelCatalog, modelCatalogRefreshError } from "../../lib/model-catalog-store.ts";
import type { ModelProvidersData } from "./load.ts";

type DiscoveryGateway = {
  connected: boolean;
  client: GatewayBrowserClient | null;
  epoch: number;
  isCurrent: (params: { client: GatewayBrowserClient; epoch: number }) => boolean;
};

export type CatalogDiscoveryController = {
  /** Whether a discovery request is currently in flight. */
  readonly discovering: boolean;
  /** A user-facing retry hint when discovery failed; null while clean. */
  readonly error: string | null;
  /** Fired when a default-model picker opens. */
  openPicker: () => void;
  /** Retries a failed discovery. */
  retry: () => void;
  /** Resets request history and pending/error state when core data or its owner changes. */
  reset: () => void;
};

type CreateOptions = {
  getGateway: () => DiscoveryGateway;
  getAgentId: () => string;
  getAgentEpoch: () => number;
  getData: () => ModelProvidersData | null;
  setData: (data: ModelProvidersData) => void;
  requestUpdate: () => void;
};

export function createCatalogDiscoveryController(
  options: CreateOptions,
): CatalogDiscoveryController {
  let pending: AbortController | null = null;
  let error: string | null = null;
  let requestedDiscovery = false;

  const controller: CatalogDiscoveryController = {
    get discovering() {
      return pending !== null;
    },
    get error() {
      return error;
    },
    openPicker() {
      void discover(!requestedDiscovery);
    },
    retry() {
      void discover(true);
    },
    reset() {
      const retired = pending;
      pending = null;
      error = null;
      requestedDiscovery = false;
      retired?.abort();
      options.requestUpdate();
    },
  };

  async function discover(refresh: boolean): Promise<void> {
    const agentId = options.getAgentId();
    if (!agentId || pending) {
      return;
    }
    const gateway = options.getGateway();
    const client = gateway.client;
    if (!gateway.connected || !client) {
      return;
    }
    const agentEpoch = options.getAgentEpoch();
    const clientEpoch = gateway.epoch;
    const request = new AbortController();
    const ownsResult = () =>
      pending === request &&
      gateway.isCurrent({ client, epoch: clientEpoch }) &&
      options.getAgentId() === agentId &&
      options.getAgentEpoch() === agentEpoch;
    pending = request;
    error = null;
    requestedDiscovery = true;
    options.requestUpdate();
    try {
      const result = await loadModelCatalog(client, {
        agentId,
        ...(refresh ? { refresh: true } : {}),
        signal: request.signal,
      });
      if (ownsResult()) {
        error = modelCatalogRefreshError(result, t("modelProviders.defaults.discoverFailed"));
        const data = options.getData();
        if (data) {
          options.setData({
            ...data,
            models: result.models,
            providerOutcomes: result.providerOutcomes ?? [],
            catalogError: null,
          });
        }
      }
    } catch (failure) {
      if (ownsResult()) {
        error = formatUiError(failure, "request failed");
      }
    } finally {
      if (pending === request) {
        pending = null;
        options.requestUpdate();
      }
    }
  }

  return controller;
}
