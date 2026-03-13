import type { IncomingMessage, ServerResponse } from "node:http";
import { listDevicePairing, approveDevicePairing } from "../infra/device-pairing.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { authorizeGatewayBearerRequestOrReply } from "./http-auth-helpers.js";
import {
  sendJson,
  sendMethodNotAllowed,
  sendInvalidRequest,
  readJsonBodyOrError,
} from "./http-common.js";

const MAX_BODY_BYTES = 4096;

export async function handleDevicesHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/devices") {
    return handleListDevices(req, res, opts);
  }
  if (url.pathname === "/api/devices/approve") {
    return handleApproveDevice(req, res, opts);
  }
  return false;
}

async function authorize(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  return authorizeGatewayBearerRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
}

async function handleListDevices(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<true> {
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  if (!(await authorize(req, res, opts))) {
    return true;
  }

  const list = await listDevicePairing();

  const devices = [
    ...list.pending.map((p) => ({
      id: p.requestId,
      deviceId: p.deviceId,
      displayName: p.displayName,
      platform: p.platform,
      ip: p.remoteIp,
      status: "pending" as const,
      createdAt: p.ts,
    })),
    ...list.paired.map((d) => ({
      id: d.deviceId,
      deviceId: d.deviceId,
      displayName: d.displayName,
      platform: d.platform,
      ip: d.remoteIp,
      status: "paired" as const,
      createdAt: d.createdAtMs,
    })),
  ];

  sendJson(res, 200, { devices });
  return true;
}

async function handleApproveDevice(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<true> {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  if (!(await authorize(req, res, opts))) {
    return true;
  }

  const body = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
  if (body === undefined) {
    return true;
  }

  const { requestId } = body as { requestId?: string };
  if (!requestId || typeof requestId !== "string") {
    sendInvalidRequest(res, "requestId is required");
    return true;
  }

  const result = await approveDevicePairing(requestId);
  if (!result) {
    sendJson(res, 404, {
      error: { message: "device not found", type: "not_found" },
    });
    return true;
  }

  sendJson(res, 200, { ok: true });
  return true;
}
