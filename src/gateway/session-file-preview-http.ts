import type { IncomingMessage, ServerResponse } from "node:http";
import { buildSandboxHostDocument } from "../agents/sandbox-host.js";
import {
  assertArtifactDownloadGrantCurrent,
  resolveArtifactDownloadGrant,
  retainArtifactDownloadStream,
  SESSION_FILE_PREVIEW_RESOURCE_PATH,
} from "./artifact-download-grants.js";
import { respondNotFound, respondPlainText } from "./control-ui-http-utils.js";
import {
  assertRemoteControlUiIngressCurrent,
  getRemoteControlUiIngressContext,
} from "./ingress-attribution.js";
import type { GatewayClient } from "./server-methods/types.js";

/** Only a finite, session-admitted resource table is visible on this origin. */
export async function handleSessionFilePreviewHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  clients: ReadonlySet<GatewayClient>,
): Promise<boolean> {
  const url = URL.parse(req.url ?? "/", "http://localhost");
  if (!url) {
    respondPlainText(res, 400, "Bad Request");
    return true;
  }
  if (!url.pathname.startsWith(SESSION_FILE_PREVIEW_RESOURCE_PATH)) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    respondPlainText(res, 405, "Method Not Allowed");
    return true;
  }
  const relative = url.pathname.slice(SESSION_FILE_PREVIEW_RESOURCE_PATH.length);
  const [connection, ticketPart, ...resourceSegments] = relative.split("/");
  const locator = `${connection}/${ticketPart}`;
  const selected = resolveArtifactDownloadGrant(clients, locator);
  if (!selected || selected.grant.source.kind !== "preview" || resourceSegments.length === 0) {
    respondNotFound(res);
    return true;
  }
  const { client, grant, ticket } = selected;
  const source = selected.grant.source;
  const assertCurrent = () => {
    const ingress = getRemoteControlUiIngressContext(req);
    assertRemoteControlUiIngressCurrent(ingress);
    if (
      ingress &&
      client.internal?.remoteIngressPrincipal?.assertCurrent !==
        ingress.resolvePrincipal().assertCurrent
    ) {
      throw new Error("File preview belongs to another ingress grant");
    }
    assertArtifactDownloadGrantCurrent(clients, client, ticket, grant);
  };
  let retained: ReturnType<typeof retainArtifactDownloadStream> | undefined;
  try {
    assertCurrent();
    // Keep borrowed file authority alive while a concurrent close retires the grant.
    retained = retainArtifactDownloadStream(clients, client, ticket, grant);
    const resourcePath = resourceSegments.join("/") + url.search;
    if (resourcePath === source.documentPath) {
      const ingress = getRemoteControlUiIngressContext(req);
      const document = buildSandboxHostDocument(
        { blockDescendantFrames: true },
        ingress ? [ingress.publicOrigin, ...ingress.frameAncestors] : undefined,
      );
      assertCurrent();
      for (const [name, value] of Object.entries(document.headers)) {
        res.setHeader(name, value);
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Length", Buffer.byteLength(document.html));
      res.end(req.method === "HEAD" ? undefined : document.html);
      return true;
    }
    const resource = await source.read(resourcePath);
    assertCurrent();
    if (!resource) {
      respondNotFound(res);
      return true;
    }
    res.setHeader(
      "Content-Type",
      resource.mimeType.startsWith("text/")
        ? `${resource.mimeType}; charset=utf-8`
        : resource.mimeType,
    );
    res.setHeader("Content-Length", resource.body.byteLength);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    // A resource navigated as a document never acquires executable sandbox-origin content.
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.end(req.method === "HEAD" ? undefined : resource.body);
  } catch {
    respondNotFound(res);
  } finally {
    retained?.release();
  }
  return true;
}
