import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeMimeType, sliceMimeSniffBuffer } from "@openclaw/media-core/mime";
import { ARTIFACT_DOWNLOAD_PATH } from "../../packages/gateway-protocol/src/artifact-download.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { isAnimatedWebpBuffer, isStillPngBuffer } from "../media/image-ops.js";
import type {
  ArtifactDownloadResponse,
  ArtifactDownloadResponseRequest,
  PreparedArtifactDownload,
} from "./artifact-download-projection.js";
import { buildAssistantMediaContentDisposition } from "./assistant-media-content-disposition.js";
import { respondNotFound } from "./control-ui-http-utils.js";
import { resolveByteResponse, writeByteHeaders } from "./http-byte-range.js";
import { sendMethodNotAllowed } from "./http-common.js";
import {
  encodeImageThumbnail,
  resolveManagedImageThumbnail,
} from "./managed-image-thumbnail-cache.js";
import type { GatewayClient } from "./server-methods/types.js";

const DOWNLOAD_TTL_MS = 5 * 60_000;
const MAX_DOWNLOADS_PER_CONNECTION = 128;

type Download = {
  expiresAt: number;
  digest: string;
  image: boolean;
  assertCurrent: () => void;
  read: (request: ArtifactDownloadResponseRequest) => Promise<ArtifactDownloadResponse | undefined>;
};

// Connection-owned grants retain only a reader, never artifact bytes or durable state.
const downloads = new WeakMap<GatewayClient, Map<string, Download>>();

export function canCreateArtifactDownload(
  client: GatewayClient | null,
): client is GatewayClient & { connId: string } {
  return Boolean(
    client?.connId && client.connectionSignal?.aborted === false && !client.invalidated,
  );
}

export function createArtifactDownload(params: {
  client: GatewayClient | null;
  prepared: PreparedArtifactDownload;
  assertCurrent: Download["assertCurrent"];
  read: Download["read"];
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
  }
  const now = Date.now();
  for (const [ticket, grant] of grants) {
    if (grant.expiresAt <= now) {
      grants.delete(ticket);
    }
  }
  pruneMapToMaxSize(grants, MAX_DOWNLOADS_PER_CONNECTION - 1);
  const ticket = randomBytes(32).toString("base64url");
  const expiresAt = now + DOWNLOAD_TTL_MS;
  grants.set(ticket, {
    expiresAt,
    digest: params.prepared.digest,
    image: params.prepared.artifact.type === "image",
    assertCurrent: params.assertCurrent,
    read: params.read,
  });
  return {
    url: `${ARTIFACT_DOWNLOAD_PATH}${encodeURIComponent(client.connId)}/${ticket}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/** The RPC chooses and authorizes the resource; HTTP never accepts a replacement query. */
export async function handleArtifactDownloadHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { clients: ReadonlySet<GatewayClient>; basePath: string },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname =
    opts.basePath && url.pathname.startsWith(`${opts.basePath}${ARTIFACT_DOWNLOAD_PATH}`)
      ? url.pathname.slice(opts.basePath.length)
      : url.pathname;
  if (!pathname.startsWith(ARTIFACT_DOWNLOAD_PATH)) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendMethodNotAllowed(res, "GET, HEAD");
    return true;
  }
  const [connection, ticket, extra] = pathname.slice(ARTIFACT_DOWNLOAD_PATH.length).split("/");
  const client = [...opts.clients].find(
    (candidate) => candidate.connId && encodeURIComponent(candidate.connId) === connection,
  );
  const grants = client ? downloads.get(client) : undefined;
  const grant = ticket && extra === undefined ? grants?.get(ticket) : undefined;
  if (!client || !grant || !ticket) {
    respondNotFound(res);
    return true;
  }
  const assertCurrent = () => {
    if (
      !opts.clients.has(client) ||
      client.connectionSignal?.aborted !== false ||
      client.invalidated ||
      grant.expiresAt <= Date.now() ||
      grants?.get(ticket) !== grant
    ) {
      throw new Error("Artifact download expired");
    }
    grant.assertCurrent();
  };
  let prepared: ArtifactDownloadResponse | undefined;
  const thumbnail = grant.image && url.searchParams.get("variant") === "thumbnail";
  try {
    assertCurrent();
    prepared = await grant.read({
      expectedDigest: grant.digest,
      method: thumbnail ? "GET" : req.method,
      headers: thumbnail
        ? {}
        : {
            range: req.headers.range,
            "if-range": req.headers["if-range"],
            "if-none-match": req.headers["if-none-match"],
          },
    });
    assertCurrent();
    if (thumbnail && prepared?.body) {
      let bytes = prepared.body;
      const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const sourceType = await import("file-type")
        .then(({ fileTypeFromBuffer }) => fileTypeFromBuffer(sliceMimeSniffBuffer(source)))
        .catch(() => undefined);
      // Rastermill has no frame count, and bounded MIME sniffing can miss APNG.
      // Preserve containers whose still-image status we cannot establish.
      const still =
        (sourceType?.mime === "image/png" && isStillPngBuffer(source)) ||
        sourceType?.mime === "image/jpeg" ||
        (sourceType?.mime === "image/webp" && !isAnimatedWebpBuffer(source));
      const cacheKey = createHash("sha256").update(bytes).digest("hex");
      const encoded = still
        ? await resolveManagedImageThumbnail(cacheKey, () => encodeImageThumbnail(bytes)).catch(
            () => undefined,
          )
        : undefined;
      if (encoded && encoded.byteLength < bytes.byteLength) {
        bytes = new Uint8Array(encoded);
        prepared.artifact = { ...prepared.artifact, mimeType: "image/png" };
      }
      const response = resolveByteResponse({
        file: { size: bytes.byteLength },
        method: req.method,
        request: req,
      });
      prepared.response = response;
      prepared.body =
        req.method === "HEAD" ||
        response.kind === "not-modified" ||
        response.kind === "unsatisfiable"
          ? undefined
          : response.kind === "partial"
            ? bytes.subarray(response.range.start, response.range.end + 1)
            : bytes;
      assertCurrent();
    }
  } catch {
    respondNotFound(res);
    return true;
  }
  if (!prepared) {
    respondNotFound(res);
    return true;
  }
  const { artifact, response, body } = prepared;
  const mime = normalizeMimeType(artifact.mimeType);
  const contentType =
    mime && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mime)
      ? mime
      : "application/octet-stream";
  res.setHeader("content-type", contentType);
  // Transcript content can contain active HTML or SVG. Never grant it the Gateway origin.
  res.setHeader("content-disposition", buildAssistantMediaContentDisposition(artifact.title));
  res.setHeader("content-security-policy", "default-src 'none'; sandbox");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("cache-control", "private, no-store");
  writeByteHeaders(res, response);
  res.end(body);
  return true;
}
