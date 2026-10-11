// Stores short-lived device onboarding join codes through the pairing worker.
import { DEVICE_PAIRING_JOIN_CODE_BYTES, isDevicePairingJoinCode } from "../pairing/join-code.js";
import { decodePairingSetupCode, encodePairingSetupCode } from "../pairing/setup-code.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { executeDevicePairingMutation } from "./device-pairing-worker.js";
import { generateSecureToken } from "./secure-random.js";

type PairingSetupPayload = ReturnType<typeof decodePairingSetupCode>;
type JoinCodeAuthority = {
  context?: OpenClawStateWorkerContext;
  assertCurrent?: () => void;
};

/** Register one setup payload under a random 128-bit shortcode. */
export async function registerDevicePairingJoinCode(
  params: JoinCodeAuthority & {
    payload: PairingSetupPayload;
    expiresAtMs: number;
  },
): Promise<string> {
  const createdAtMs = Date.now();
  const expiresAtMs = params.expiresAtMs;
  const assertCallerCurrent = params.assertCurrent;
  const assertCurrent = () => {
    assertCallerCurrent?.();
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new Error("Device pairing join code requires a future expiry.");
    }
  };
  assertCurrent();
  const payloadJson = JSON.stringify(
    decodePairingSetupCode(encodePairingSetupCode(params.payload)),
  );
  const shortcode = generateSecureToken(DEVICE_PAIRING_JOIN_CODE_BYTES);
  await executeDevicePairingMutation(
    {
      type: "devicePairing.registerJoinCode",
      input: { shortcode, payloadJson, createdAtMs, expiresAtMs },
    },
    { context: params.context, assertCurrent },
  );
  assertCurrent();
  return shortcode;
}

/** Atomically burn one live shortcode and return its validated setup payload. */
export async function redeemDevicePairingJoinCode(
  params: JoinCodeAuthority & {
    shortcode: string;
  },
): Promise<PairingSetupPayload | null> {
  const shortcode = params.shortcode.trim();
  if (!isDevicePairingJoinCode(shortcode)) {
    return null;
  }
  const row = await executeDevicePairingMutation(
    { type: "devicePairing.redeemJoinCode", input: { shortcode } },
    { context: params.context, assertCurrent: params.assertCurrent },
  );
  const nowMs = Date.now();
  if (!row || row.expires_at_ms <= nowMs) {
    return null;
  }
  try {
    return decodePairingSetupCode(Buffer.from(row.payload_json, "utf8").toString("base64url"), {
      nowMs,
    });
  } catch {
    return null;
  }
}
