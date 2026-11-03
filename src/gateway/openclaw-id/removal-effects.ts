// Removal side effects (spec section 7, decided 2026-10-29): when a member or
// device key is removed, its relayed Gateway connections are found (open ones and
// closed ones whose runs are unsettled), its queued and running runs are cancelled
// through the ordinary Stop path (which keeps the transcript up to the cut), its
// open connections are closed and its device tokens revoked.
import { revokeDeviceToken } from "../../infra/device-pairing-tokens.js";
import {
  getRpcSourceIdentity,
  listRpcSourceEntries,
  resolveRpcSourceSessionProgressState,
} from "../../sessions/session-controller.rpc-sources.js";
import { dispatchGatewayRequestInProcess } from "../server-in-process-dispatch.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { invalidateGatewayPolicyClient } from "../server/ws-policy-close.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import type { OpenClawIdEffects } from "./service.js";
import {
  openclawIdTunnelConnectionsOf,
  setOpenClawIdRunOwnerConnections,
} from "./tunnel-connections.js";

type EffectsLogger = { warn: (message: string) => void };

// Connection ids that still own a registered (queued or running) run source.
function runOwnerConnections(): Set<string> {
  const owners = new Set<string>();
  for (const [, ref] of listRpcSourceEntries()) {
    const owner = ref.adapter.requester?.connectionId;
    if (owner) {
      owners.add(owner);
    }
  }
  return owners;
}

/** Builds the effects over the Gateway's live client registry and request context. */
export function createOpenClawIdRemovalEffects(params: {
  clients: () => Iterable<GatewayWsClient>;
  context: () => GatewayRequestContext;
  log: EffectsLogger;
}): OpenClawIdEffects {
  const byConnection = new Map<string, GatewayWsClient>();
  setOpenClawIdRunOwnerConnections(runOwnerConnections);
  return {
    captureConnections(peerKeys) {
      const ids = new Set<string>();
      for (const client of params.clients()) {
        const peerKey = client.internal?.openclawIdPeerKey;
        if (peerKey && peerKeys.includes(peerKey)) {
          ids.add(client.connId);
          byConnection.set(client.connId, client);
        }
      }
      // Runs outlive their socket: earlier connections of these keys still own runs.
      for (const id of openclawIdTunnelConnectionsOf(peerKeys)) {
        ids.add(id);
      }
      return [...ids];
    },

    async cancelRuns(connectionIds) {
      const context = params.context();
      // An internal admin Stop, like an operator pressing Stop on each run.
      const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
      let cancelled = 0;
      for (const [runId, ref] of listRpcSourceEntries()) {
        const owner = ref.adapter.requester?.connectionId;
        // Queued input is withdrawn too, so nothing the member sent starts later.
        if (
          !owner ||
          !connectionIds.includes(owner) ||
          resolveRpcSourceSessionProgressState(ref) === undefined
        ) {
          continue;
        }
        const { sessionKey } = getRpcSourceIdentity(ref);
        try {
          await dispatchGatewayRequestInProcess(
            "chat.abort",
            { sessionKey, runId },
            { context, client },
          );
          cancelled += 1;
        } catch (error) {
          params.log.warn(`openclaw-id: could not cancel run ${runId}: ${String(error)}`);
        }
      }
      return cancelled;
    },

    closeConnections(connectionIds) {
      for (const id of connectionIds) {
        const client = byConnection.get(id);
        byConnection.delete(id);
        if (client) {
          invalidateGatewayPolicyClient(client, {
            reason: "openclaw-id-removed",
            code: 1008,
            message: "removed from this claw",
          });
        }
      }
    },

    async revokeDeviceTokens(tokens) {
      for (const token of tokens) {
        try {
          await revokeDeviceToken({ deviceId: token.deviceId, role: token.role });
        } catch (error) {
          params.log.warn(`openclaw-id: could not revoke a device token: ${String(error)}`);
        }
      }
    },
  };
}
