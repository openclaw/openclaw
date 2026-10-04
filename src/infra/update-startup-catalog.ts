import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RemoteCatalogPublicationResult } from "../model-catalog/remote-overlay.js";
import {
  refreshRemoteModelCatalog,
  REMOTE_MODEL_CATALOG_TTL_MS,
} from "../model-catalog/remote-refresh.js";
import type { UpdateCheckLifecycle } from "./update-check-lifecycle.js";

export function scheduleGatewayRemoteCatalogChecks(params: {
  lifecycle: UpdateCheckLifecycle;
  getConfig: () => OpenClawConfig;
  applyRemoteCatalogUpdate: (signal: AbortSignal) => Promise<RemoteCatalogPublicationResult>;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
}): void {
  const { lifecycle } = params;
  lifecycle.schedule("update.remote-model-catalog", async () => {
    let nextCheckInMs = REMOTE_MODEL_CATALOG_TTL_MS;
    try {
      const result = await refreshRemoteModelCatalog({
        config: params.getConfig(),
        signal: lifecycle.signal,
      });
      if (lifecycle.signal.aborted) {
        return REMOTE_MODEL_CATALOG_TTL_MS;
      }
      nextCheckInMs =
        result.status === "fresh" ? result.nextCheckInMs : REMOTE_MODEL_CATALOG_TTL_MS;
      if (result.status === "error") {
        params.log.info(
          "remote model catalog refresh failed; next check in 6 hours, or run openclaw models refresh",
          { error: result.error },
        );
      } else if (result.status !== "disabled") {
        const state = await params.applyRemoteCatalogUpdate(lifecycle.signal);
        if (state === "published") {
          params.log.info("remote model catalog applied");
        } else if (state === "superseded") {
          params.log.info("remote model catalog check superseded; deferred to the next check");
        }
      }
    } catch (error) {
      if (!lifecycle.signal.aborted) {
        params.log.info("remote model catalog check failed", { error: String(error) });
      }
    }
    return nextCheckInMs;
  });
}
