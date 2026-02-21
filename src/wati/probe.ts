import type { BaseProbeResult } from "../channels/plugins/types.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export type WatiProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs: number;
  phone?: string | null;
  name?: string | null;
};

/**
 * Health check for a WATI account. Makes a light API call to verify token validity.
 */
export async function probeWati(
  apiToken: string,
  apiBaseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<WatiProbe> {
  const started = Date.now();
  const base = apiBaseUrl.replace(/\/+$/, "");

  const result: WatiProbe = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0,
    phone: null,
    name: null,
  };

  try {
    const res = await fetchWithTimeout(
      `${base}/api/ext/v3/contacts?pageSize=1`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
      },
      timeoutMs,
    );

    result.status = res.status;

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      result.error = `WATI API error ${res.status}: ${body}`;
      result.elapsedMs = Date.now() - started;
      return result;
    }

    result.ok = true;
    result.status = null;
    result.error = null;
    result.elapsedMs = Date.now() - started;
    return result;
  } catch (err) {
    return {
      ...result,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - started,
    };
  }
}
