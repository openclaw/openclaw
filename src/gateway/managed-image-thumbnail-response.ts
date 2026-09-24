import type { IncomingMessage, ServerResponse } from "node:http";
import { matchesHttpIfNoneMatch } from "./http-conditional.js";
import { createHttpImageRepresentation } from "./http-image-response.js";

export function sendManagedImageThumbnailResponse(params: {
  req: IncomingMessage;
  res: ServerResponse;
  thumbnail: Buffer;
  contentDisposition: string;
  cacheControl: string;
}): void {
  const { req, res } = params;
  const image = createHttpImageRepresentation(params.thumbnail, "image/png");
  res.setHeader("etag", image.etag);
  res.setHeader("cache-control", params.cacheControl);
  res.setHeader("content-disposition", params.contentDisposition);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  if (matchesHttpIfNoneMatch(req.headers["if-none-match"], image.etag)) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader("content-type", image.contentType);
  res.setHeader("content-length", String(image.body.byteLength));
  res.end(req.method === "HEAD" ? undefined : image.body);
}
