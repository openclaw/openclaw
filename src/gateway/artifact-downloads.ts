import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { normalizeMimeType } from "@openclaw/media-core/mime";
import { ARTIFACT_DOWNLOAD_PATH } from "../../packages/gateway-protocol/src/artifact-download.js";
import {
  assertArtifactDownloadGrantCurrent,
  getArtifactDownloadGrant,
  retainArtifactDownloadStream,
} from "./artifact-download-grants.js";
import type { ArtifactDownloadResponse } from "./artifact-download-projection.js";
import { buildAssistantMediaContentDisposition } from "./assistant-media-content-disposition.js";
import { respondNotFound } from "./control-ui-http-utils.js";
import { resolveByteResponse, writeByteHeaders } from "./http-byte-range.js";
import { sendMethodNotAllowed } from "./http-common.js";
import {
  getRemoteControlUiIngressContext,
  assertRemoteControlUiIngressCurrent,
} from "./ingress-attribution.js";
import {
  encodeImageThumbnail,
  resolveManagedImageThumbnail,
} from "./managed-image-thumbnail-cache.js";
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
  let assertGrantCurrent = () =>
    assertArtifactDownloadGrantCurrent(opts.clients, client, ticket, grant);
  const assertCurrent = () => {
    const ingress = getRemoteControlUiIngressContext(req);
    assertRemoteControlUiIngressCurrent(ingress);
    if (
      ingress &&
      client.internal?.remoteIngressPrincipal?.assertCurrent !==
        ingress.resolvePrincipal().assertCurrent
    ) {
      throw new Error("Artifact download belongs to another ingress grant");
    }
    assertGrantCurrent();
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
      const source = prepared.body;
      const cacheKey = createHash("sha256").update(source).digest("hex");
      // Preview failures are unavailable, never an implicit full-image download.
      const bytes = new Uint8Array(
        await resolveManagedImageThumbnail(cacheKey, () => encodeImageThumbnail(source)),
      );
      prepared.artifact = { ...prepared.artifact, mimeType: "image/png" };
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
  if (prepared.stream) {
    const stream = prepared.stream;
    let retained: ReturnType<typeof retainArtifactDownloadStream> | undefined;
    try {
      retained = retainArtifactDownloadStream(opts.clients, client, ticket, grant);
      assertGrantCurrent = retained.assertCurrent;
      await pipeline(
        async function* (options) {
          // pipeline supplies its cancellation signal to function sources.
          const signal = options!.signal!;
          for await (const chunk of stream(signal)) {
            signal.throwIfAborted();
            assertCurrent();
            yield chunk;
          }
        },
        res,
        { signal: client.connectionSignal },
      );
    } catch {
      // Headers may already be delivered. A truncated transfer must fail, not
      // acquire a successful end marker or a second HTTP response.
      res.destroy();
    } finally {
      retained?.release();
    }
  } else {
    res.end(body);
  }
  return true;
}
