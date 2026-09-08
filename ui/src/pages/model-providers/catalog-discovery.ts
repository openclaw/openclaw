// Demand-driven catalog discovery for the Models settings page.
//
// The initial page load uses the fast prepared catalog (configured models only)
// so full discovery stays out of first navigation. Opening a default-model picker
// signals interest; this controller fetches the full catalog through the shared
// model-catalog store (cooldown + concurrency dedupe) and merges it in without
// disturbing the saved selection.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";
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
  /** Resets in-flight/error state (e.g. on agent switch). */
  reset: () => void;
};

type CreateOptions = {
  getGateway: () => DiscoveryGateway;
  getScope: () => { agentId: string; agentEpoch: number };
  getData: () => ModelProvidersData | null;
  setData: (data: ModelProvidersData) => void;
  requestUpdate: () => void;
};

export function createCatalogDiscoveryController(
  options: CreateOptions,
): CatalogDiscoveryController {
  let discovering = false;
  let error: string | null = null;

  const controller: CatalogDiscoveryController = {
    get discovering() {
      return discovering;
    },
    get error() {
      return error;
    },
    openPicker() {
      void discover();
    },
    retry() {
      error = null;
      options.requestUpdate();
      void discover();
    },
    reset() {
      discovering = false;
      error = null;
    },
  };

  async function discover(): Promise<void> {
    const agentId = options.getScope().agentId;
    if (!agentId || discovering) {
      return;
    }
    const gateway = options.getGateway();
    const client = gateway.client;
    if (!gateway.connected || !client) {
      return;
    }
    const { agentEpoch } = options.getScope();
    const clientEpoch = gateway.epoch;
    const ownsResult = () =>
      gateway.isCurrent({ client, epoch: clientEpoch }) &&
      options.getScope().agentId === agentId &&
      options.getScope().agentEpoch === agentEpoch;
    discovering = true;
    error = null;
    options.requestUpdate();
    try {
      const result = await loadModelCatalog(client, { agentId, refreshIfDue: true });
      if (ownsResult() && result.models) {
        const data = options.getData();
        if (data) {
          options.setData({
            ...data,
            models: result.models,
            providerOutcomes: result.providerOutcomes ?? [],
          });
        }
      }
    } catch (failure) {
      if (ownsResult()) {
        error = formatUiError(failure, "request failed");
      }
    } finally {
      if (ownsResult()) {
        discovering = false;
        options.requestUpdate();
      }
    }
  }

  return controller;
}
