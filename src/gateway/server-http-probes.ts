import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveRuntimeServiceBuildId, resolveRuntimeServiceVersion } from "../version.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect } from "./auth.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { classifyGatewayProbePath } from "./gateway-http-route-contracts.js";
import { readPreparedGatewayIngressAttribution } from "./ingress-attribution.js";
import { isLocalDirectRequest } from "./net.js";
import { getHttpAuthUtilsModule } from "./server-http-modules.js";
import type { ReadinessChecker, StartupChecker, StartupResult } from "./server/readiness.js";

function startupProbeBody(result: StartupResult, includeDetails: boolean): string {
  if (!includeDetails) {
    return JSON.stringify({ ok: result.ok, status: result.status });
  }
  return JSON.stringify({
    ok: result.ok,
    status: result.status,
    version: resolveRuntimeServiceVersion(process.env),
    buildId: resolveRuntimeServiceBuildId(),
    uptimeMs: result.uptimeMs,
    ...(result.status === "starting" ? { pendingReason: result.pendingReason } : {}),
  });
}

/** Handles live/ready/startup probe endpoints before normal gateway routing. */
export async function handleGatewayProbeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestPath: string,
  resolvedAuth: ResolvedGatewayAuth,
  trustedProxies: string[],
  allowRealIpFallback: boolean,
  rateLimiter?: AuthRateLimiter,
  getReadiness?: ReadinessChecker,
  getStartup?: StartupChecker,
): Promise<boolean> {
  const status = classifyGatewayProbePath(requestPath);
  if (status === "namespace" || status === "outside") {
    return false;
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  let statusCode: number;
  let body: string;
  if ((status === "ready" && getReadiness) || status === "startup") {
    // Subsystem details belong only to local direct or authenticated callers.
    async function shouldIncludeGatewayProbeDetails(): Promise<boolean> {
      if (
        readPreparedGatewayIngressAttribution(req)?.kind === "direct-local" ||
        (!readPreparedGatewayIngressAttribution(req) && isLocalDirectRequest(req))
      ) {
        return true;
      }
      if (resolvedAuth.mode === "none") {
        return false;
      }
      const { getBearerToken, resolveHttpBrowserOriginPolicy } = await getHttpAuthUtilsModule();
      const bearerToken = getBearerToken(req);
      return (
        await authorizeHttpGatewayConnect({
          auth: resolvedAuth,
          connectAuth: bearerToken ? { token: bearerToken, password: bearerToken } : null,
          req,
          trustedProxies,
          allowRealIpFallback,
          rateLimiter,
          browserOriginPolicy: resolveHttpBrowserOriginPolicy(req),
        })
      ).ok;
    }
    const includeDetails = await shouldIncludeGatewayProbeDetails();
    const readiness = status === "ready" ? getReadiness : undefined;
    try {
      if (readiness) {
        const result = readiness();
        statusCode = result.ready ? 200 : 503;
        body = JSON.stringify(includeDetails ? result : { ready: result.ready });
      } else {
        const result = getStartup?.() ?? { ok: true, status: "started", uptimeMs: 0 };
        statusCode = result.ok ? 200 : 503;
        body = startupProbeBody(result, includeDetails);
      }
    } catch {
      statusCode = 503;
      body = readiness
        ? JSON.stringify(
            includeDetails
              ? { ready: false, coreReady: false, failing: ["internal"], uptimeMs: 0 }
              : { ready: false },
          )
        : startupProbeBody(
            { ok: false, status: "starting", uptimeMs: 0, pendingReason: "internal" },
            includeDetails,
          );
    }
  } else {
    statusCode = 200;
    body = JSON.stringify({ ok: true, status });
  }
  res.statusCode = statusCode;
  // Node suppresses the HEAD body but never synthesizes Content-Length; set it
  // explicitly so probes keep GET/HEAD header parity (RFC 9110 §8.6).
  res.setHeader("Content-Length", String(Buffer.byteLength(body)));
  res.end(method === "HEAD" ? undefined : body);
  return true;
}
