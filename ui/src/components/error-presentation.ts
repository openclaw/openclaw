import { t } from "../i18n/index.ts";
import { clampText } from "../lib/format.ts";

const ERROR_ICON_PREFIX_TOKEN_RE = /(?:⚠️?|⛔|❌|🛠️?|✉️?)/gu;
const ERROR_ICON_PREFIX_RE = /^[ \t]*(?:⚠️?|⛔|❌|🛠️?|✉️?)(?:[ \t]*(?:⚠️?|⛔|❌|🛠️?|✉️?))*/u;

// Icon-backed error cards and rows replace these leading decoration/category glyphs.
// Keep all whitespace and body emoji intact; raw state, copy, transcript, and toasts bypass this.
export function formatWebUiIconErrorText(error: string): string {
  return error.replace(ERROR_ICON_PREFIX_RE, (prefix) =>
    prefix.replace(ERROR_ICON_PREFIX_TOKEN_RE, ""),
  );
}

/** Presentation only: Copy error and stored diagnostics keep the complete original. */
export function formatWebUiErrorNotice(
  displayError: string,
  options: { authRefresh?: boolean } = {},
): {
  summary: string;
  details?: string;
} {
  const text = displayError.trim();
  const [firstLine = "", ...rest] = text.split(/\r?\n/u);
  const headline = firstLine
    .replace(/^Error:\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  const bodyLines = rest.filter((line) => {
    const normalized = line.replace(/\s+/gu, " ").trim();
    return normalized !== headline && normalized !== firstLine.replace(/\s+/gu, " ").trim();
  });
  const body = bodyLines.join("\n").replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/gu, "");
  const missingScope = /^missing scope: (operator\.[a-z0-9._-]+)$/u.exec(headline)?.[1];
  if (missingScope && !body) {
    return {
      summary: t("chat.errorPermissionDenied"),
      details: t("chat.errorRequiredPermission", { scope: missingScope }),
    };
  }

  const reusedToken =
    headline ===
    "Your refresh token has already been used to generate a new access token. Please try signing in again.";
  const summary = reusedToken ? t("chat.errorSignInAgain") : clampText(headline);
  const detailLines = rest.map((line) => line.trim()).filter(Boolean);
  // These labels come from the Web UI's structured Gateway error adapter.
  // Do not collapse unknown diagnostics or remove their recovery instructions.
  const isAuthMetadata =
    options.authRefresh === true &&
    detailLines.length > 0 &&
    detailLines.every((line) => /^(?:Provider|HTTP status|Reason|Type): [^\r\n]+$/u.test(line));
  const details =
    summary !== headline && !reusedToken
      ? text
      : isAuthMetadata
        ? detailLines.map((line) => line.replace(/^HTTP status: /u, "HTTP ")).join("  ·  ")
        : body;
  const explanation = reusedToken ? t("chat.errorRefreshTokenReusedDetail") : "";
  const completeDetails = [explanation, details].filter(Boolean).join("\n");
  return { summary, ...(completeDetails ? { details: completeDetails } : {}) };
}
