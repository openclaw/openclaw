import type { UiAppearancePreferenceValues } from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";

export type ContrastPreference = UiAppearancePreferenceValues["ui.contrast"];
export type EffectiveContrast = "standard" | "enhanced";

/** Also inlined into first paint by the Vite HTML transform; keep this pure and self-contained. */
export function resolveContrast(
  preference: unknown,
  systemMore: boolean,
  supported = true,
): EffectiveContrast {
  return supported && (preference === "enhanced" || (preference !== "standard" && systemMore))
    ? "enhanced"
    : "standard";
}
