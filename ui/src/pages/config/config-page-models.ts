import { createProjection, createSignal } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";

export function createConfigPageModels(options: {
  invalidate: () => void;
  requestClient: () => GatewayBrowserClient | null;
  hasSystemInfo: () => boolean;
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

  function cancel() {
    const previous = modelsRequest;
    modelsRequest = null;
    previous?.abort();
    // Hidden/retained pages keep the last accepted options without holding a read open.
    setModelsRead(undefined);
  }

  function refresh(force = false) {
    const client = options.hasSystemInfo() ? options.requestClient() : null;
    const agentId = options.selectedAgent();
    if (!client || !agentId) {
      cancel();
      setModelsRead(null);
      unavailable = !agentId;
      return;
    }
    if (modelsAgent === agentId && (modelsRequest || !force)) {
      return;
    }
    const changed = modelsAgent !== agentId;
    modelsAgent = agentId;
    cancel();
    if (changed) {
      scope = {};
      unavailable = false;
    }
    const request = new AbortController();
    modelsRequest = request;
    const read = loadModelCatalog(client, { agentId, preparedOnly: true, signal: request.signal })
      .then(({ models }) =>
        modelsRequest === request &&
        options.requestClient() === client &&
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
    cancel,
    refresh,
    retire() {
      cancel();
      modelsAgent = null;
    },
    reset() {
      setModelsRead(null);
      scope = null;
      unavailable = false;
    },
  };
}
