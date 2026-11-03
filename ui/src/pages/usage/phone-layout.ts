import { createMediaQuery } from "../../lib/reactive/platform.ts";

const USAGE_PHONE_QUERY = "(max-width: 640px)";

/** Phone widths trade the full toolbar for presets, metric, and a filter sheet. */
export function createUsagePhoneLayout() {
  return createMediaQuery(USAGE_PHONE_QUERY, globalThis.matchMedia?.(USAGE_PHONE_QUERY).matches);
}
