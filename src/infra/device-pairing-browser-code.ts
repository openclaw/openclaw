// Device-code pairing for browsers that hold no Gateway credential yet.
import { randomInt, randomUUID } from "node:crypto";
import { buildBrowserPairCode } from "../shared/browser-pair.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { withDevicePairingLock } from "./device-pairing-lock.js";
import { publishDevicePairingResolution } from "./device-pairing-resolution.js";
import {
  DevicePairingAuthorityRefusedError,
  executeDevicePairingMutation,
} from "./device-pairing-worker.js";

const BROWSER_PAIR_REQUEST_TTL_MS = 10 * 60 * 1000;
// The route is public, so a source rotating its address can keep this table full and
// delay other browsers for as long as it keeps filing. State stays bounded and
// shared-secret and `openclaw dashboard` sign-in stay available.
const BROWSER_PAIR_MAX_PENDING = 32;
const BROWSER_PAIR_CODE_CANDIDATES = 4;

type BrowserPairAuthority = {
  context?: OpenClawStateWorkerContext;
  assertCurrent?: () => void;
};

export async function startBrowserPairRequest(
  params: BrowserPairAuthority & {
    deviceId: string;
    publicKey: string;
    remoteIp?: string;
    userAgent?: string;
    origin?: string;
  },
) {
  const { context, assertCurrent, ...request } = params;
  const nowMs = Date.now();
  return await executeDevicePairingMutation(
    {
      type: "devicePairing.startBrowserRequest",
      input: {
        ...request,
        requestId: randomUUID(),
        codeCandidates: Array.from({ length: BROWSER_PAIR_CODE_CANDIDATES }, () =>
          buildBrowserPairCode((max) => randomInt(0, max)),
        ),
        nowMs,
        expiresAtMs: nowMs + BROWSER_PAIR_REQUEST_TTL_MS,
        maxPending: BROWSER_PAIR_MAX_PENDING,
      },
    },
    { context, assertCurrent },
  );
}

export async function cancelBrowserPairRequest(
  params: BrowserPairAuthority & { requestId: string; deviceId: string; publicKey: string },
) {
  const { context, assertCurrent, ...input } = params;
  return await executeDevicePairingMutation(
    { type: "devicePairing.cancelBrowserRequest", input },
    { context, assertCurrent },
  );
}

export async function collectBrowserPairRequest(
  params: BrowserPairAuthority & { requestId: string; deviceId: string; publicKey: string },
) {
  const { context, assertCurrent, ...input } = params;
  const collected = await executeDevicePairingMutation(
    { type: "devicePairing.collectBrowserRequest", input: { ...input, nowMs: Date.now() } },
    { context, assertCurrent },
  );
  if (collected.status !== "approved") {
    return collected;
  }
  // The clock above was read before waiting for the lock and worker; the deadline
  // bounds handing the token over, so check it again before it leaves.
  const { expiresAtMs, ...approved } = collected;
  return expiresAtMs <= Date.now() ? { status: "expired" as const } : approved;
}

export async function inspectBrowserPairRequest(params: BrowserPairAuthority & { code: string }) {
  return await executeDevicePairingMutation(
    {
      type: "devicePairing.inspectBrowserRequest",
      input: { code: params.code, nowMs: Date.now() },
    },
    { context: params.context, assertCurrent: params.assertCurrent },
  );
}

export async function decideBrowserPairRequest(
  params: BrowserPairAuthority & {
    code: string;
    requestId: string;
    decision: "approve" | "reject";
    /** Scopes of the approving operator; the paired grant must stay within them. */
    callerScopes: readonly string[];
    /** Live shared-auth generation; issued browser tokens are bound to it. */
    readSharedGatewaySessionGeneration?: () => string | undefined;
  },
) {
  const { context, assertCurrent, readSharedGatewaySessionGeneration, ...input } = params;
  return await withDevicePairingLock(async () => {
    const nowMs = Date.now();
    const sharedGatewaySessionGeneration = readSharedGatewaySessionGeneration?.();
    let expired = false;
    const result = await executeDevicePairingMutation(
      {
        type: "devicePairing.decideBrowserRequest",
        input: {
          ...input,
          sharedGatewaySessionGeneration,
          nowMs,
          collectExpiresAtMs: nowMs + BROWSER_PAIR_REQUEST_TTL_MS,
        },
      },
      {
        context,
        assertCurrent,
        // The writer queue can hold an approval past the deadline the worker saw, so
        // the live clock decides at admission and a late approval rolls back.
        admit: (facts) => {
          if (facts.kind !== "browser-pair.decision") {
            return;
          }
          if (facts.expiresAtMs <= Date.now()) {
            expired = true;
            throw new DevicePairingAuthorityRefusedError("Browser pairing request expired");
          }
          // A shared secret rotated while queued would issue a token that is already stale.
          if (readSharedGatewaySessionGeneration?.() !== sharedGatewaySessionGeneration) {
            throw new DevicePairingAuthorityRefusedError("Gateway shared auth changed");
          }
        },
        onAuthorityRefused: () => {
          if (!expired) {
            throw new DevicePairingAuthorityRefusedError();
          }
          return { status: "expired" as const };
        },
      },
    );
    if (result.status === "approved") {
      for (const superseded of result.superseded) {
        publishDevicePairingResolution(superseded, "superseded");
      }
    }
    return result;
  }, "devicePairing.decideBrowserRequest");
}
