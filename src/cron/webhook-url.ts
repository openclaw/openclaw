import { isHttpUrl } from "@openclaw/net-policy/url-protocol";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Normalizes cron webhook URLs while rejecting empty, malformed, and non-HTTP(S) values. */
export function normalizeHttpWebhookUrl(value: unknown): string | null {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return null;
  }
  const parsed = URL.parse(trimmed);
  // Fetch rejects URL userinfo before dispatch. Fail at the shared boundary so
  // validation and doctor migration do not preserve a target that cannot deliver.
  return parsed && isHttpUrl(parsed) && !parsed.username && !parsed.password ? trimmed : null;
}
