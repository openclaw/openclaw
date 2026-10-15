import { randomBytes } from "node:crypto";
import { ARTIFACT_DOWNLOAD_PATH } from "../../packages/gateway-protocol/src/artifact-download.js";
import type {
  ArtifactDownloadResponse,
  ArtifactDownloadResponseRequest,
  PreparedArtifactDownload,
} from "./artifact-download-projection.js";
import type { GatewayClient } from "./server-methods/types.js";

const DOWNLOAD_TTL_MS = 5 * 60_000;
const MAX_DOWNLOADS_PER_CONNECTION = 128;

type Download = {
  expiresAt: number;
  digest: string;
  image: boolean;
  assertCurrent: () => void;
  read: (request: ArtifactDownloadResponseRequest) => Promise<ArtifactDownloadResponse | undefined>;
  release: () => void;
  readers: number;
  retired: boolean;
};

// Connection-owned grants retain only a reader, never artifact bytes or durable state.
const downloads = new WeakMap<GatewayClient, Map<string, Download>>();

function removeDownload(grants: Map<string, Download>, ticket: string) {
  const grant = grants.get(ticket);
  if (grant && grants.delete(ticket)) {
    grant.retired = true;
    if (grant.readers === 0) {
      grant.release();
    }
  }
}

export function canCreateArtifactDownload(
  client: GatewayClient | null,
): client is GatewayClient & { connId: string; connectionSignal: AbortSignal } {
  return Boolean(
    client?.connId && client.connectionSignal?.aborted === false && !client.invalidated,
  );
}

export function pruneExpiredArtifactDownloads(clients: Iterable<GatewayClient>, now: number) {
  for (const client of clients) {
    const grants = downloads.get(client);
    if (!grants) {
      continue;
    }
    for (const [ticket, grant] of grants) {
      if (!canCreateArtifactDownload(client) || grant.expiresAt <= now) {
        removeDownload(grants, ticket);
      }
    }
  }
}

export function createArtifactDownload(params: {
  client: GatewayClient | null;
  prepared: PreparedArtifactDownload;
  assertCurrent: Download["assertCurrent"];
  read: Download["read"];
  release: Download["release"];
}): { url: string; expiresAt: string } {
  const { client } = params;
  if (!canCreateArtifactDownload(client)) {
    throw new Error("Artifact download connection is no longer available");
  }
  params.assertCurrent();
  let grants = downloads.get(client);
  if (!grants) {
    grants = new Map();
    downloads.set(client, grants);
    const owned = grants;
    client.connectionSignal.addEventListener(
      "abort",
      () => {
        for (const ticket of owned.keys()) {
          removeDownload(owned, ticket);
        }
        downloads.delete(client);
      },
      { once: true },
    );
  }
  const now = Date.now();
  pruneExpiredArtifactDownloads([client], now);
  for (const ticket of grants.keys()) {
    if (grants.size < MAX_DOWNLOADS_PER_CONNECTION) {
      break;
    }
    removeDownload(grants, ticket);
  }
  const ticket = randomBytes(32).toString("base64url");
  const expiresAt = now + DOWNLOAD_TTL_MS;
  grants.set(ticket, {
    expiresAt,
    digest: params.prepared.digest,
    image: params.prepared.artifact.type === "image",
    assertCurrent: params.assertCurrent,
    read: params.read,
    release: params.release,
    readers: 0,
    retired: false,
  });
  return {
    url: `${ARTIFACT_DOWNLOAD_PATH}${encodeURIComponent(client.connId)}/${ticket}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function getArtifactDownloadGrant(client: GatewayClient, ticket: string) {
  return downloads.get(client)?.get(ticket);
}

export function assertArtifactDownloadGrantCurrent(
  clients: ReadonlySet<GatewayClient>,
  client: GatewayClient,
  ticket: string,
  grant: Download,
) {
  const grants = downloads.get(client);
  if (
    !clients.has(client) ||
    !canCreateArtifactDownload(client) ||
    grant.expiresAt <= Date.now() ||
    grants?.get(ticket) !== grant
  ) {
    if (grants?.get(ticket) === grant) {
      removeDownload(grants, ticket);
    }
    throw new Error("Artifact download expired");
  }
  grant.assertCurrent();
}

/** URL expiry closes admission, not an already admitted, backpressured transfer. */
export function retainArtifactDownloadStream(
  clients: ReadonlySet<GatewayClient>,
  client: GatewayClient,
  ticket: string,
  grant: Download,
) {
  assertArtifactDownloadGrantCurrent(clients, client, ticket, grant);
  grant.readers++;
  return {
    assertCurrent: () => {
      if (!clients.has(client) || !canCreateArtifactDownload(client)) {
        throw new Error("Artifact download connection is no longer available");
      }
      grant.assertCurrent();
    },
    release() {
      grant.readers--;
      if (grant.retired && grant.readers === 0) {
        grant.release();
      }
    },
  };
}
