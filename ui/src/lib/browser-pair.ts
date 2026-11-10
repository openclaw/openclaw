// Plain owner of one browser device-code pairing attempt. Polling keeps running in
// a hidden tab: the person is expected to be in a terminal while this waits.
import {
  BROWSER_PAIR_ROUTE_PREFIX,
  buildBrowserPairPayload,
  formatBrowserPairCode,
  formatBrowserPairDeviceId,
  type BrowserPairAction,
} from "../../../src/shared/browser-pair.js";
import {
  loadOrCreateDeviceIdentity,
  signDevicePayload,
  storeDeviceAuthToken,
} from "./nodes/index.ts";

const BROWSER_PAIR_POLL_INTERVAL_MS = 2_000;
const BROWSER_PAIR_FETCH_TIMEOUT_MS = 10_000;

export type BrowserPairFailure =
  | "declined"
  | "expired"
  | "busy"
  | "unavailable"
  | "noIdentity"
  | "identityRequired";

type BrowserPairCode = { code: string; browserId: string };
export type BrowserPairState =
  | { kind: "idle" | "cancelled" }
  | { kind: "starting" }
  | ({
      kind: "waiting" | "reconnecting" | "cancelling" | "cancelFailed" | "alreadyApproved";
    } & BrowserPairCode)
  | { kind: "failed"; reason: BrowserPairFailure };

type Identity = Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>>;
type Attempt = BrowserPairCode & {
  gatewayUrl: string;
  basePath: string;
  identity: Identity;
  requestId: string;
};
type BrowserPairReply = {
  error?: string;
  status?: string;
  requestId?: string;
  code?: string;
  deviceId?: string;
  deviceToken?: string;
  role?: string;
  scopes?: string[];
};

async function postBrowserPair(params: {
  basePath: string;
  action: BrowserPairAction;
  identity: Identity;
  requestId?: string;
}) {
  const { identity, requestId, action } = params;
  const signature = await signDevicePayload(
    identity.privateKey,
    buildBrowserPairPayload({ action, deviceId: identity.deviceId, requestId }),
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BROWSER_PAIR_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${params.basePath}${BROWSER_PAIR_ROUTE_PREFIX}/${action}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        deviceId: identity.deviceId,
        publicKey: identity.publicKey,
        signature,
        requestId,
      }),
    });
    // Keep the timeout through body consumption as well as receipt of the headers.
    // SAFETY: The same Gateway build serves this same-origin reply; unknown statuses take retry/error paths.
    const body = (await response.json()) as BrowserPairReply;
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

export function createBrowserPairSession(params: {
  basePath: string;
  onState: (state: BrowserPairState) => void;
  onApproved: (gatewayUrl: string) => void;
}) {
  let generation = 0;
  let attempt: Attempt | undefined;
  let attemptGatewayUrl: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancellationInFlight = false;
  let approvalNeedsContinuation = false;
  const invalidate = () => {
    generation += 1;
    clearTimeout(timer);
  };
  const stop = () => {
    invalidate();
    attempt = undefined;
    attemptGatewayUrl = undefined;
    cancellationInFlight = false;
    approvalNeedsContinuation = false;
  };
  const showCode = (
    kind: "waiting" | "reconnecting" | "cancelling" | "cancelFailed" | "alreadyApproved",
    active: Attempt,
  ) => {
    params.onState({ kind, code: active.code, browserId: active.browserId });
  };
  const fail = (reason: BrowserPairFailure) => {
    stop();
    params.onState({ kind: "failed", reason });
  };

  const poll = async (current: number, active: Attempt): Promise<void> => {
    // Only the Gateway decides expiry. Approval can extend the original request deadline.
    const result = await postBrowserPair({ ...active, action: "collect" }).catch(() => null);
    if (current !== generation) {
      return;
    }
    if (result?.response.status === 404) {
      fail("expired");
      return;
    }
    const body = result?.response.ok ? result.body : undefined;
    if (body?.status === "approved" && body.deviceToken && body.role) {
      storeDeviceAuthToken({
        deviceId: active.identity.deviceId,
        role: body.role,
        token: body.deviceToken,
        scopes: body.scopes ?? [],
        gatewayUrl: active.gatewayUrl,
      });
      stop();
      // The login gate owns connection progress and errors from here.
      params.onState({ kind: "idle" });
      params.onApproved(active.gatewayUrl);
      return;
    }
    if (body?.status === "rejected" || body?.status === "expired") {
      fail(body.status === "rejected" ? "declined" : "expired");
      return;
    }
    showCode(body?.status === "pending" ? "waiting" : "reconnecting", active);
    timer = setTimeout(() => void poll(current, active), BROWSER_PAIR_POLL_INTERVAL_MS);
  };

  const cancel = async () => {
    const active = attempt;
    if (!active || cancellationInFlight) {
      return;
    }
    // Retire in-flight collect before the first await: a late approval must not connect
    // after Cancel. The server decides whether withdrawal or approval won.
    invalidate();
    const current = generation;
    cancellationInFlight = true;
    showCode("cancelling", active);
    const result = await postBrowserPair({ ...active, action: "cancel" }).catch(() => null);
    if (current !== generation) {
      return;
    }
    cancellationInFlight = false;
    if (result?.response.ok && result.body.status === "cancelled") {
      stop();
      params.onState({ kind: "cancelled" });
    } else if (result?.response.ok && result.body.status === "expired") {
      fail("expired");
    } else if (result?.response.ok && result.body.status === "approved") {
      approvalNeedsContinuation = true;
      showCode("alreadyApproved", active);
    } else {
      showCode("cancelFailed", active);
    }
  };

  return {
    start: async (gatewayUrl: string) => {
      stop();
      const current = generation;
      attemptGatewayUrl = gatewayUrl;
      const basePath = params.basePath;
      params.onState({ kind: "starting" });
      const identity = await loadOrCreateDeviceIdentity().catch(() => null);
      if (current !== generation) {
        return;
      }
      if (!identity) {
        fail("noIdentity");
        return;
      }
      const result = await postBrowserPair({ basePath, action: "start", identity }).catch(
        () => null,
      );
      if (current !== generation) {
        return;
      }
      if (result?.body.error === "identity_required") {
        fail("identityRequired");
        return;
      }
      const body = result?.response.ok ? result.body : undefined;
      if (!body?.requestId || !body.code) {
        fail(result?.response.status === 429 ? "busy" : "unavailable");
        return;
      }
      attempt = {
        gatewayUrl,
        basePath,
        identity,
        requestId: body.requestId,
        code: formatBrowserPairCode(body.code),
        browserId: formatBrowserPairDeviceId(body.deviceId ?? identity.deviceId),
      };
      showCode("waiting", attempt);
      void poll(current, attempt);
    },
    cancel,
    continueAfterApproval: () => {
      if (attempt && approvalNeedsContinuation) {
        approvalNeedsContinuation = false;
        invalidate();
        showCode("waiting", attempt);
        void poll(generation, attempt);
      }
    },
    /** Target changes retire this view locally; unlike Cancel, they do not claim withdrawal. */
    retireUnlessTarget: (gatewayUrl: string | undefined) => {
      if (attemptGatewayUrl !== undefined && attemptGatewayUrl !== gatewayUrl) {
        stop();
        params.onState({ kind: "idle" });
      }
    },
    dispose: stop,
  };
}
