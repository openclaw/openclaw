import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  ConnectErrorDetailCodes,
  type readPairingConnectErrorDetails,
} from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";
import {
  redactLoginFailureError,
  resolveAuthHintKind,
  resolvePairingHint,
  shouldShowInsecureContextHint,
} from "../lib/connection-hints.ts";
import { formatGatewayHost } from "../lib/gateway-host.ts";
import { classifyGatewaySecret } from "../lib/gateway-secret-shape.ts";
import { t } from "../lib/reactive/i18n.ts";

function isPasswordModeErrorCode(code: string | null): boolean {
  return (
    code === ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING ||
    code === ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH ||
    code === ConnectErrorDetailCodes.AUTH_PASSWORD_NOT_CONFIGURED
  );
}

type LoginFailureKind =
  | "auth-required"
  | "auth-failed"
  | "bootstrap-invalid"
  | "trusted-proxy"
  | "auth-rate-limited"
  | "profile-unavailable"
  | "verified-user-required"
  | "access-denied"
  | "pairing-required"
  | "pairing-rejected"
  | "pairing-expired"
  | "insecure-context"
  | "origin-not-allowed"
  | "build-mismatch"
  | "protocol-mismatch"
  | "busy"
  | "network";

/**
 * Where the fix lives decides the layout. "form": the operator fixes it in this
 * form (URL or credential), so the form leads. "status": the fix happens on the
 * Gateway host or in the browser, so the explanation leads and the form folds
 * away into a one-line connection summary.
 */
type LoginFailurePlacement = "form" | "status";

/** Pending is an expected wait, not a fault; the palette follows that distinction. */
type LoginFailureTone = "pending" | "warn" | "danger";

type LoginFormField = "url" | "credential";

export type LoginFailureStep = {
  text: string;
  commands: string[];
};

type LoginFailureStepDefinition =
  | string
  | {
      key: string;
      commands: string[];
    };

export type LoginFailureFeedback = {
  kind: LoginFailureKind;
  placement: LoginFailurePlacement;
  tone: LoginFailureTone;
  field?: LoginFormField;
  title: string;
  summary: string;
  /** One command that resolves the failure on its own, shown as the hero action. */
  primaryCommand?: string;
  refreshAction?: { label: string };
  steps: LoginFailureStep[];
  details?: string[];
  docsHref: string;
  rawError: string;
};

export type LoginFailureFeedbackParams = Parameters<typeof resolveAuthHintKind>[0] & {
  lastErrorPairing?: ReturnType<typeof readPairingConnectErrorDetails>;
  gatewayUrl?: string;
  secret?: string;
  reconnectPending?: boolean;
  reconnectAt?: number;
};

type PairingCopy = { titleKey: string; summaryKey: string; params?: Record<string, string> };

/**
 * Titles follow what approval would grant, not the Gateway's reason code alone: a
 * revoked token for an approved role is reported as "role-upgrade" but adds nothing.
 */
function resolvePairingCopy(
  kind: string,
  pairing: LoginFailureFeedbackParams["lastErrorPairing"],
): PairingCopy {
  if (kind === "pairing-required") {
    return { titleKey: "title", summaryKey: "summary" };
  }
  if (kind === "metadata-upgrade-pending") {
    return { titleKey: "metadataTitle", summaryKey: "upgradeSummary" };
  }
  const role = pairing?.requestedRole;
  const approvedRoles = pairing?.approvedRoles ?? [];
  if (!role || !pairing?.requestedScopes) {
    return {
      titleKey: kind === "role-upgrade-pending" ? "roleTitle" : "scopeTitle",
      summaryKey: "upgradeSummary",
    };
  }
  if (!approvedRoles.includes(role)) {
    return { titleKey: "roleTitle", summaryKey: "roleSummary", params: { role } };
  }
  const allowedScopes = pairing.approvedScopes ?? [];
  const added = pairing.requestedScopes.filter(
    (scope) => !roleScopesAllow({ role, requestedScopes: [scope], allowedScopes }),
  );
  return added.length > 0
    ? { titleKey: "scopeTitle", summaryKey: "scopeSummary", params: { scopes: added.join(", ") } }
    : { titleKey: "restoreTitle", summaryKey: "restoreSummary", params: { role } };
}

function buildFeedback(
  error: string,
  copy: string,
  params: {
    kind: LoginFailureKind;
    placement?: LoginFailurePlacement;
    tone?: LoginFailureTone;
    field?: LoginFormField;
    docsHref?: string;
    titleKey?: string;
    summaryKey?: string;
    primaryCommand?: string;
    stepKeys: LoginFailureStepDefinition[];
    detailKeys?: string[];
    stepParams?: Record<string, string>;
    refreshAction?: { label: string };
  },
): LoginFailureFeedback {
  const docsHref = params.docsHref ?? "https://docs.openclaw.ai/web/dashboard";
  const rawError = redactLoginFailureError(error);
  const translate = (key: string) => t(`${copy}.${key}`, params.stepParams);
  return {
    kind: params.kind,
    placement: params.placement ?? "status",
    tone: params.tone ?? "danger",
    field: params.field,
    title: translate(params.titleKey ?? "title"),
    summary: translate(params.summaryKey ?? "summary"),
    primaryCommand: params.primaryCommand,
    refreshAction: params.refreshAction,
    steps: params.stepKeys.map((step) =>
      typeof step === "string"
        ? { text: translate(step), commands: [] }
        : { text: translate(step.key), commands: step.commands },
    ),
    details: params.detailKeys?.map(translate),
    docsHref,
    rawError,
  };
}

export function resolveLoginFailureFeedback(
  params: LoginFailureFeedbackParams,
): LoginFailureFeedback | null {
  if (params.connected || !params.lastError) {
    return null;
  }

  const rawError = params.lastError;
  const lastErrorCode = params.lastErrorCode ?? null;
  const lower = normalizeLowercaseStringOrEmpty(rawError);
  const host = formatGatewayHost(params.gatewayUrl);

  if (lastErrorCode === "GATEWAY_BUSY" && params.reconnectPending) {
    return buildFeedback(rawError, "login.failure.busy", {
      kind: "busy",
      tone: "pending",
      stepKeys: [],
    });
  }

  if (lastErrorCode === ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID) {
    return buildFeedback(rawError, "login.failure.bootstrapInvalid", {
      kind: "bootstrap-invalid",
      tone: "warn",
      primaryCommand: "openclaw dashboard",
      stepKeys: [
        "stepOpen",
        {
          key: "stepJson",
          commands: ["openclaw dashboard --json"],
        },
      ],
      docsHref: "https://docs.openclaw.ai/cli/dashboard",
    });
  }

  if (lastErrorCode === ConnectErrorDetailCodes.AUTHENTICATED_PROFILE_UNAVAILABLE) {
    return buildFeedback(rawError, "login.failure.profileUnavailable", {
      kind: "profile-unavailable",
      tone: "pending",
      stepKeys: ["stepRetry", "stepAdmin"],
      docsHref: "https://docs.openclaw.ai/concepts/user-model#gateway-profile-and-github-credit",
    });
  }

  if (lastErrorCode === ConnectErrorDetailCodes.AUTH_VERIFIED_USER_REQUIRED) {
    return buildFeedback(rawError, "login.failure.verifiedUserRequired", {
      kind: "verified-user-required",
      stepKeys: ["stepIdentity", "stepSharedSecret"],
      docsHref: "https://docs.openclaw.ai/gateway/operator-scopes",
    });
  }

  if (lastErrorCode === ConnectErrorDetailCodes.OPERATOR_ACCESS_DENIED) {
    return buildFeedback(rawError, "login.failure.accessDenied", {
      kind: "access-denied",
      tone: "warn",
      stepKeys: ["stepAdmin", "stepReconnect"],
      detailKeys: ["stepFindProfile"],
      docsHref: "https://docs.openclaw.ai/gateway/operator-scopes#named-operator-roles",
    });
  }

  if (lastErrorCode === ConnectErrorDetailCodes.CONTROL_UI_BUILD_MISMATCH) {
    return buildFeedback(rawError, "chat.sidebar", {
      kind: "build-mismatch",
      tone: "pending",
      titleKey: "serverUpdatedTitle",
      summaryKey: "serverUpdatedRefresh",
      refreshAction: { label: t("login.failure.protocol.refresh") },
      stepKeys: [],
      docsHref: "https://docs.openclaw.ai/web/control-ui",
    });
  }

  if (
    lastErrorCode === ConnectErrorDetailCodes.PAIRING_REJECTED ||
    lastErrorCode === ConnectErrorDetailCodes.PAIRING_EXPIRED
  ) {
    const declined = lastErrorCode === ConnectErrorDetailCodes.PAIRING_REJECTED;
    return buildFeedback(rawError, "login.failure.pairing", {
      kind: declined ? "pairing-rejected" : "pairing-expired",
      tone: "warn",
      titleKey: declined ? "declinedTitle" : "expiredTitle",
      summaryKey: declined ? "declinedSummary" : "expiredSummary",
      stepKeys: [],
      docsHref: "https://docs.openclaw.ai/web/control-ui/connect-and-pair",
    });
  }

  const pairing = resolvePairingHint(rawError, lastErrorCode);
  if (pairing) {
    const copy = resolvePairingCopy(pairing.kind, params.lastErrorPairing);
    return buildFeedback(rawError, "login.failure.pairing", {
      kind: "pairing-required",
      tone: "pending",
      docsHref: "https://docs.openclaw.ai/web/control-ui#device-pairing-first-connection",
      titleKey: copy.titleKey,
      summaryKey: copy.summaryKey,
      // `approve --latest` only previews the newest pending request and prints the
      // exact approve command; without a request id the steps say to run that too.
      primaryCommand: pairing.requestId
        ? `openclaw devices approve ${pairing.requestId}`
        : "openclaw devices approve --latest",
      stepKeys: [
        ...(pairing.requestId ? [] : ["stepLatest"]),
        { key: "stepDashboard", commands: ["openclaw dashboard"] },
        ...(params.reconnectPending ? [] : ["stepReconnect"]),
      ],
      stepParams: { host, ...copy.params },
    });
  }

  if (
    lastErrorCode === ConnectErrorDetailCodes.AUTH_RATE_LIMITED ||
    lower.includes("too many failed authentication attempts") ||
    lower.includes("rate limit")
  ) {
    return buildFeedback(rawError, "login.failure.rateLimited", {
      kind: "auth-rate-limited",
      tone: "warn",
      stepKeys: ["stepStop", "stepWait", "stepCheckClients"],
    });
  }

  if (shouldShowInsecureContextHint(rawError, lastErrorCode)) {
    return buildFeedback(rawError, "login.failure.insecure", {
      kind: "insecure-context",
      docsHref: "https://docs.openclaw.ai/web/control-ui#insecure-http",
      stepKeys: ["stepHttps", "stepAvoidDisable"],
    });
  }

  if (
    lastErrorCode === ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED ||
    lower.includes("origin not allowed")
  ) {
    return buildFeedback(rawError, "login.failure.origin", {
      kind: "origin-not-allowed",
      docsHref:
        "https://docs.openclaw.ai/web/control-ui/development#debugging%2Ftesting%3A-dev-server-%2B-remote-gateway",
      stepKeys: [],
      detailKeys: ["stepAllowedOrigins", "stepFullOrigin", "stepRestart"],
    });
  }

  if (
    lastErrorCode === ConnectErrorDetailCodes.PROTOCOL_MISMATCH ||
    lower.includes("protocol mismatch")
  ) {
    return buildFeedback(rawError, "login.failure.protocol", {
      kind: "protocol-mismatch",
      docsHref:
        "https://docs.openclaw.ai/web/control-ui/development#debugging%2Ftesting%3A-dev-server-%2B-remote-gateway",
      refreshAction: { label: t("login.failure.protocol.refresh") },
      stepKeys: [
        { key: "stepDashboard", commands: ["openclaw dashboard"] },
        { key: "stepDevUi", commands: ["pnpm ui:dev"] },
        "stepRestart",
      ],
    });
  }

  const authHintKind = resolveAuthHintKind(params);
  const expectsPassword = isPasswordModeErrorCode(lastErrorCode);
  if (authHintKind === "trusted-proxy") {
    return buildFeedback(rawError, "login.failure.trustedProxy", {
      kind: "trusted-proxy",
      stepKeys: ["stepSignIn", "stepNoToken"],
      detailKeys: ["stepHeaders"],
      docsHref: "https://docs.openclaw.ai/gateway/trusted-proxy-auth",
    });
  }
  if (authHintKind === "required" || authHintKind === "failed") {
    const required = authHintKind === "required";
    return buildFeedback(rawError, "login", {
      kind: required ? "auth-required" : "auth-failed",
      placement: "form",
      tone: required ? "warn" : "danger",
      field: "credential",
      titleKey: expectsPassword
        ? "failure.authRequired.passwordTitle"
        : required || lastErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH
          ? "failure.authRequired.title"
          : "failure.authFailed.title",
      summaryKey: required
        ? "failure.authRequired.summary"
        : (lastErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH ||
              lastErrorCode === ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH) &&
            classifyGatewaySecret(params.secret ?? "") === "setup-code"
          ? "setupCodeHint"
          : "failure.authFailed.summary",
      stepKeys: expectsPassword
        ? ["failure.authRequired.stepPassword", "failure.authRequired.stepConnect"]
        : required
          ? [
              {
                key: "failure.authRequired.stepPaste",
                commands: ["openclaw gateway auth-token --show"],
              },
              {
                key: "failure.authRequired.stepGenerate",
                commands: ["openclaw doctor --generate-gateway-token"],
              },
              "failure.authRequired.stepConnect",
            ]
          : [
              {
                key: "failure.authFailed.stepDashboard",
                commands: ["openclaw dashboard --no-open", "openclaw gateway auth-token --show"],
              },
              "failure.authFailed.stepReplace",
            ],
      stepParams: { host },
    });
  }

  return buildFeedback(rawError, "login.failure.network", {
    kind: "network",
    placement: "form",
    tone: "warn",
    field: "url",
    stepKeys: [
      {
        key: "stepGateway",
        commands: ["openclaw status", "openclaw gateway run"],
      },
      "stepUrl",
      {
        key: "stepDashboard",
        commands: ["openclaw dashboard --no-open"],
      },
    ],
    stepParams: { host },
  });
}
