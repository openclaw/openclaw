import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import type { ActiveRemoteModelCatalog } from "./remote-overlay.js";

const STARTUP_SNAPSHOT_KEY = "openclaw.remoteModelCatalogStartupSnapshot";

type Publication = {
  bytes: Uint8Array<SharedArrayBuffer> | null;
  catalog?: ActiveRemoteModelCatalog | null;
};

/** Workers inherit shared bytes; only catalog readers materialize the snapshot. */
export function readRemoteModelCatalogStartupPublication():
  | ActiveRemoteModelCatalog
  | null
  | undefined {
  // This module owns the environment entry and only publishes serialized catalog data.
  const publication = getEnvironmentData(STARTUP_SNAPSHOT_KEY) as Publication | undefined;
  if (publication === undefined) {
    return undefined;
  }
  if (publication.catalog !== undefined) {
    return publication.catalog;
  }
  const catalog = publication.bytes
    ? (JSON.parse(
        Buffer.from(publication.bytes.buffer).toString("utf8"),
      ) as ActiveRemoteModelCatalog)
    : null;
  // Non-enumerable data stays local, including when this worker spawns another.
  // All source/built copies in this isolate share the publication's exact identity.
  Object.defineProperty(publication, "catalog", { value: catalog });
  return catalog;
}

export function publishRemoteModelCatalogStartupPublication(
  catalog: ActiveRemoteModelCatalog | null,
): void {
  let bytes: Publication["bytes"] = null;
  if (catalog !== null) {
    const encoded = Buffer.from(JSON.stringify(catalog));
    bytes = new Uint8Array(new SharedArrayBuffer(encoded.byteLength));
    bytes.set(encoded);
  }
  const publication = { bytes };
  // Preserve the publisher's identity for compare-and-publish and scoped readers.
  Object.defineProperty(publication, "catalog", { value: catalog });
  setEnvironmentData(STARTUP_SNAPSHOT_KEY, publication);
}
