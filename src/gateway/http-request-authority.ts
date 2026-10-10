// HTTP request authority retains admitted policy and response lifetime through awaited work.
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ToolAuthorizationError } from "../agents/tool-input-error.js";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isAbortError } from "../infra/abort-signal.js";
import { emitInternalDiagnosticEvent } from "../infra/diagnostic-events.js";
import {
  createHttpRequestAbortSignal,
  runHttpConnectionRequest,
  waitForHttpRequestRejection,
} from "../infra/http-request-lifecycle.js";
import type { PluginGatewayAccessAuthority } from "../plugins/gateway-access-policy.types.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { readUserProfileAliasRevision } from "../state/user-profile-events.js";
import { isGatewayAuthPolicyCurrent, captureGatewayAuthPolicy } from "./auth-policy.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendUnauthorized } from "./http-common.js";
import { sendGatewayHttpAuthFailure } from "./http-operator-access.js";
import {
  GatewayOperatorAccessDeniedError,
  hasCurrentGatewayOperatorAccess,
} from "./operator-access-policy.js";
import { readOperatorRolePolicyRevision } from "./operator-role-policy.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

export type GatewayHttpRequestLifetime = Pick<
  GatewayRequestContext,
  "trackExecution" | "requestEntryLifetime"
>;

/** Replaces startup custody with the live Gateway and one disconnect-aware request scope. */
export function runGatewayHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: GatewayHttpRequestLifetime | undefined,
  handle: () => Promise<"failed" | undefined>,
): Promise<void> {
  const run = async () => {
    const work = new AsyncWorkScope();
    const requestContext = work.run(() => AsyncLocalStorage.snapshot());
    const client = createHttpRequestAbortSignal(req, res);
    const shutdown = context?.requestEntryLifetime?.signal;
    const signal = shutdown ? AbortSignal.any([client.signal, shutdown]) : client.signal;
    let cancelledBy: "client" | "shutdown" | undefined;
    const cancel = () =>
      requestContext(() => {
        cancelledBy = client.signal.aborted ? "client" : "shutdown";
        work.beginClose(signal.reason);
        // A streaming handler can return before its response finishes; wake the transport join too.
        if (cancelledBy === "shutdown" && !res.writableFinished && !res.destroyed) {
          res.destroy();
        }
      });
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) {
      cancel();
    }
    let failed = false;
    try {
      await work.track(() =>
        runHttpConnectionRequest(
          req,
          async () => {
            failed = (await handle()) === "failed";
          },
          res,
        ),
      );
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
      client.cleanup();
      // Rejections can finish their framed body by half-closing without res.end().
      if (
        cancelledBy &&
        !failed &&
        res.statusCode < 500 &&
        !(cancelledBy === "client" && waitForHttpRequestRejection(req))
      ) {
        emitInternalDiagnosticEvent({ type: "gateway.http.cancelled", source: cancelledBy });
      }
      await requestContext(() => work.drain());
    }
  };
  return context ? context.trackExecution(run) : run();
}

/** Authority ended; its response has already been answered or closed. */
export class GatewayHttpRequestAuthorityError extends Error {}

/** Request owners consume authority outcomes; unexpected failures keep their own diagnostics. */
export function finishGatewayHttpAuthorityError(res: ServerResponse, error: unknown): boolean {
  const signal = getAsyncWorkSignal();
  if (signal?.aborted && (error === signal.reason || isAbortError(error))) {
    // Cancellation ends the response, never completes a partial representation or writes a 500.
    if (!res.writableEnded && !res.destroyed) {
      res.destroy();
    }
    return true;
  }
  if (error instanceof GatewayOperatorAccessDeniedError) {
    sendGatewayHttpAuthFailure(res, { ok: false, reason: "operator_access_denied" });
    return true;
  }
  return error instanceof GatewayHttpRequestAuthorityError;
}

export type GatewayHttpRequestAuthOptions = {
  auth: ResolvedGatewayAuth;
  cfg?: OpenClawConfig;
  getRuntimeConfig?: () => OpenClawConfig;
  getResolvedAuth?: () => ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

export type GatewayHttpRequestAuthority = {
  hasCurrentClientAuthority: () => boolean;
};

export type GatewayHttpResponseAuthority = GatewayHttpRequestAuthority & {
  assertCurrent: () => void;
  revalidate: () => Promise<void>;
};

export function assertGatewayHttpRequestCurrent(requestAuth: {
  hasCurrentClientAuthority?: () => boolean;
}): void {
  if (requestAuth.hasCurrentClientAuthority?.() === false) {
    throw new ToolAuthorizationError("Gateway requester authority changed");
  }
}

export function captureHttpRequestAuthority(
  params: GatewayHttpRequestAuthOptions & { req: IncomingMessage },
): () => boolean {
  const cfg = params.cfg ?? getRuntimeConfig();
  // HTTP scopes come from credential/header grants and role ceilings, never identityScopes.
  const policy = captureGatewayAuthPolicy(cfg, null);
  const authGeneration = resolveSharedGatewaySessionGeneration(
    params.auth,
    params.trustedProxies ?? cfg.gateway?.trustedProxies,
  );
  const roleRevision = cfg.gateway?.roles ? readOperatorRolePolicyRevision() : undefined;
  const aliasRevision = readUserProfileAliasRevision();
  return () => {
    const current = params.getRuntimeConfig?.() ?? getRuntimeConfig();
    return (
      !params.req.socket?.destroyed &&
      isGatewayAuthPolicyCurrent(policy, current) &&
      (roleRevision === undefined || roleRevision === readOperatorRolePolicyRevision()) &&
      aliasRevision === readUserProfileAliasRevision() &&
      authGeneration ===
        resolveSharedGatewaySessionGeneration(
          params.getResolvedAuth?.() ?? params.auth,
          params.trustedProxies ?? current.gateway?.trustedProxies,
        )
    );
  };
}

export function bindHttpResponseAuthority<T>(
  auth: T & { operatorAccessAuthority?: PluginGatewayAccessAuthority | null },
  res: ServerResponse,
  hasCurrentClientAuthority: () => boolean,
): T & GatewayHttpResponseAuthority {
  const assertCurrent = () => {
    if (res.writableEnded || res.destroyed) {
      throw new GatewayHttpRequestAuthorityError("HTTP request authority expired");
    }
    if (!hasCurrentGatewayOperatorAccess(auth.operatorAccessAuthority)) {
      throw new GatewayOperatorAccessDeniedError();
    }
    if (!hasCurrentClientAuthority()) {
      sendUnauthorized(res);
      throw new GatewayHttpRequestAuthorityError("Unauthorized");
    }
  };
  return {
    ...auth,
    hasCurrentClientAuthority: () =>
      !res.writableEnded &&
      !res.destroyed &&
      hasCurrentClientAuthority() &&
      hasCurrentGatewayOperatorAccess(auth.operatorAccessAuthority),
    assertCurrent,
    revalidate: async () => assertCurrent(),
  };
}
