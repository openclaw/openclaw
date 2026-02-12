// Iron palette tokens for CLI/UI theming. "iron seam" == use this palette.
// Keep in sync with docs/cli/index.md (CLI palette section).
export const IRON_PALETTE = {
  accent: "#9CA3AF", // cool steel grey
  accentBright: "#D1D5DB", // bright silver highlight
  accentDim: "#6B7280", // dark iron
  info: "#93C5FD", // steel blue
  success: "#34D399", // emerald
  warn: "#FBBF24", // amber
  error: "#F87171", // red
  muted: "#6B7280", // iron grey
} as const;

// Backward-compatible alias for any external importers.
export { IRON_PALETTE as LOBSTER_PALETTE };
