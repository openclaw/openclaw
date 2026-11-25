import { validateModelsAuthRefreshParams } from "../../../packages/gateway-protocol/src/index.js";
import {
  ErrorCodes,
  errorShape,
} from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../agents/auth-profiles/runtime-snapshots.js";
import { updateAuthProfileStoreWithLock } from "../../agents/auth-profiles/store-runtime.js";
import { isSharedMainAuthProfileAgentDir } from "../../agents/auth-profiles/store.js";
import { clearTransientCooldowns } from "../../agents/auth-profiles/usage-state.js";
import { refreshModelAuthStateAfterMutation } from "../model-auth-refresh.js";
import { resolveModelAuthAgentScope } from "./model-auth-agent-scope.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

export const modelsAuthRefreshHandlers: GatewayRequestHandlers = {
  "models.authRefresh": defineValidatedGatewayHandler(
    "models.authRefresh",
    validateModelsAuthRefreshParams,
    async ({ params, respond, context }) => {
      const config = context.getRuntimeConfig();
      const scope = resolveModelAuthAgentScope(
        config,
        params.agentId === undefined || params.agentId === ""
          ? tryResolveAmbientOwnerAgentId(config)
          : params.agentId,
      );
      if (!scope.ok) {
        respond(false, undefined, scope.error);
        return;
      }
      await respondUnavailableOnThrow(respond, async () => {
        if (params.clearTransientCooldowns) {
          // Clear shared store cooldowns first so inherited credentials recover
          const sharedResult = await updateAuthProfileStoreWithLock({
            sharedStoreWrite: true,
            updater: (store) => clearTransientCooldowns(store),
          });
          if (sharedResult === null) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.UNAVAILABLE,
                "Shared auth store is temporarily unavailable; retry the refresh.",
              ),
            );
            return;
          }
          // Clear local agent store cooldowns if agent has distinct local store
          if (scope.agentDir && !isSharedMainAuthProfileAgentDir(scope.agentDir)) {
            const localResult = await updateAuthProfileStoreWithLock({
              agentDir: scope.agentDir,
              updater: (store) => clearTransientCooldowns(store),
            });
            if (localResult === null) {
              respond(
                false,
                undefined,
                errorShape(
                  ErrorCodes.UNAVAILABLE,
                  `Auth store for agent "${scope.agentId}" is temporarily unavailable; retry the refresh.`,
                ),
              );
              return;
            }
          }
        }
        // Explicit refresh must observe persisted changes that supplied no in-process receipt.
        clearRuntimeAuthProfileStoreSnapshots();
        await refreshModelAuthStateAfterMutation(context.getRuntimeConfig, scope.agentId);
        respond(true, { refreshed: true }, undefined);
      });
    },
  ),
};
