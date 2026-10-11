import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeMimeType, sliceMimeSniffBuffer } from "@openclaw/media-core/mime";
import { ARTIFACT_DOWNLOAD_PATH } from "../../packages/gateway-protocol/src/artifact-download.js";
import { isAnimatedWebpBuffer, isStillPngBuffer } from "../media/image-ops.js";
import {
  assertArtifactDownloadGrantCurrent,
  getArtifactDownloadGrant,
} from "./artifact-download-grants.js";
import type { ArtifactDownloadResponse } from "./artifact-download-projection.js";
import { buildAssistantMediaContentDisposition } from "./assistant-media-content-disposition.js";
import { respondNotFound } from "./control-ui-http-utils.js";
import { resolveByteResponse, writeByteHeaders } from "./http-byte-range.js";
import { sendMethodNotAllowed } from "./http-common.js";
import {
  encodeImageThumbnail,
  resolveManagedImageThumbnail,
} from "./managed-image-thumbnail-cache.js";
import {
  getRemoteControlUiIngressContext,
  assertRemoteControlUiIngressCurrent,
} from "./remote-control-ui-context.js";
import type { GatewayClient } from "./server-methods/types.js";

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
  const grant =
    client && ticket && extra === undefined ? getArtifactDownloadGrant(client, ticket) : undefined;
  if (!client || !grant || !ticket) {
    respondNotFound(res);
    return true;
  }
  const assertCurrent = () => {
    assertRemoteControlUiIngressCurrent(getRemoteControlUiIngressContext(req));
    assertArtifactDownloadGrantCurrent(opts.clients, client, ticket, grant);
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
    prepared = undefined;
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
