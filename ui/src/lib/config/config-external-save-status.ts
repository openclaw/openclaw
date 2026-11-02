import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ConfigExternalSaveStatus,
  RuntimeConfigExternalMutationOptions,
  RuntimeConfigExternalMutationResult,
} from "./config-gateway-operations.ts";
import { isCurrentConfigConnection, type RuntimeConfigState } from "./config-state-model.ts";

/** Lets a write outside the form draft report like any other edit: Saving, then Saved or
    failed. A failure recovers through that write's owner; the form draft has no part in it. */
export function createConfigExternalSaveStatus(state: RuntimeConfigState, publish: () => void) {
  let failed: ConfigExternalSaveStatus | null = null;
  return {
    track<T>(
      task: (client: GatewayBrowserClient) => Promise<T>,
      options: RuntimeConfigExternalMutationOptions<T>,
    ) {
      return (client: GatewayBrowserClient) => {
        if (options.saveStatus) {
          failed = null;
          state.lastError = null;
          state.configAutoSaveStatus = "saving";
          publish();
        }
        return task(client);
      };
    },
    settle<T>(
      result: RuntimeConfigExternalMutationResult<T>,
      options: RuntimeConfigExternalMutationOptions<T>,
      client: GatewayBrowserClient,
      connectionEpoch: number,
    ) {
      if (!options.saveStatus || !isCurrentConfigConnection(state, client, connectionEpoch)) {
        return;
      }
      if (result.ok) {
        state.configAutoSaveStatus = state.configFormDirty ? "idle" : "saved";
        if (!state.configFormDirty) {
          state.configSaveReceipts += 1;
        }
      } else if (result.reason === "unavailable" || result.reason === "suspended") {
        // Nothing was attempted; the caller reports why.
        state.configAutoSaveStatus = "idle";
      } else {
        state.lastError = result.error;
        state.configAutoSaveStatus = result.reason === "error" ? "error" : result.reason;
        failed = options.saveStatus;
      }
      publish();
    },
    /** Null when no independent write failed, so the form draft's own retry applies. */
    retry(): Promise<boolean> | null {
      if (!failed) {
        return null;
      }
      const { retry } = failed;
      failed = null;
      state.lastError = null;
      state.configAutoSaveStatus = "idle";
      publish();
      return retry().then(() => failed === null);
    },
    discard(clearPatches: () => void) {
      clearPatches();
      failed?.discard();
      failed = null;
    },
    clear() {
      failed = null;
    },
  };
}
