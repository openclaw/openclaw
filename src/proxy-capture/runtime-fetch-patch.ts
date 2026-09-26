import { normalizeRequestInitHeadersForFetch } from "../infra/fetch-headers.js";
import {
  hasDebugProxyFetchPatch,
  registerDebugProxyFetchPatch,
  resolveDebugProxyFetchTransport,
  resolveRuntimeDeps,
  resolveSessionCaptureOwner,
  uninstallDebugProxyGlobalFetchPatch,
  type CaptureOwner,
  type DebugProxyCaptureRuntimeDeps,
} from "./runtime-owner.js";
import type { HttpCaptureParams, HttpCaptureErrorParams } from "./runtime-response-body.js";

function resolveUrlString(input: RequestInfo | URL): string | null {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "string") {
    return input;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  return null;
}

export function installDebugProxyGlobalFetchPatch(
  owner: CaptureOwner,
  capture: (
    owner: CaptureOwner,
    params: HttpCaptureParams | HttpCaptureErrorParams,
  ) => void | Promise<void>,
  deps: DebugProxyCaptureRuntimeDeps = {},
): void {
  const runtime = resolveRuntimeDeps(deps);
  const sessionAdmission = owner.session.admission;
  const fetchTarget = runtime.fetchTarget;
  if (typeof fetchTarget.fetch !== "function") {
    return;
  }
  if (hasDebugProxyFetchPatch(fetchTarget, sessionAdmission)) {
    return;
  }
  uninstallDebugProxyGlobalFetchPatch(deps);
  // Patch only once per target and keep the original fetch for deterministic
  // teardown in tests and nested capture sessions.
  const fetchImpl: typeof globalThis.fetch & { mock?: unknown } = fetchTarget.fetch;
  const originalFetch = resolveDebugProxyFetchTransport(fetchImpl).bind(fetchTarget);
  const patchedFetch: typeof globalThis.fetch & { mock?: unknown } = async (input, init) => {
    const url = resolveUrlString(input);
    const normalizedInit = normalizeRequestInitHeadersForFetch(init);
    // Retain admission before awaiting transport; a late result cannot join a
    // replacement capture session or reopen a store closed during shutdown.
    const admission = resolveSessionCaptureOwner(sessionAdmission)?.admission;
    const admitted = Boolean(admission?.current);
    const request = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
    const method = request?.method ?? normalizedInit?.method ?? "GET";
    const headers = request?.headers ?? normalizedInit?.headers;
    const body = request?.body ?? normalizedInit?.body ?? null;
    const requestHeaders = admitted && headers ? new Headers(headers) : undefined;
    const requestBody = admitted && Buffer.isBuffer(body) ? Buffer.from(body) : body;
    let response: Response;
    try {
      response = await originalFetch(input, normalizedInit);
    } catch (error) {
      const current = admission?.current;
      if (admitted && current && url && /^https?:/i.test(url)) {
        void capture(current, {
          url,
          method,
          error,
          meta: { captureOrigin: "global-fetch" },
        });
      }
      throw error;
    }
    const current = admission?.current;
    if (admitted && current && url && /^https?:/i.test(url)) {
      void capture(current, {
        url,
        method,
        requestHeaders,
        requestBody,
        response,
        transport: "http",
        meta: {
          captureOrigin: "global-fetch",
          source: current.settings.sourceProcess,
        },
      });
    }
    return response;
  };
  const mockState = fetchImpl.mock;
  if (typeof mockState === "object" && mockState !== null) {
    // Preserve Vitest mock metadata when patching mocked fetch targets.
    patchedFetch.mock = mockState;
  }
  registerDebugProxyFetchPatch(fetchTarget, originalFetch, patchedFetch, sessionAdmission);
}
