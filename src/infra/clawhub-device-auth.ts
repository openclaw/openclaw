import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import {
  fetchClawHubJson,
  parseClawHubJsonBody,
  resolveClawHubBaseUrl,
  withClawHubResponse,
  type ClawHubFetchOptions,
} from "./clawhub-client.js";

const MAX_DEVICE_RESPONSE_BYTES = 8 * 1024;

export async function startClawHubDeviceSignIn(options: ClawHubFetchOptions) {
  const baseUrl = resolveClawHubBaseUrl(options.baseUrl);
  const result = await fetchClawHubJson<unknown>({
    ...options,
    baseUrl,
    path: "/api/cli/device/code",
    method: "POST",
    skipAuth: true,
    json: { label: "OpenClaw Template publishing", site_url: baseUrl },
    maxResponseBytes: MAX_DEVICE_RESPONSE_BYTES,
  });
  if (!isRecord(result)) {
    throw new Error("ClawHub returned an invalid sign-in response.");
  }
  const verificationUrl =
    typeof result.verification_uri === "string" ? URL.parse(result.verification_uri) : null;
  const deviceCode = result.device_code;
  const userCode = result.user_code;
  const interval = result.interval;
  const expiresIn = result.expires_in;
  if (
    !verificationUrl ||
    verificationUrl.origin !== new URL(baseUrl).origin ||
    verificationUrl.pathname !== "/cli/device" ||
    verificationUrl.username ||
    verificationUrl.password ||
    typeof userCode !== "string" ||
    !/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u.test(userCode) ||
    typeof deviceCode !== "string" ||
    !deviceCode ||
    typeof interval !== "number" ||
    !Number.isSafeInteger(interval) ||
    interval <= 0 ||
    interval > 60 ||
    typeof expiresIn !== "number" ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn > 15 * 60 ||
    expiresIn <= interval
  ) {
    throw new Error("ClawHub returned an invalid sign-in response.");
  }
  registerSecretValueForRedaction(deviceCode);
  return {
    deviceCode,
    // Open the bare verification page. Only the short human-facing code belongs on the card.
    verificationUrl: new URL(verificationUrl.pathname, verificationUrl.origin).href,
    userCode,
    intervalMs: interval * 1_000,
    expiresInMs: expiresIn * 1_000,
  };
}

type ClawHubDeviceSignInResult =
  | { kind: "pending" }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "authorized"; token: string };

export async function pollClawHubDeviceSignIn(
  deviceCode: string,
  options: ClawHubFetchOptions,
): Promise<ClawHubDeviceSignInResult> {
  return await withClawHubResponse(
    {
      ...options,
      path: "/api/cli/device/token",
      method: "POST",
      skipAuth: true,
      json: {
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      },
    },
    async ({ response, url }) => {
      const result = await parseClawHubJsonBody<unknown>(
        response,
        url,
        options.timeoutMs,
        MAX_DEVICE_RESPONSE_BYTES,
      ).catch(() => null);
      if (isRecord(result)) {
        if (
          response.ok &&
          result.token_type === "bearer" &&
          typeof result.access_token === "string" &&
          result.access_token
        ) {
          registerSecretValueForRedaction(result.access_token);
          return { kind: "authorized", token: result.access_token };
        }
        if (response.status === 428 && result.error === "authorization_pending") {
          return { kind: "pending" };
        }
        if (response.status === 400 && result.error === "access_denied") {
          return { kind: "denied" };
        }
        if (response.status === 400 && result.error === "expired_token") {
          return { kind: "expired" };
        }
      }
      throw new Error("ClawHub could not confirm sign-in. Try signing in again.");
    },
  );
}
