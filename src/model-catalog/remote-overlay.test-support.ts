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
    const spy = vi
      .spyOn(bundledCatalog, "bundledCatalogGeneratedAt")
      .mockImplementation(sources.bundledGeneratedAt);
    restoreMocks.push(() => spy.mockRestore());
  }
  const readStoredCatalog = sources?.readStoredCatalog;
  if (readStoredCatalog) {
    const read = vi
      .spyOn(remoteStore, "readRemoteModelCatalog")
      .mockImplementation(readStoredCatalog);
    const readAsync = vi
      .spyOn(remoteStore, "readRemoteModelCatalogAsync")
      .mockImplementation(async () => readStoredCatalog());
    restoreMocks.push(
      () => read.mockRestore(),
      () => readAsync.mockRestore(),
    );
  }
}
