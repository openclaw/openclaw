import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import type { ClientOptions } from "ws";
import { normalizeTlsFingerprint } from "../../packages/gateway-client/src/client-address-utils.js";
import { applyGatewayWebSocketTlsPin } from "../../packages/gateway-client/src/websocket-transport.js";
import type { ArtifactsDownloadResult } from "../../packages/gateway-protocol/src/index.js";
import { resolveAssistantMediaRoutePath } from "../gateway/control-ui-resource-routes.js";
import { normalizeControlUiBasePath } from "../gateway/control-ui-shared.js";
import {
  MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX,
  parseManagedOutgoingRoute,
} from "../gateway/managed-image-attachments.js";
import { parseInboundMediaUri } from "../media/media-reference.js";
import type { TuiImageData, TuiImageRequest } from "./tui-backend.js";
import { decodeTuiImageData, prepareTuiImage, TUI_IMAGE_MAX_BYTES } from "./tui-image-data.js";

type GatewayImageConnection = {
  url: string;
  tlsFingerprint?: string;
  edgeAuthHeaders?: Readonly<Record<string, string>>;
};

async function readGatewayImageResponse(response: IncomingMessage): Promise<Buffer> {
  try {
    if (response.statusCode !== 200) {
      throw new Error(`Image preview request failed (${response.statusCode ?? "unknown"})`);
    }
    const size = Number(response.headers["content-length"]);
    if (size > TUI_IMAGE_MAX_BYTES) {
      throw new Error("Image exceeds the preview byte limit");
    }
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of response) {
      if (!Buffer.isBuffer(chunk)) {
        throw new Error("Invalid image response");
      }
      received += chunk.byteLength;
      if (received > TUI_IMAGE_MAX_BYTES) {
        throw new Error("Image exceeds the preview byte limit");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, received);
  } finally {
    response.destroy();
  }
}

async function requestGatewayImage(
  connection: GatewayImageConnection,
  route: URL,
  credentials: readonly string[],
  signal: AbortSignal,
  mediaBasePath: string,
): Promise<Buffer> {
  const gateway = new URL(connection.url);
  if (gateway.protocol !== "ws:" && gateway.protocol !== "wss:") {
    throw new Error("Invalid Gateway image transport");
  }
  const target = new URL(gateway);
  target.protocol = gateway.protocol === "wss:" ? "https:" : "http:";
  const gatewayBasePath = normalizeControlUiBasePath(gateway.pathname);
  const proxyBasePath =
    mediaBasePath && gatewayBasePath.endsWith(mediaBasePath)
      ? gatewayBasePath.slice(0, -mediaBasePath.length)
      : gatewayBasePath;
  target.pathname = `${proxyBasePath}${route.pathname}`;
  target.search = route.search;
  target.hash = "";
  target.username = "";
  target.password = "";
  const fingerprint = normalizeTlsFingerprint(connection.tlsFingerprint);
  if (connection.tlsFingerprint && (!fingerprint || target.protocol !== "https:")) {
    throw new Error("Invalid Gateway image TLS fingerprint");
  }
  for (const [index, token] of (credentials.length ? credentials : [""]).entries()) {
    signal.throwIfAborted();
    const options: Pick<ClientOptions, "headers" | "rejectUnauthorized"> & {
      finishRequest?: (request: http.ClientRequest) => void;
    } = {
      headers: {
        ...connection.edgeAuthHeaders,
        accept: "image/png,image/jpeg,image/gif,image/webp",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    };
    if (fingerprint) {
      // Share the transport's pin check, including delaying credentials until peer verification.
      applyGatewayWebSocketTlsPin(options, fingerprint);
    }
    const request = (target.protocol === "https:" ? https : http).request(target, {
      method: "GET",
      headers: options.headers,
      signal,
      agent: false,
      ...(fingerprint ? { rejectUnauthorized: options.rejectUnauthorized } : {}),
    });
    const responsePromise = new Promise<IncomingMessage>((resolve, reject) => {
      request.once("response", resolve);
      request.once("error", reject);
    });
    if (options.finishRequest) {
      options.finishRequest(request);
    } else {
      request.end();
    }
    const response = await responsePromise;
    if (response.statusCode === 401 && index + 1 < credentials.length) {
      response.destroy();
      continue;
    }
    // Native HTTP never follows redirects; credentials stay bound to the connected Gateway.
    return await readGatewayImageResponse(response);
  }
  throw new Error("Image preview authentication failed");
}

export async function loadGatewayImage(params: {
  request: TuiImageRequest;
  connection: GatewayImageConnection;
  credentials: readonly string[];
  readMediaBasePath: (signal: AbortSignal) => Promise<string>;
  downloadArtifact: (artifactId: string, signal: AbortSignal) => Promise<ArtifactsDownloadResult>;
}): Promise<TuiImageData> {
  const { request } = params;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
  signal.throwIfAborted();
  const inline = decodeTuiImageData(request.source);
  if (inline) {
    return await prepareTuiImage(inline, signal);
  }
  const inbound = parseInboundMediaUri(request.source);
  let route: URL;
  let mediaBasePath = "";
  let credentials = params.credentials;
  if (inbound) {
    mediaBasePath = normalizeControlUiBasePath(await params.readMediaBasePath(signal));
    route = new URL(resolveAssistantMediaRoutePath(mediaBasePath), "http://localhost");
    route.searchParams.set("source", inbound.normalizedSource);
    route.searchParams.set("sessionKey", request.sessionKey);
    if (request.agentId) {
      route.searchParams.set("agentId", request.agentId);
    }
  } else {
    const managed = request.source.startsWith("/api/chat/media/outgoing/")
      ? parseManagedOutgoingRoute(request.source)
      : null;
    if (!managed) {
      throw new Error("Image source is not managed by this Gateway");
    }
    const artifactId = `${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${managed.attachmentId}`;
    if (request.artifactId && request.artifactId !== artifactId) {
      throw new Error("Image artifact does not match its source");
    }
    const result = await params.downloadArtifact(artifactId, signal);
    const download = result.url;
    const downloadedRoute = download ? parseManagedOutgoingRoute(download) : null;
    if (
      !download?.startsWith("/api/chat/media/outgoing/") ||
      result.artifact.id !== artifactId ||
      result.artifact.type !== "image" ||
      downloadedRoute?.attachmentId !== managed.attachmentId ||
      downloadedRoute.sessionKey !== managed.sessionKey ||
      result.artifact.sessionKey !== downloadedRoute.sessionKey
    ) {
      throw new Error("Image artifact is unavailable");
    }
    route = new URL(download, "http://localhost");
    route.pathname = route.pathname.replace(/\/full$/, "/thumbnail");
    credentials = [];
  }
  const buffer = await requestGatewayImage(
    params.connection,
    route,
    credentials,
    signal,
    mediaBasePath,
  );
  return await prepareTuiImage(buffer, signal);
}
