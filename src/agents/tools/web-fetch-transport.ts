import type { SsrFPolicy } from "../../infra/net/ssrf.js";

export type WebFetchAcquisitionRequest = {
  /** Exact normalized HTTP(S) URL; still untrusted, model-selected input. */
  url: string;
  /** Correlation only, not proof of authority. */
  toolCallId: string;
  init: {
    method: "GET";
    headers: Readonly<Record<string, string>>;
  };
  signal?: AbortSignal;
  timeoutSeconds: number;
  maxRedirects: number;
  maxResponseBytes: number;
  ssrfPolicy?: SsrFPolicy;
};

/**
 * Host-bound acquisition for native web_fetch. Capture trusted invocation context
 * in closures, never in tool arguments. No native HTTP/provider fallback is used.
 */
export type WebFetchTransport = {
  /**
   * Synchronous live-authority check, including on cache hits and after awaited
   * work. Throw when this binding's invocation is no longer authorized.
   */
  assertInvocationCurrent: () => void;
  /**
   * Owns destination/DNS/SSRF admission, every redirect, credential/header
   * forwarding, timeout and cancellation through body consumption, and bounded
   * response buffering. Recheck live authority after async admission and before
   * network side effects. Reject refusals; clean up failed acquisitions here.
   */
  acquire: (request: WebFetchAcquisitionRequest) => Promise<{
    response: Response;
    finalUrl: string;
    /** Called once after native processing, including failures and cancellation. */
    release: () => Promise<void>;
  }>;
  /**
   * Opaque host-owned cache partition; defaults to this transport object's identity.
   * Share only across equivalent destinations, credentials, policy and audience.
   * Replace on any host-policy change; cache hits skip acquire, not the live check.
   */
  cacheScope?: object;
};
