import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";

export function normalizeSetupPresentationHttpsUrl(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  const url = normalized ? URL.parse(normalized) : null;
  if (!url) {
    return undefined;
  }
  const canonical = url.toString();
  return url.protocol === "https:" &&
    url.hostname &&
    !url.username &&
    !url.password &&
    canonical.length <= 2048
    ? canonical
    : undefined;
}
