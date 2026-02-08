import type { ObaVerificationResult } from "./types.js";
import { theme } from "../../terminal/theme.js";

/** Format an OBA verification status as a styled badge for CLI output. */
export function formatObaBadge(verification?: ObaVerificationResult): string {
  if (!verification || verification.status === "unsigned") {
    return "";
  }
  switch (verification.status) {
    case "signed":
      return theme.muted("signed");
    case "verified":
      return theme.success("verified");
    case "invalid":
      return theme.error("invalid");
    default:
      return "";
  }
}
