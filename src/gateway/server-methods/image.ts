// Gateway RPC handlers for image generation provider inventory.
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { listImageGenerationProviders } from "../../image-generation/provider-registry.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

/** Gateway request handlers for image generation provider inventory. */
export const imageHandlers: GatewayRequestHandlers = {
  "image.providers": async ({ respond, context }) => {
    try {
      const cfg = context.getRuntimeConfig();
      const providers = listImageGenerationProviders(cfg).map((provider) => {
        const isConfigured = provider.isConfigured?.({ cfg }) ?? true;
        return {
          id: provider.id,
          label: provider.label ?? provider.id,
          configured: isConfigured,
          defaultModel: provider.defaultModel,
          models: provider.models ?? [],
          capabilities: {
            generate: provider.capabilities?.generate ?? true,
            edit: provider.capabilities?.edit ?? false,
            geometry: provider.capabilities?.geometry ?? false,
            output: provider.capabilities?.output ?? [],
          },
        };
      });
      const activeProvider = providers.find((p) => p.configured)?.id ?? null;
      respond(true, {
        providers,
        active: activeProvider,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
