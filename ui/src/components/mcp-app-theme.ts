// MCP Apps owns the keys; the carapace embed contract owns their meanings.
// Publish only sourced values so apps retain their fallbacks for unsupported keys.
const HOST_TOKEN_SOURCES = {
  "--color-background-primary": "--card",
  "--color-background-secondary": "--bg",
  "--color-background-tertiary": "--bg-elevated",
  "--color-background-inverse": "--text",
  "--color-background-disabled": "--bg-muted",
  "--color-background-success": "--ok-subtle",
  "--color-background-warning": "--warn-subtle",
  "--color-background-danger": "--danger-subtle",

  "--color-text-primary": "--text",
  "--color-text-secondary": "--muted-strong",
  "--color-text-tertiary": "--muted",
  "--color-text-inverse": "--bg",
  "--color-text-success": "--ok",
  "--color-text-warning": "--warn",
  "--color-text-danger": "--danger",
  "--color-text-info": "--info",

  "--color-border-primary": "--border",
  "--color-border-secondary": "--border-strong",
  // Inverse borders sit on the inverse background, so they use its foreground.
  "--color-border-inverse": "--bg",
  "--color-ring-primary": "--ring",

  "--font-text-xs-size": "--control-ui-text-xs",
  "--font-text-sm-size": "--control-ui-text-sm",
  "--font-text-md-size": "--control-ui-text-md",
  "--font-text-lg-size": "--control-ui-text-lg",

  "--border-radius-xs": "--radius-sm",
  "--border-radius-sm": "--radius-sm",
  "--border-radius-md": "--radius",
  "--border-radius-lg": "--radius-lg",
  "--border-radius-xl": "--radius-xl",
  "--border-radius-full": "--radius-full",

  "--shadow-sm": "--shadow-sm",
  "--shadow-md": "--shadow-md",
  "--shadow-lg": "--shadow-lg",
} as const;

// Keep these system-resolvable fonts byte-identical to carapace candidate/embed.css.
// Sandbox CSP admits only app-declared font domains, so host brand fonts may not load.
const STATIC_VARIABLES = {
  "--border-width-regular": "1px",
  "--font-weight-normal": "400",
  "--font-weight-medium": "500",
  "--font-weight-semibold": "600",
  "--font-weight-bold": "700",
  "--font-sans":
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji"',
  "--font-mono":
    'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
} as const;

type StyleVariableKey = keyof typeof HOST_TOKEN_SOURCES | keyof typeof STATIC_VARIABLES;
type StyleVariables = Partial<Record<StyleVariableKey, string>>;

// Resolve nested var() references before crossing into the app's separate origin.
export function collectMcpAppStyleVariables(
  root: HTMLElement | undefined = document.documentElement,
): StyleVariables | undefined {
  if (!root) {
    return undefined;
  }
  const computed = getComputedStyle(root);
  const variables: Record<string, string> = { ...STATIC_VARIABLES };
  for (const [specKey, hostToken] of Object.entries(HOST_TOKEN_SOURCES)) {
    const value = computed.getPropertyValue(hostToken).trim();
    if (value) {
      variables[specKey] = value;
    }
  }
  return variables as StyleVariables;
}
