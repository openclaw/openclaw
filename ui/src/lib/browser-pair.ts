// Plain owner of one browser device-code pairing attempt. Polling keeps running in
// a hidden tab: the person is expected to be in a terminal while this waits.
import {
  BROWSER_PAIR_ROUTE_PREFIX,
  buildBrowserPairPayload,
  formatBrowserPairCode,
  formatBrowserPairDeviceId,
  type BrowserPairAction,
} from "../../../src/shared/browser-pair.js";
import { loadOrCreateDeviceIdentity, signDevicePayload } from "./nodes/index.ts";

const BROWSER_PAIR_POLL_INTERVAL_MS = 2_000;

export type BrowserPairFailure = "declined" | "expired" | "busy" | "unavailable" | "noIdentity";

export type BrowserPairState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; code: string; browserId: string }
  | { kind: "failed"; reason: BrowserPairFailure };

type Identity = Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>>;

async function postBrowserPair(params: {
  basePath: string;
  action: BrowserPairAction;
  identity: Identity;
  requestId?: string;
}) {
  const { identity, action, requestId } = params;
  const payload = buildBrowserPairPayload({ action, deviceId: identity.deviceId, requestId });
  return await fetch(`${params.basePath}${BROWSER_PAIR_ROUTE_PREFIX}/${action}`, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      signature: await signDevicePayload(identity.privateKey, payload),
      ...(requestId ? { requestId } : {}),
    }),
  });
}

/** Whether this document can reach the Gateway's same-origin pairing route. */
export function canPairBrowserWithGateway(gatewayUrl: string): boolean {
  const parsed = URL.parse(gatewayUrl);
  return parsed?.host === window.location.host;
}

export function createBrowserPairSession(params: {
  basePath: string;
  onState: (state: BrowserPairState) => void;
  /** Receives the Gateway that issued the approval, which is the only valid redeemer. */
  onApproved: (bootstrapToken: string, gatewayUrl: string) => void;
}) {
  let attempt = 0;
  let attemptGatewayUrl: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    attempt += 1;
    attemptGatewayUrl = undefined;
    clearTimeout(timer);
  };

  const cancel = () => {
    stop();
    params.onState({ kind: "idle" });
  };

  const poll = async (
    current: number,
    gatewayUrl: string,
    identity: Identity,
    requestId: string,
    expiresAtMs: number,
  ): Promise<void> => {
    const fail = (reason: BrowserPairFailure) => {
      if (current === attempt) {
        params.onState({ kind: "failed", reason });
      }
    };
    if (Date.now() >= expiresAtMs) {
      fail("expired");
      return;
    }
    // A network drop or a rate limit does not end the attempt; the request outlives both.
    const result = await postBrowserPair({
      basePath: params.basePath,
      action: "collect",
      identity,
      requestId,
    })
      .then(async (response) =>
        response.ok || response.status === 404 ? { response, body: await response.json() } : null,
      )
      .catch(() => null);
    if (current !== attempt) {
      return;
    }
    if (result?.response.status === 404) {
      fail("expired");
      return;
    }
    const body = result?.body as
      | { status?: string; bootstrapToken?: string; expiresAtMs?: number }
      | undefined;
    if (body?.status === "approved" && body.bootstrapToken) {
      // The login gate owns connection progress and errors from here.
      params.onState({ kind: "idle" });
      params.onApproved(body.bootstrapToken, gatewayUrl);
      return;
    }
    if (body?.status === "rejected") {
      fail("declined");
      return;
    }
    if (body?.status === "expired") {
      fail("expired");
      return;
    }
    timer = setTimeout(
      () => void poll(current, gatewayUrl, identity, requestId, expiresAtMs),
      BROWSER_PAIR_POLL_INTERVAL_MS,
    );
  };

  return {
    start: async (gatewayUrl: string): Promise<void> => {
      stop();
      const current = attempt;
      attemptGatewayUrl = gatewayUrl;
      params.onState({ kind: "starting" });
      const identity = await loadOrCreateDeviceIdentity().catch(() => null);
      if (current !== attempt) {
        return;
      }
      if (!identity) {
        params.onState({ kind: "failed", reason: "noIdentity" });
        return;
      }
      const response = await postBrowserPair({
        basePath: params.basePath,
        action: "start",
        identity,
      }).catch(() => null);
      const body = response?.ok
        ? ((await response.json().catch(() => null)) as {
            requestId: string;
            code: string;
            expiresAtMs: number;
          } | null)
        : null;
      if (current !== attempt) {
        return;
      }
      if (!body) {
        const reason = response?.status === 429 ? "busy" : "unavailable";
        params.onState({ kind: "failed", reason });
        return;
      }
      params.onState({
        kind: "waiting",
        code: formatBrowserPairCode(body.code),
        browserId: formatBrowserPairDeviceId(identity.deviceId),
      });
      void poll(current, gatewayUrl, identity, body.requestId, body.expiresAtMs);
    },
    cancel,
    /** An approval is only valid for its issuer, so a new target ends the attempt. */
    retireUnlessTarget: (gatewayUrl: string | undefined) => {
      if (attemptGatewayUrl !== undefined && attemptGatewayUrl !== gatewayUrl) {
        cancel();
      }
    },
    dispose: stop,
  };
}
