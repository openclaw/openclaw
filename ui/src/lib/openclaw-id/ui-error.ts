import { registerOpenClawIdEnglish } from "../../i18n/locales/en-openclaw-id.ts";
import { formatUiError } from "../format-error.ts";
import { registerEnglishCatalog, t } from "../reactive/i18n.ts";

registerEnglishCatalog(registerOpenClawIdEnglish);

/** The action supplies context where one protocol code covers several causes. */
export type OpenClawIdErrorContext =
  | "setup"
  | "signIn"
  | "linkCode"
  | "devices"
  | "remove"
  | "approval"
  | "saveKit"
  | "signOut"
  | "open";
/** Plain guidance and redacted diagnostics have separate display destinations. */
export type OpenClawIdUiError = { message: string; detail: string };

// Only stable codes select a cause. Arbitrary service prose is never primary copy.
const CODE_KEYS: Record<string, string> = {
  not_prepared: "errorNotPrepared",
  already_linked: "errorAlreadyLinked",
  not_linked: "errorNotLinked",
  issuer_unavailable: "errorIssuerUnavailable",
  issuer_invalid: "errorIssuerInvalid",
  id_token_invalid: "errorAccountInvalid",
  state_mismatch: "errorSignInExpired",
  signed_out: "errorSignedOut",
  token_exchange_failed: "errorTokenExchange",
  target_mismatch: "errorVerification",
  wrong_domain: "errorAddressMismatch",
  registration_mismatch: "errorRegistrationMismatch",
  wrong_claw: "errorVerification",
  root_mismatch: "errorVerification",
  wrong_signer: "errorVerification",
  host_mismatch: "errorVerification",
  rollback: "errorVerification",
  bad_proof: "errorVerification",
  audience_mismatch: "errorVerification",
  not_an_owner: "errorNotOwner",
  limit_reached: "errorLimitReached",
  caps_escalation: "errorCapsEscalation",
  missing_capability: "errorNotOwner",
  bad_signature: "errorVerification",
  invalid_statement: "errorVerification",
  unauthorized: "errorNotOwner",
  not_owner: "errorNotOwner",
  not_direct: "errorNotOwner",
  expired: "errorExpired",
  not_yet_valid: "errorNotYetValid",
  seq_conflict: "errorConcurrentChange",
  invite_not_pending: "errorNotPending",
  invite_unknown: "errorNotPending",
  invite_used: "errorNotPending",
  name_taken: "errorNameTaken",
  registration_unsettled: "errorRegistrationUnsettled",
  tunnel_not_running: "errorRemoteNotReady",
  conflict: "errorConflict",
  bad_request: "errorRequest",
  malformed: "errorRequest",
};

// RPC failures carry the domain code in details; publication failures carry it directly.
function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  if (
    "details" in error &&
    error.details &&
    typeof error.details === "object" &&
    "code" in error.details &&
    typeof error.details.code === "string"
  ) {
    return error.details.code;
  }
  return "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Translate known OpenClaw ID refusals without guessing a cause from backend prose. */
export function openClawIdUiError(
  error: unknown,
  context: OpenClawIdErrorContext = "setup",
): OpenClawIdUiError {
  const code = errorCode(error);
  let key = code && Object.hasOwn(CODE_KEYS, code) ? CODE_KEYS[code] : undefined;
  if (code === "not_local_operator") {
    key = context === "signIn" ? "signInLocalOnly" : "makeReachableLocalOnly";
  }
  if (code === "unconfigured") {
    key = context === "signIn" ? "signInUnconfigured" : "needsLoaderDomain";
  }
  if (code === "unavailable" || code === "registration_unavailable") {
    key = context === "linkCode" ? "errorLinkCodeUnavailable" : "errorUnavailable";
  }
  // Invalid sign-in input includes a rejected local callback, not permission to sign in remotely.
  if (code === "malformed" && context === "signIn") {
    key = "errorSignInLocal";
  }
  // Locally authored messages have no wire code; match exact known states only.
  const localMessage =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const localKeys: Record<string, string> = {
    "This browser is not an owner device for this claw.": "errorNotOwner",
    "This browser does not hold an active owner device key.": "errorNotOwner",
    "This browser is no longer an active owner device.": "errorNotOwner",
    "Sign in with OpenClaw ID to approve another device.": "errorApprovalSignIn",
    "OpenClaw ID sign-in expired. Sign in again to continue.": "errorSignedOut",
    "This browser needs Web Locks to coordinate owner approval across tabs.":
      "errorApprovalBrowser",
    "Another tab is listening for owner approval. Use that tab, or close it and Retry here.":
      "errorApprovalTab",
    "This device request expired or was cancelled.": "errorApprovalExpired",
    "Wait for the matching number on both screens.": "errorApprovalWait",
    "Sign-in timed out. Try again.": "errorSignInExpired",
  };
  key ??= Object.hasOwn(localKeys, localMessage) ? localKeys[localMessage] : undefined;
  // Never serialize an arbitrary object: only the explicit error message is diagnostic text.
  const diagnostic =
    error instanceof Error || typeof error === "string"
      ? error
      : error &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : "";
  const raw = formatUiError(typeof diagnostic === "string" ? diagnostic : diagnostic.message);
  const detail = raw
    .replace(/\bOCK1[\sA-Za-z0-9_-]{20,}/g, "[redacted recovery code]")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/[A-Za-z0-9_+/=-]{32,}/g, "[redacted value]")
    .replace(/([?#])[^\s<>"']+/g, "$1[redacted]")
    .replace(
      /\b(?:code|id_token|access_token|refresh_token|enrollmentCode)\s*[:=]\s*[^\s,}]+/gi,
      "credential=[redacted]",
    )
    .slice(0, 2000);
  return { message: t(`openclawId.${key ?? `error_${context}`}`), detail };
}

/** Build rich toast content with diagnostics collapsed until explicitly opened. */
export function openClawIdErrorToast(error: unknown, context: OpenClawIdErrorContext): HTMLElement {
  const value = openClawIdUiError(error, context);
  const content = document.createElement("div");
  const message = document.createElement("div");
  message.textContent = value.message;
  content.append(message);
  if (value.detail) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = t("openclawId.technicalDetails");
    const diagnostic = document.createElement("div");
    diagnostic.style.overflowWrap = "anywhere";
    diagnostic.textContent = value.detail;
    details.append(summary, diagnostic);
    content.append(details);
  }
  return content;
}
