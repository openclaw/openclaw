import type { LinqProbe } from "./types.js";
import { loadConfig } from "../config/config.js";
import { resolveLinqAccount } from "./accounts.js";

const LINQ_API_BASE = "https://api.linqapp.com/api/partner/v3";

/**
 * Probe Linq API availability by listing phone numbers.
 *
 * @param token - Linq API token (if not provided, resolved from config).
 * @param timeoutMs - Request timeout in milliseconds.
 */
export async function probeLinq(
  token?: string,
  timeoutMs?: number,
  accountId?: string,
): Promise<LinqProbe> {
  let resolvedToken = token?.trim() ?? "";
  if (!resolvedToken) {
    const cfg = loadConfig();
    const account = resolveLinqAccount({ cfg, accountId });
    resolvedToken = account.token;
  }
  if (!resolvedToken) {
    return { ok: false, error: "Linq API token not configured" };
  }

  const url = `${LINQ_API_BASE}/phonenumbers`;
  const controller = new AbortController();
  const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${resolvedToken}`, "User-Agent": "OpenClaw/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { ok: false, error: `Linq API ${response.status}: ${text.slice(0, 200)}` };
    }
    const data = (await response.json()) as {
      phone_numbers?: Array<{ phone_number?: string }>;
    };
    const phoneNumbers = (data.phone_numbers ?? [])
      .map((p) => p.phone_number)
      .filter(Boolean) as string[];
    return { ok: true, phoneNumbers };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, error: `Linq probe timed out (${timeoutMs}ms)` };
    }
    return { ok: false, error: String(err) };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
