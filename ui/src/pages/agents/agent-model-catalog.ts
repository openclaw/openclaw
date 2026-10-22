import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { isGatewayAvailable } from "../../lib/gateway-availability.ts";
import { ModelCatalogReader } from "../../lib/model-catalog-reader.ts";
import { modelCatalogRefreshError, readAgentModelCatalog } from "../../lib/model-catalog-store.ts";

type AgentModelCatalogState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  agentsSelectedId: string | null;
  chatModelCatalogRead: Promise<void> | null;
};

/** Owns the selected agent's catalog receipt and recovery after Gateway suspension. */
export function createAgentModelCatalog(
  context: Pick<ApplicationContext, "gateway">,
  state: AgentModelCatalogState,
  publish: () => void,
) {
  let recoveryPending = false;
  let needsRecovery = false;
  const reader = new ModelCatalogReader(publish, {
    onRead: (read) => {
      const completion = read.then((result) => {
        const error = result && modelCatalogRefreshError(result);
        if (error) {
          throw new Error(error);
        }
      });
      // The notice can be absent while another agent panel is selected.
      void completion.catch(() => undefined);
      state.chatModelCatalogRead = completion;
    },
    onResult: (result) => settle(Boolean(modelCatalogRefreshError(result))),
    onError: () => settle(true),
  });

  function settle(failed: boolean) {
    needsRecovery = failed;
    if (recoveryPending) {
      recoveryPending = false;
      recover();
    }
  }

  function recover() {
    if (isGatewayAvailable(context.gateway.snapshot) && needsRecovery) {
      ensure({ refresh: true });
    }
  }

  function ensure(options: { refresh?: boolean } = {}) {
    const agentId = state.agentsSelectedId;
    if (!state.client || !state.connected || !agentId) {
      return;
    }
    if (reader.bind(context.gateway, { agentId })) {
      needsRecovery = false;
      state.chatModelCatalogRead = null;
    }
    if (!reader.pending && (options.refresh || !state.chatModelCatalogRead || reader.failed)) {
      void reader.read();
    }
  }

  return {
    ensure,
    read: () =>
      readAgentModelCatalog(state.connected ? state.client : null, state.agentsSelectedId),
    onAvailable() {
      if (reader.pending) {
        recoveryPending = true;
      } else {
        recover();
      }
    },
    reset() {
      reader.clear();
      recoveryPending = false;
      needsRecovery = false;
      state.chatModelCatalogRead = null;
    },
  };
}
