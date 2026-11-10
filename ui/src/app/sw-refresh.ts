import { retryControlUiImport } from "./stale-chunk-reload.ts";

export function refreshControlUiServiceWorker(): Promise<boolean> {
  return retryControlUiImport(() => import("./sw-refresh.runtime.ts")).then((module) =>
    module.refreshControlUiServiceWorker(),
  );
}
