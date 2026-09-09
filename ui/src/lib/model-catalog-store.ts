import type { ModelsListParams } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ModelCatalogResult } from "../api/types.ts";
import type { ApplicationGateway } from "../app/context.ts";
import { t } from "../i18n/index.ts";

export type ModelCatalogReadScope = Pick<
  ModelsListParams,
  "agentId" | "sessionKey" | "authProfileId"
>;

export function modelCatalogRefreshError(
  result: ModelCatalogResult,
  failureMessage?: string,
): string | null {
  return result.refreshFailed
    ? (failureMessage ??
        t(
          result.models.length
            ? "chat.modelControls.modelsRefreshFailed"
            : "chat.modelControls.modelsUnavailable",
        ))
    : null;
}

/** The Gateway owns publication and freshness; callers own their request lifetime. */
export async function loadModelCatalog(
  client: Pick<GatewayBrowserClient, "request">,
  options: ModelsListParams & { signal?: AbortSignal },
): Promise<ModelCatalogResult> {
  const { signal, agentId, view = "configured", ...optionsWithoutScope } = options;
  signal?.throwIfAborted();
  const params = {
    view,
    ...optionsWithoutScope,
    ...(agentId === undefined ? {} : { agentId: agentId.trim() }),
  };
  return signal
    ? await client.request<ModelCatalogResult>("models.list", params, { signal })
    : await client.request<ModelCatalogResult>("models.list", params);
}

export function subscribeModelCatalogChanges(
  gateway: ApplicationGateway,
  listener: () => void,
): () => void {
  return gateway.subscribeEvents((event) => {
    if (event.event === "config.changed" || event.event === "chat.metadata.changed") {
      listener();
    }
  });
}
