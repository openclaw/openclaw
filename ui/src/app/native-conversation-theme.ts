import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { nativeEmbedHost } from "./native-web-chrome.ts";
import type { CatalogTheme } from "./theme-catalog.ts";
import { normalizeThemePalette } from "./theme-palette.ts";

/** Native sidebar colors are document presentation, not a web/profile preference write. */
export function readNativeConversationTheme(): CatalogTheme | undefined {
  const host = typeof window === "undefined" ? null : nativeEmbedHost();
  if (host?.platform !== "ios" || host.formFactor !== "pad" || host.surface !== "conversation") {
    return undefined;
  }
  const embed = asOptionalRecord(
    // SAFETY: optional document-start host metadata is validated by the normal palette reader.
    (window as Window & { __OPENCLAW_NATIVE_EMBED__?: unknown })["__OPENCLAW_NATIVE_EMBED__"],
  );
  const appearance = asOptionalRecord(embed?.appearance);
  const light = asOptionalRecord(appearance?.light);
  const dark = asOptionalRecord(appearance?.dark);
  if (!light || !dark) {
    return undefined;
  }
  try {
    const palette = (mode: "light" | "dark", values: Record<string, unknown>) => {
      const normalized = normalizeThemePalette(mode, values, undefined);
      return { ...normalized, "bg-content": normalized.bg };
    };
    return {
      branding: resolveThemeBranding(undefined),
      palette: {
        light: palette("light", light),
        dark: palette("dark", dark),
      },
    };
  } catch {
    return undefined;
  }
}
