export const TAILSCALE_EXPOSURE_OPTIONS = [
  { value: "off", label: "Off", hint: "No Tailscale exposure" },
  {
    value: "serve",
    label: "Serve",
    hint: "Private HTTPS for your tailnet (devices on Tailscale)",
  },
  {
    value: "funnel",
    label: "Funnel",
    hint: "Public HTTPS via Tailscale Funnel (internet)",
  },
] as const;

export const TAILSCALE_MISSING_BIN_NOTE_LINES = [
  "Tailscale binary not found in PATH or /Applications.",
  "Ensure Tailscale is installed from:",
  "  https://tailscale.com/download/mac",
  "",
  "You can continue setup, but serve/funnel will fail at runtime.",
] as const;

export const TAILSCALE_DOCS_LINES = [
  "Docs:",
  "https://docs.openclaw.ai/gateway/tailscale",
  "https://docs.openclaw.ai/web",
] as const;
