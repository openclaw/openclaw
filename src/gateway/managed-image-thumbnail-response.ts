import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { buildManagedMediaContentDisposition } from "./assistant-media-content-disposition.js";
import { matchesHttpIfNoneMatch } from "./http-conditional.js";
import { createHttpImageRepresentation } from "./http-image-response.js";

export function handleManagedImageThumbnailResponse(
  req: IncomingMessage,
  res: ServerResponse,
  params: { thumbnail: Buffer; filename: string | null; cacheControl: string },
): true {
  const sourceName = path.parse(params.filename ?? "generated-image").name;
  const image = createHttpImageRepresentation(params.thumbnail, "image/png");
  res.setHeader("etag", image.etag);
  res.setHeader("cache-control", params.cacheControl);
  res.setHeader(
    "content-disposition",
    buildManagedMediaContentDisposition(`${sourceName}-thumbnail.png`, "image/png"),
  );
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  if (matchesHttpIfNoneMatch(req.headers["if-none-match"], image.etag)) {
    res.statusCode = 304;
    res.end();
    return true;
  }
  res.statusCode = 200;
  res.setHeader("content-type", image.contentType);
  res.setHeader("content-length", String(image.body.byteLength));
  res.end(req.method === "HEAD" ? undefined : image.body);
  return true;
}
