import { setEnvironmentData } from "node:worker_threads";
import { vi } from "vitest";
import * as bundledCatalog from "./bundled-catalog-stamp.js";
import * as remoteStore from "./remote-store.js";

const restoreMocks: Array<() => void> = [];

export function setRemoteModelCatalogOverlaySourcesForTest(sources?: {
  bundledGeneratedAt?: typeof bundledCatalog.bundledCatalogGeneratedAt;
  readStoredCatalog?: typeof remoteStore.readRemoteModelCatalog;
}): void {
  setEnvironmentData("openclaw.remoteModelCatalogStartupSnapshot", undefined);
  for (const restore of restoreMocks.splice(0)) {
    restore();
  }
  if (sources?.bundledGeneratedAt) {
    restoreMocks.push(
      vi
        .spyOn(bundledCatalog, "bundledCatalogGeneratedAt")
        .mockImplementation(sources.bundledGeneratedAt).mockRestore,
    );
  }
  const readStoredCatalog = sources?.readStoredCatalog;
  if (readStoredCatalog) {
    restoreMocks.push(
      vi.spyOn(remoteStore, "readRemoteModelCatalog").mockImplementation(readStoredCatalog)
        .mockRestore,
      vi
        .spyOn(remoteStore, "readRemoteModelCatalogAsync")
        .mockImplementation(async () => readStoredCatalog()).mockRestore,
    );
  }
}
