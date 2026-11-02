// Device-code pairing for browsers that hold no Gateway credential yet.
import { randomInt, randomUUID } from "node:crypto";
import { buildBrowserPairCode } from "../shared/browser-pair.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { executeDevicePairingMutation } from "./device-pairing-worker.js";

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

export async function collectBrowserPairRequest(
  params: BrowserPairAuthority & { requestId: string; deviceId: string; publicKey: string },
) {
  const { context, assertCurrent, ...input } = params;
  return await executeDevicePairingMutation(
    { type: "devicePairing.collectBrowserRequest", input: { ...input, nowMs: Date.now() } },
    { context, assertCurrent },
  );
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
  },
) {
  const { context, assertCurrent, ...input } = params;
  return await executeDevicePairingMutation(
    { type: "devicePairing.decideBrowserRequest", input: { ...input, nowMs: Date.now() } },
    { context, assertCurrent },
  );
}
