import { resolveConfigPath, resolveIsNixMode } from "../config/paths.js";
import { isTruthyEnvValue } from "./env.js";
import type { UpdateResultPayload } from "./update-result-payload.js";

const DEFAULT_ENDPOINT = "https://telemetry.openclaw.ai/api/latest-version";
const REQUEST_TIMEOUT_MS = 3000;
const USER_AGENT = "openclaw-update-result/1";

/**
 * Host-only automatic update-request policy. Unlike the daily check, a custom
 * endpoint does not lift CI suppression. Unreadable or invalid config fails closed.
 */
export async function readUpdateResultPolicy(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (
    isTruthyEnvValue(env.OPENCLAW_NO_AUTO_UPDATE) ||
    isTruthyEnvValue(env.CI) ||
    resolveIsNixMode(env)
  ) {
    return false;
  }
  try {
    // Loaded lazily so update writers and their recovery entries stay light.
    const { readCurrentConfigForPolicyCheck } = await import("../config/io.js");
    const config = readCurrentConfigForPolicyCheck({ configPath: resolveConfigPath(env), env });
    return config.update?.checkOnStart !== false;
  } catch {
    return false;
  }
}

/**
 * Dispatch a claimed outcome after its terminal write committed. Independent of
 * the daily-check cache and never awaited by update, recovery, or startup.
 */
export async function sendUpdateResultTelemetry(
  payload: UpdateResultPayload,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  try {
    const env = options.env ?? process.env;
    if (process.env.VITEST !== undefined || process.env.NODE_ENV === "test") {
      return;
    }
    const endpoint = env.OPENCLAW_TELEMETRY_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
    const url = new URL(endpoint);
    // No embedded credentials, redirects, cookies, or version-bearing headers.
    if (url.username || url.password || !["https:", "http:"].includes(url.protocol)) {
      return;
    }
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 4096 || !(await readUpdateResultPolicy(env))) {
      return;
    }
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    // Legacy receivers reject HEAD without recording it. Never send outcome data
    // until this exact endpoint advertises the separately configured receiver.
    const capability = await fetch(endpoint, {
      method: "HEAD",
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "User-Agent": USER_AGENT },
      signal,
    });
    await capability.body?.cancel();
    if (
      capability.status !== 204 ||
      capability.headers.get("OpenClaw-Update-Results") !== "2" ||
      !(await readUpdateResultPolicy(env))
    ) {
      return;
    }
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body,
      signal,
    });
    await response.body?.cancel();
  } catch {
    // No retry, raw payload/error logging, or recursive telemetry on failure.
  }
}
