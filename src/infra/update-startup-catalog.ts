import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRemoteCatalogUrl } from "../model-catalog/remote-config.js";
import { checkRemoteModelCatalogUpdate } from "../model-catalog/remote-overlay.js";
import {
  refreshRemoteModelCatalog,
  REMOTE_MODEL_CATALOG_TTL_MS,
} from "../model-catalog/remote-refresh.js";
import type { UpdateCheckLifecycle } from "./update-check-lifecycle.js";

export function scheduleGatewayRemoteCatalogChecks(params: {
  lifecycle: UpdateCheckLifecycle;
  getConfig: () => OpenClawConfig;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
}): void {
  const { lifecycle } = params;
  let observedCatalog: { sourceUrl: string; generatedAt: number } | undefined;
  lifecycle.schedule("update.remote-model-catalog", async () => {
    let nextCheckInMs = REMOTE_MODEL_CATALOG_TTL_MS;
    try {
      const config = params.getConfig();
      const sourceUrl = resolveRemoteCatalogUrl(config);
      const result = await refreshRemoteModelCatalog({
        config,
        signal: lifecycle.signal,
      });
      if (lifecycle.signal.aborted) {
        return REMOTE_MODEL_CATALOG_TTL_MS;
      }
      nextCheckInMs =
        result.status === "fresh" ? result.nextCheckInMs : REMOTE_MODEL_CATALOG_TTL_MS;
      if (result.status === "error") {
        params.log.info("remote model catalog refresh failed", { error: result.error });
      } else if (
        result.status !== "disabled" &&
        (observedCatalog?.sourceUrl !== sourceUrl ||
          observedCatalog.generatedAt !== result.generatedAt)
      ) {
        const expected = { sourceUrl, generatedAt: result.generatedAt };
        const state = checkRemoteModelCatalogUpdate(params.getConfig(), expected);
        if (state !== "superseded") {
          observedCatalog = expected;
        }
        if (state === "restart-required") {
          params.log.info("remote model catalog downloaded; restart the Gateway to apply it", {
            providers: result.providers,
            models: result.models,
            generatedAt: result.generatedAt,
          });
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
