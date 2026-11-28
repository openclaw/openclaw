import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import type { ActiveRemoteModelCatalog } from "./remote-overlay.types.js";

const STARTUP_SNAPSHOT_KEY = "openclaw.remoteModelCatalogStartupSnapshot";

type CatalogIdentity = Pick<ActiveRemoteModelCatalog, "sourceUrl" | "revision">;
export type RemoteModelCatalogWorkerTransfer =
  | ActiveRemoteModelCatalog
  | (CatalogIdentity & { sharedBytes: SharedArrayBuffer });

type Publication = Partial<CatalogIdentity> & {
  bytes: Uint8Array<SharedArrayBuffer> | null;
  catalog?: ActiveRemoteModelCatalog | null;
};

function startupPublication() {
  // SAFETY: This module owns the key and only publishes the Publication shape below.
  return getEnvironmentData(STARTUP_SNAPSHOT_KEY) as Publication | undefined;
}

export function captureRemoteModelCatalogWorkerTransfer(
  catalog: ActiveRemoteModelCatalog | null,
): RemoteModelCatalogWorkerTransfer | null {
  if (!catalog) {
    return null;
  }
  const publication = startupPublication();
  // Only the publisher's exact object owns these bytes. Independent scoped snapshots travel as-is.
  return publication?.catalog === catalog && publication.bytes
    ? {
        sourceUrl: catalog.sourceUrl,
        revision: catalog.revision,
        sharedBytes: publication.bytes.buffer,
      }
    : catalog;
}

export function decodeRemoteModelCatalogWorkerBytes(
  bytes: SharedArrayBuffer,
): ActiveRemoteModelCatalog {
  // SAFETY: Only the publisher encodes these bytes, from its validated catalog.
  return JSON.parse(Buffer.from(bytes).toString("utf8")) as ActiveRemoteModelCatalog;
}

/** Workers inherit shared bytes; only catalog readers materialize the snapshot. */
export function readRemoteModelCatalogStartupPublication(
  match?: CatalogIdentity,
): ActiveRemoteModelCatalog | null | undefined {
  const publication = startupPublication();
  if (
    !publication ||
    (match &&
      (publication.sourceUrl !== match.sourceUrl || publication.revision !== match.revision))
  ) {
    // The worker can outlive the publication it inherited. Leave unrelated bytes untouched.
    return undefined;
  }
  if (publication.catalog !== undefined) {
    return publication.catalog;
  }
  const catalog = publication.bytes
    ? decodeRemoteModelCatalogWorkerBytes(publication.bytes.buffer)
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
  const publication = { bytes, sourceUrl: catalog?.sourceUrl, revision: catalog?.revision };
  // Preserve the publisher's identity for compare-and-publish and scoped readers.
  Object.defineProperty(publication, "catalog", { value: catalog });
  setEnvironmentData(STARTUP_SNAPSHOT_KEY, publication);
}
