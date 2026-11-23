// HTTP request lifetime: one disconnect-aware scope per request, and its terminal outcomes.
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isAbortError } from "../infra/abort-signal.js";
import { emitInternalDiagnosticEvent } from "../infra/diagnostic-events.js";
import {
  createHttpRequestAbortSignal,
  runHttpConnectionRequest,
  waitForHttpRequestRejection,
} from "../infra/http-request-lifecycle.js";
import { isOperatorAuthorityUnavailable } from "../infra/operator-authority-error.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendGatewayHttpAuthFailure } from "./http-operator-access.js";
import {
  getRemoteControlUiIngressContext,
  assertRemoteControlUiIngressCurrent,
} from "./ingress-attribution.js";
import { GatewayOperatorAccessDeniedError } from "./operator-access-policy.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

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
  if (context?.requestEntryLifetime?.signal.aborted) {
    if (!res.writableFinished && !res.destroyed) {
      res.destroy();
    }
    return Promise.resolve();
  }
  const run = async () => {
    const ingress = getRemoteControlUiIngressContext(req);
    assertRemoteControlUiIngressCurrent(ingress);
    const work = new AsyncWorkScope();
    // Setup and dispatch share one entry; cancellation retains this exact request frame.
    return work.run(async () => {
      const requestContext = AsyncLocalStorage.snapshot();
      const client = createHttpRequestAbortSignal(req, res);
      const shutdown = context?.requestEntryLifetime?.signal;
      const signal = AbortSignal.any([
        client.signal,
        ...(shutdown ? [shutdown] : []),
        ...(ingress ? [ingress.signal] : []),
      ]);
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
    });
  };
  return context ? context.trackExecution(run) : run();
}

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
  if (isOperatorAuthorityUnavailable(error)) {
    // A handler may already have written before revalidating its response authority.
    sendGatewayHttpAuthFailure(
      res,
      { ok: false, reason: "operator_access_unavailable" },
      { retryable: false },
    );
    return true;
  }
  return false;
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
