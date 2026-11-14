import type { ThemesMutationResult } from "../../../packages/gateway-protocol/src/schema/themes.ts";
import {
  normalizeThemeDefinition,
  parseThemeDefinition,
  THEME_LOCAL_ID_MAX_LENGTH,
  type ThemePalette,
} from "../../../packages/gateway-protocol/src/theme.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "./context-types.ts";
import type { ImportedCustomTheme } from "./custom-theme.ts";
import { hasOperatorWriteAccess } from "./operator-access.ts";
import type { UiSettings } from "./settings-contract.ts";
import type { ThemeName } from "./theme.ts";

type ThemeTokens = ImportedCustomTheme["light"];

// The imported token map keeps every tweakcn source value under these names.
const PALETTE_TOKENS = {
  background: "bg",
  foreground: "text",
  card: "card",
  "card-foreground": "card-foreground",
  popover: "popover",
  "popover-foreground": "popover-foreground",
  primary: "primary",
  "primary-foreground": "primary-foreground",
  secondary: "secondary",
  "secondary-foreground": "secondary-foreground",
  muted: "bg-muted",
  "muted-foreground": "muted-foreground",
  accent: "accent",
  "accent-foreground": "accent-foreground",
  destructive: "destructive",
  "destructive-foreground": "destructive-foreground",
  border: "border",
  input: "input",
  ring: "ring",
  "font-sans": "font-body",
  "font-mono": "mono",
} as const satisfies Record<keyof ThemePalette, keyof ThemeTokens>;

function themeDefinition(theme: ImportedCustomTheme, fonts: boolean) {
  const palette = (tokens: ThemeTokens) =>
    Object.fromEntries(
      Object.entries(PALETTE_TOKENS)
        .filter(([key]) => fonts || !key.startsWith("font-"))
        .map(([key, token]) => [key, tokens[token]]),
    );
  return {
    name: theme.label || theme.themeId.slice(0, 80),
    description: theme.sourceUrl,
    light: palette(theme.light),
    dark: palette(theme.dark),
  };
}

/** Saves a tweakcn import as the signed-in person's `user/tweakcn-<id>` theme. */
export async function saveCustomThemeToProfile(
  client: GatewayBrowserClient,
  theme: ImportedCustomTheme,
): Promise<ThemesMutationResult> {
  const id = `tweakcn-${theme.themeId.toLowerCase()}`.slice(0, THEME_LOCAL_ID_MAX_LENGTH);
  // Long tweakcn system font stacks exceed portable theme limits; those themes use OpenClaw's fonts.
  const definition =
    parseThemeDefinition(themeDefinition(theme, true)) ??
    normalizeThemeDefinition(themeDefinition(theme, false));
  return client.request<ThemesMutationResult>("themes.import", { id, definition });
}

/** The connection that may save personal themes: a signed-in profile with write access. */
export function profileThemeWriter(gateway: ApplicationGatewaySnapshot) {
  const { client, hello, phase, selfUser } = gateway;
  return phase === "connected" && client && selfUser && hasOperatorWriteAccess(hello?.auth ?? null)
    ? client
    : null;
}

/** Saves a new import as a personal theme, or keeps the browser slot without a profile writer. */
export async function saveImportedTheme(
  theme: ImportedCustomTheme,
  context: Pick<ApplicationContext, "gateway" | "theme">,
): Promise<{ label: string; patch: Pick<UiSettings, "customTheme">; themeId: ThemeName }> {
  const client = profileThemeWriter(context.gateway.snapshot);
  if (!client) {
    return { label: theme.label, patch: { customTheme: theme }, themeId: "custom" };
  }
  const saved = await saveCustomThemeToProfile(client, theme);
  // Selecting before the catalog refresh lands must not fall back to Claw.
  context.theme.rememberTheme?.(saved);
  return { label: theme.label, patch: {}, themeId: saved.theme.id };
}
