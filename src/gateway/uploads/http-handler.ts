import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedGatewayAuth } from "../auth.js";
import { verifyDeviceToken } from "../../infra/device-pairing.js";
import { authorizeGatewayConnect } from "../auth.js";
import { UPLOAD_MAX_BYTES } from "./constants.js";
import { saveUpload, cleanOldUploads } from "./store.js";

const UPLOAD_PATH = "/uploads";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Verify upload authorization via Bearer token.
 *
 * Supports:
 * 1) Shared gateway token/password (Authorization: Bearer <value>)
 * 2) Device token (Authorization: Bearer <deviceToken> + X-OpenClaw-Device-Id)
 */
async function verifyUploadAuth(
  req: IncomingMessage,
  auth: ResolvedGatewayAuth,
  trustedProxies?: string[],
): Promise<boolean> {
  const authHeader = headerValue(req.headers.authorization);
  const bearerMatch = authHeader ? /^Bearer\s+(.+)$/i.exec(authHeader) : null;
  const bearerToken = bearerMatch?.[1]?.trim();
  const sharedAuth = await authorizeGatewayConnect({
    auth,
    connectAuth: bearerToken ? { token: bearerToken, password: bearerToken } : null,
    req,
    trustedProxies,
  });
  if (sharedAuth.ok) {
    return true;
  }

  if (!bearerToken) {
    return false;
  }

  // Fallback: allow paired operator device tokens when device id is provided.
  const deviceIdRaw = headerValue(req.headers["x-openclaw-device-id"]);
  const deviceId = typeof deviceIdRaw === "string" ? deviceIdRaw.trim() : "";
  if (!deviceId) {
    return false;
  }
  const checked = await verifyDeviceToken({
    deviceId,
    token: bearerToken,
    role: "operator",
    scopes: [],
  });
  return checked.ok;
}

/**
 * Read request body with size limit
 */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxBytes) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", () => {
      resolve(null);
    });
  });
}

export type HandleUploadHttpRequestOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
};

/**
 * Handle HTTP upload requests
 *
 * POST /uploads
 * Headers:
 *   Authorization: Bearer <token>
 *   X-File-Name: document.pdf
 *   Content-Type: application/octet-stream (or specific mime type)
 *
 * Body: raw file bytes
 *
 * Returns:
 *   { ok: true, id, path, fileName, size, mimeType }
 */
export async function handleUploadHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: HandleUploadHttpRequestOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Only handle /uploads path
  if (url.pathname !== UPLOAD_PATH) {
    return false;
  }

  // Only POST allowed
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  // Verify authorization
  if (!(await verifyUploadAuth(req, opts.auth, opts.trustedProxies))) {
    sendJson(res, 401, { ok: false, error: "Unauthorized" });
    return true;
  }

  // Get filename from header
  const fileName = headerValue(req.headers["x-file-name"]);
  if (!fileName) {
    sendJson(res, 400, { ok: false, error: "Missing X-File-Name header" });
    return true;
  }

  // Get content type hint
  const contentType = headerValue(req.headers["content-type"]);

  // Clean old uploads periodically (async, don't wait)
  void cleanOldUploads().catch(() => {});

  // Read body
  const body = await readBody(req, UPLOAD_MAX_BYTES);
  if (!body) {
    sendJson(res, 413, { ok: false, error: "Upload too large or read error" });
    return true;
  }

  if (body.length === 0) {
    sendJson(res, 400, { ok: false, error: "Empty upload" });
    return true;
  }

  try {
    const saved = await saveUpload(body, fileName, contentType);
    sendJson(res, 200, {
      ok: true,
      id: saved.id,
      path: saved.path,
      fileName: saved.fileName,
      size: saved.size,
      mimeType: saved.mimeType,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    sendJson(res, 400, { ok: false, error: message });
  }

  return true;
}
