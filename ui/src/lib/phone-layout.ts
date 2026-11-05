/** The phone breakpoint the shared page-header styles use. */
export const PHONE_LAYOUT_QUERY =
  "(max-width: 768px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)";

export function isPhoneLayout(): boolean {
  return globalThis.matchMedia?.(PHONE_LAYOUT_QUERY).matches ?? false;
}
