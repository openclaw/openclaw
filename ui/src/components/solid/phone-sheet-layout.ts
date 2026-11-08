import { createMediaQuery } from "../../lib/reactive/platform.ts";

const PHONE_SHEET_QUERY =
  "(max-width: 640px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)";

/** Phone layouts open form-like filters as a sheet; everywhere else they stay popovers. */
export function createPhoneSheetLayout() {
  return createMediaQuery(PHONE_SHEET_QUERY, globalThis.matchMedia(PHONE_SHEET_QUERY).matches);
}
