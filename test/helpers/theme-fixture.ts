import type { ThemeDefinition, ThemePalette } from "../../packages/gateway-protocol/src/theme.js";

export function createThemePaletteFixture(overrides: Partial<ThemePalette> = {}): ThemePalette {
  return {
    background: "#101020",
    foreground: "#eeeeff",
    card: "#171729",
    "card-foreground": "#eeeeff",
    popover: "#171729",
    "popover-foreground": "#eeeeff",
    primary: "#b3ff33",
    "primary-foreground": "#101020",
    secondary: "#222238",
    "secondary-foreground": "#eeeeff",
    muted: "#222238",
    "muted-foreground": "#aaaabb",
    accent: "#33eeff",
    "accent-foreground": "#101020",
    destructive: "#ff3355",
    "destructive-foreground": "#ffffff",
    border: "#444455",
    input: "#444455",
    ring: "#33eeff",
    "font-sans": "ui-monospace, monospace",
    "font-mono": "ui-monospace, monospace",
    ...overrides,
  };
}

export function createThemeDefinitionFixture(
  overrides: Partial<ThemeDefinition> = {},
): ThemeDefinition {
  return {
    name: "Xenovessel",
    description: "Indigo, acid lime, and alien cyan",
    dark: createThemePaletteFixture(),
    ...overrides,
  };
}
