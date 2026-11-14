import { randomBytes } from "node:crypto";
import { ARTIFACT_DOWNLOAD_PATH } from "../../packages/gateway-protocol/src/artifact-download.js";
import type { SessionsFilesGetParams } from "../../packages/gateway-protocol/src/schema/sessions.js";
import type {
  ArtifactDownloadResponse,
  ArtifactDownloadResponseRequest,
  PreparedArtifactDownload,
} from "./artifact-download-projection.js";
import type { GatewayClient } from "./server-methods/types.js";

const DOWNLOAD_TTL_MS = 5 * 60_000;
const MAX_DOWNLOADS_PER_CONNECTION = 128;
export const SESSION_FILE_PREVIEW_RESOURCE_PATH = "/__openclaw__/file-preview/";

type SessionFilePreviewResource = { body: Uint8Array; mimeType: string };

type DownloadSource =
  | {
      kind: "bytes";
      digest: string;
      image: boolean;
      read: (
        request: ArtifactDownloadResponseRequest,
      ) => Promise<ArtifactDownloadResponse | undefined>;
    }
  | { kind: "managed"; path: string }
  | {
      kind: "preview";
      binding: string;
      documentPath: string;
      read: (path: string) => Promise<SessionFilePreviewResource | undefined>;
    };

type Download = {
  expiresAt: number;
  source: DownloadSource;
  assertCurrent: () => void;
  release: () => void;
  readers: number;
  retired: boolean;
};

// Issuer buckets retain readers, never bytes. Managed grants survive socket loss;
// the existing TTL sweep and Gateway teardown release their retained authority.
const downloads = new Map<GatewayClient, Map<string, Download>>();

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

export function pruneExpiredArtifactDownloads(
  now: number,
  clients: Iterable<GatewayClient> = downloads.keys(),
) {
  for (const client of clients) {
    const grants = downloads.get(client);
    if (!grants) {
      continue;
    }
    for (const [ticket, grant] of grants) {
      if (
        (grant.source.kind !== "managed" && !canCreateArtifactDownload(client)) ||
        grant.expiresAt <= now
      ) {
        removeDownload(grants, ticket);
      }
    }
    if (grants.size === 0 && !canCreateArtifactDownload(client)) {
      downloads.delete(client);
    }
  }
}

/** Gateway teardown clears grants; the HTTP lifetime owner cancels active transfers. */
export function clearArtifactDownloads() {
  for (const grants of downloads.values()) {
    for (const ticket of grants.keys()) {
      removeDownload(grants, ticket);
    }
  }
  downloads.clear();
}

type DownloadAuthority = {
  client: GatewayClient | null;
  assertCurrent: Download["assertCurrent"];
  release: Download["release"];
};

function createDownloadGrant(params: DownloadAuthority & { source: DownloadSource }) {
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
        for (const [ticket, grant] of owned) {
          if (grant.source.kind !== "managed") {
            removeDownload(owned, ticket);
          }
        }
        if (owned.size === 0 && downloads.get(client) === owned) {
          downloads.delete(client);
        }
      },
      { once: true },
    );
  }
  const now = Date.now();
  pruneExpiredArtifactDownloads(now, [client]);
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
    source: params.source,
    assertCurrent: params.assertCurrent,
    release: params.release,
    readers: 0,
    retired: false,
  });
  return {
    locator: `${encodeURIComponent(client.connId)}/${ticket}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function createArtifactDownload(
  params: DownloadAuthority & {
    prepared: PreparedArtifactDownload;
    read: Extract<DownloadSource, { kind: "bytes" }>["read"];
  },
): { url: string; expiresAt: string } {
  const grant = createDownloadGrant({
    ...params,
    source: {
      kind: "bytes",
      digest: params.prepared.digest,
      image: params.prepared.artifact.type === "image",
      read: params.read,
    },
  });
  return { url: `${ARTIFACT_DOWNLOAD_PATH}${grant.locator}`, expiresAt: grant.expiresAt };
}

/** Keep the managed media adapter's thumbnail and playback routes on the same grant lifetime. */
export function createManagedArtifactDownload(params: DownloadAuthority & { path: string }) {
  const grant = createDownloadGrant({ ...params, source: { kind: "managed", path: params.path } });
  return {
    url: `${params.path}?${new URLSearchParams({ mediaTicket: grant.locator })}`,
    expiresAt: grant.expiresAt,
  };
}

export function sessionFilePreviewBinding(source: SessionsFilesGetParams): string {
  return JSON.stringify([
    source.sessionKey,
    source.agentId ?? null,
    source.path,
    source.messageEntryId ?? null,
  ]);
}

/** Preview locators share the existing reader lifetime, never a filesystem namespace. */
export function createSessionFilePreviewGrant(
  params: DownloadAuthority & {
    binding: string;
    documentPath: string;
    read: Extract<DownloadSource, { kind: "preview" }>["read"];
  },
) {
  const grant = createDownloadGrant({
    ...params,
    source: {
      kind: "preview",
      binding: params.binding,
      documentPath: params.documentPath,
      read: params.read,
    },
  });
  return {
    previewId: grant.locator,
    sandboxPath: `${SESSION_FILE_PREVIEW_RESOURCE_PATH}${grant.locator}/${params.documentPath}`,
  };
}

export function releaseSessionFilePreviewGrant(
  client: GatewayClient | null,
  previewId: string,
  binding: string,
): boolean {
  if (!client?.connId) {
    return false;
  }
  const [connection, ticket, extra] = previewId.split("/");
  if (connection !== encodeURIComponent(client.connId) || !ticket || extra !== undefined) {
    return false;
  }
  const grants = downloads.get(client);
  const grant = grants?.get(ticket);
  if (!grants || grant?.source.kind !== "preview" || grant.source.binding !== binding) {
    return false;
  }
  removeDownload(grants, ticket);
  return true;
}

export function resolveArtifactDownloadGrant(clients: ReadonlySet<GatewayClient>, locator: string) {
  const [connection, ticket, extra] = locator.split("/");
  if (!ticket || extra !== undefined) {
    return undefined;
  }
  for (const [client, grants] of downloads) {
    if (!client.connId || encodeURIComponent(client.connId) !== connection) {
      continue;
    }
    const grant = grants.get(ticket);
    if (grant && (grant.source.kind === "managed" || clients.has(client))) {
      return { client, grant, ticket };
    }
  }
  return undefined;
}

export function assertArtifactDownloadGrantCurrent(
  clients: ReadonlySet<GatewayClient>,
  client: GatewayClient,
  ticket: string,
  grant: Download,
) {
  const grants = downloads.get(client);
  if (
    (grant.source.kind !== "managed" &&
      (!clients.has(client) || !canCreateArtifactDownload(client))) ||
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
      if (
        grant.source.kind !== "managed" &&
        (!clients.has(client) || !canCreateArtifactDownload(client))
      ) {
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
