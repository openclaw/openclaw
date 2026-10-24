import { createProjection, createSignal } from "solid-js";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { isMissingOperatorReadScopeError } from "../../lib/gateway-errors.ts";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import {
  canReadSystemInfo,
  readSystemInfo,
  SYSTEM_INFO_POLL_INTERVAL_MS,
} from "../../lib/system-info.ts";

/** Appearance samples admit observer model reads; their request lifetime stays together. */
export function createConfigPageModels(options: {
  invalidate: () => void;
  gateway: () => ApplicationGateway;
  active: () => boolean;
  selectedAgent: () => string | null;
}) {
  // Admission stays synchronous; Solid consumes only the admitted read's result.
  const [modelsRead, setModelsRead] = createSignal<
    Promise<ModelCatalogEntry[] | undefined> | null | undefined
  >(undefined, { ownedWrite: true });
  const sessionObserverModels = createProjection<ModelCatalogEntry[]>(
    () => {
      const read = modelsRead();
      return read === null ? [] : read;
    },
    [],
    { key: (model: ModelCatalogEntry) => `${model.provider}/${model.id}` },
  );
  let modelsRequest: AbortController | null = null;
  let modelsAgent: string | null = null;
  let scope: object | null = null;
  let unavailable = false;
  let systemInfo: SystemInfoResult | null = null;
  let systemInfoUnavailable = false;
  let poll: ReturnType<typeof setInterval> | undefined;

  function requestClient(): GatewayBrowserClient | null {
    const snapshot = options.gateway().snapshot;
    return options.active() &&
      document.visibilityState !== "hidden" &&
      !systemInfoUnavailable &&
      canReadSystemInfo(snapshot)
      ? snapshot.client
      : null;
  }

  function startPolling() {
    clearInterval(poll);
    poll = setInterval(() => void refreshStatus(), SYSTEM_INFO_POLL_INTERVAL_MS);
  }

  const statusRequest = createPageRequest(options.invalidate, {
    task: async (client: GatewayBrowserClient, { signal }) => {
      const sample = await readSystemInfo(options.gateway(), signal);
      return requestClient() === client ? sample : null;
    },
    onComplete: (sample) => {
      if (sample) {
        systemInfo = sample.value;
        startPolling();
        refreshModels(true);
      }
    },
    onError: (error) => {
      if (isMissingOperatorReadScopeError(error)) {
        systemInfo = null;
        systemInfoUnavailable = true;
      }
    },
  });

  function refreshStatus() {
    const client = requestClient();
    return client && !statusRequest.pending ? statusRequest.run(client) : Promise.resolve();
  }

  function cancelModels() {
    const previous = modelsRequest;
    modelsRequest = null;
    previous?.abort();
    // Hidden/retained pages keep the last accepted options without holding a read open.
    setModelsRead(undefined);
  }

  function refreshModels(force = false) {
    const client = systemInfo !== null ? requestClient() : null;
    const agentId = options.selectedAgent();
    if (!client || !agentId) {
      cancelModels();
      setModelsRead(null);
      unavailable = !agentId;
      return;
    }
    if (modelsAgent === agentId && (modelsRequest || !force)) {
      return;
    }
    const changed = modelsAgent !== agentId;
    modelsAgent = agentId;
    cancelModels();
    if (changed) {
      scope = {};
      unavailable = false;
    }
    const request = new AbortController();
    modelsRequest = request;
    const read = loadModelCatalog(client, { agentId, preparedOnly: true, signal: request.signal })
      .then(({ models }) =>
        modelsRequest === request &&
        requestClient() === client &&
        options.selectedAgent() === agentId
          ? models
          : undefined,
      )
      .catch((error: unknown) => {
        if (modelsRequest === request) {
          throw error;
        }
        return undefined;
      });
    void setModelsRead(read);
    options.invalidate();
    const settled = () => {
      if (modelsRequest === request) {
        modelsRequest = null;
      }
    };
    // The boundary owns failure presentation; every admitted read settles even without a view.
    void read.then(settled, settled);
  }

  return {
    models: sessionObserverModels,
    get scope() {
      return scope;
    },
    get unavailable() {
      return unavailable;
    },
    get resolvedModel() {
      return systemInfo?.defaultAgentUtilityModel;
    },
    refreshStatus,
    synchronize() {
      if (!requestClient()) {
        clearInterval(poll);
        poll = undefined;
        statusRequest.cancel();
        cancelModels();
      } else if (!systemInfo || !poll) {
        startPolling();
        void refreshStatus();
      } else {
        refreshModels();
      }
    },
    retire() {
      // Same-page route edits retire reads without resetting the polling cadence.
      if (!options.active()) {
        clearInterval(poll);
        poll = undefined;
      }
      statusRequest.cancel();
      cancelModels();
      modelsAgent = null;
    },
    reset() {
      systemInfo = null;
      systemInfoUnavailable = false;
      setModelsRead(null);
      scope = null;
      unavailable = false;
    },
  };
}
