// Small shared labels used by status message tests and compact command output.
import type { FastMode } from "@openclaw/normalization-core/string-coerce";

export const formatFastModeLabel = (mode: FastMode): string =>
  `Fast: ${mode === "auto" ? "auto" : mode ? "on" : "off"}`;
