// Activi palette tokens for CLI/UI theming. Gray/silver theme matching the Activi logo.
// Keep in sync with docs/cli/index.md (CLI palette section).
export const ACTIVI_PALETTE = {
  accent: "#6B6B6B", // Medium gray
  accentBright: "#9A9A9A", // Light silver-gray
  accentDim: "#4A4A4A", // Dark gray
  info: "#7A7A7A", // Info gray
  success: "#4CAF50", // Green for success (kept for contrast)
  warn: "#FFB020", // Orange for warnings (kept for contrast)
  error: "#E23D2D", // Red for errors (kept for contrast)
  muted: "#8B8B8B", // Muted gray
} as const;
