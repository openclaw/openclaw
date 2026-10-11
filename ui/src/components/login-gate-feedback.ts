import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
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
export type LoginFailureTone = "pending" | "warn" | "danger";

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
  docsHref: string;
  rawError: string;
};

export type LoginFailureFeedbackParams = Parameters<typeof resolveAuthHintKind>[0] & {
  gatewayUrl?: string;
  secret?: string;
  reconnectPending?: boolean;
  reconnectAt?: number;
};

function buildFeedback(
  error: string,
  params: {
    kind: LoginFailureKind;
    placement?: LoginFailurePlacement;
    tone?: LoginFailureTone;
    field?: LoginFormField;
    docsHref?: string;
    titleKey: string;
    summaryKey?: string;
    primaryCommand?: string;
    stepKeys: LoginFailureStepDefinition[];
    stepParams?: Record<string, string>;
    refreshAction?: { label: string };
  },
): LoginFailureFeedback {
  const docsHref = params.docsHref ?? "https://docs.openclaw.ai/web/dashboard";
  const rawError = redactLoginFailureError(error);
  return {
    kind: params.kind,
    placement: params.placement ?? "status",
    tone: params.tone ?? "danger",
    field: params.field,
    title: t(params.titleKey, params.stepParams),
    summary: params.summaryKey ? t(params.summaryKey, params.stepParams) : rawError,
    primaryCommand: params.primaryCommand,
    refreshAction: params.refreshAction,
    steps: params.stepKeys.map((step) =>
      typeof step === "string"
        ? { text: t(step, params.stepParams), commands: [] }
        : { text: t(step.key, params.stepParams), commands: step.commands },
    ),
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
    return buildFeedback(rawError, {
      kind: "busy",
      tone: "pending",
      titleKey: "login.failure.busy.title",
      summaryKey: "login.failure.busy.summary",
      stepKeys: [],
    });
  }

  if (lastErrorCode === ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID) {
    return buildFeedback(rawError, {
      kind: "bootstrap-invalid",
      tone: "warn",
      titleKey: "login.failure.bootstrapInvalid.title",
      summaryKey: "login.failure.bootstrapInvalid.summary",
      primaryCommand: "openclaw dashboard",
      stepKeys: [
        "login.failure.bootstrapInvalid.stepOpen",
        {
          key: "login.failure.bootstrapInvalid.stepJson",
          commands: ["openclaw dashboard --json"],
        },
      ],
      docsHref: "https://docs.openclaw.ai/cli/dashboard",
    });
  }

  if (lastErrorCode === ConnectErrorDetailCodes.AUTHENTICATED_PROFILE_UNAVAILABLE) {
    return buildFeedback(rawError, {
      kind: "profile-unavailable",
      tone: "pending",
      titleKey: "login.failure.profileUnavailable.title",
      summaryKey: "login.failure.profileUnavailable.summary",
      stepKeys: [
        "login.failure.profileUnavailable.stepRetry",
        "login.failure.profileUnavailable.stepAdmin",
      ],
      docsHref: "https://docs.openclaw.ai/concepts/user-model#gateway-profile-and-github-credit",
    });
  }

  if (lastErrorCode === ConnectErrorDetailCodes.AUTH_VERIFIED_USER_REQUIRED) {
    return buildFeedback(rawError, {
      kind: "verified-user-required",
      titleKey: "login.failure.verifiedUserRequired.title",
      summaryKey: "login.failure.verifiedUserRequired.summary",
      stepKeys: [
        "login.failure.verifiedUserRequired.stepIdentity",
        "login.failure.verifiedUserRequired.stepSharedSecret",
      ],
      docsHref: "https://docs.openclaw.ai/gateway/operator-scopes",
    });
  }

  if (lastErrorCode === ConnectErrorDetailCodes.OPERATOR_ACCESS_DENIED) {
    return buildFeedback(rawError, {
      kind: "access-denied",
      tone: "warn",
      titleKey: "login.failure.accessDenied.title",
      summaryKey: "login.failure.accessDenied.summary",
      stepKeys: [
        "login.failure.accessDenied.stepAdmin",
        {
          key: "login.failure.accessDenied.stepFindProfile",
          commands: ["openclaw users list --json"],
        },
        "login.failure.accessDenied.stepReconnect",
      ],
      docsHref: "https://docs.openclaw.ai/gateway/operator-scopes#named-operator-roles",
    });
  }

  if (lastErrorCode === ConnectErrorDetailCodes.CONTROL_UI_BUILD_MISMATCH) {
    return buildFeedback(rawError, {
      kind: "build-mismatch",
      tone: "pending",
      titleKey: "chat.sidebar.serverUpdatedTitle",
      summaryKey: "chat.sidebar.serverUpdatedRefresh",
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
    return buildFeedback(rawError, {
      kind: declined ? "pairing-rejected" : "pairing-expired",
      tone: "warn",
      titleKey: declined
        ? "login.failure.pairing.declinedTitle"
        : "login.failure.pairing.expiredTitle",
      summaryKey: declined
        ? "login.failure.pairing.declinedSummary"
        : "login.failure.pairing.expiredSummary",
      stepKeys: [],
      docsHref: "https://docs.openclaw.ai/web/control-ui/connect-and-pair",
    });
  }

  const pairing = resolvePairingHint(false, rawError, lastErrorCode);
  if (pairing) {
    return buildFeedback(rawError, {
      kind: "pairing-required",
      tone: "pending",
      docsHref: "https://docs.openclaw.ai/web/control-ui#device-pairing-first-connection",
      titleKey:
        pairing.kind === "scope-upgrade-pending"
          ? "login.failure.pairing.scopeTitle"
          : pairing.kind === "role-upgrade-pending"
            ? "login.failure.pairing.roleTitle"
            : pairing.kind === "metadata-upgrade-pending"
              ? "login.failure.pairing.metadataTitle"
              : "login.failure.pairing.title",
      summaryKey:
        pairing.kind === "pairing-required"
          ? "login.failure.pairing.summary"
          : "login.failure.pairing.upgradeSummary",
      // `approve --latest` only previews the newest pending request and prints the
      // exact approve command; without a request id the steps say to run that too.
      primaryCommand: pairing.requestId
        ? `openclaw devices approve ${pairing.requestId}`
        : "openclaw devices approve --latest",
      stepKeys: [
        ...(pairing.requestId ? [] : ["login.failure.pairing.stepLatest"]),
        { key: "login.failure.pairing.stepDashboard", commands: ["openclaw dashboard"] },
        ...(params.reconnectPending ? [] : ["login.failure.pairing.stepReconnect"]),
      ],
      stepParams: { host },
    });
  }

  if (
    lastErrorCode === ConnectErrorDetailCodes.AUTH_RATE_LIMITED ||
    lower.includes("too many failed authentication attempts") ||
    lower.includes("rate limit")
  ) {
    return buildFeedback(rawError, {
      kind: "auth-rate-limited",
      tone: "warn",
      titleKey: "login.failure.rateLimited.title",
      summaryKey: "login.failure.rateLimited.summary",
      stepKeys: [
        "login.failure.rateLimited.stepStop",
        "login.failure.rateLimited.stepWait",
        "login.failure.rateLimited.stepCheckClients",
      ],
    });
  }

  if (shouldShowInsecureContextHint(false, rawError, lastErrorCode)) {
    return buildFeedback(rawError, {
      kind: "insecure-context",
      docsHref: "https://docs.openclaw.ai/web/control-ui#insecure-http",
      titleKey: "login.failure.insecure.title",
      summaryKey: "login.failure.insecure.summary",
      stepKeys: ["login.failure.insecure.stepHttps", "login.failure.insecure.stepAvoidDisable"],
    });
  }

  if (
    lastErrorCode === ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED ||
    lower.includes("origin not allowed")
  ) {
    return buildFeedback(rawError, {
      kind: "origin-not-allowed",
      docsHref:
        "https://docs.openclaw.ai/web/control-ui/development#debugging%2Ftesting%3A-dev-server-%2B-remote-gateway",
      titleKey: "login.failure.origin.title",
      summaryKey: "login.failure.origin.summary",
      stepKeys: [
        "login.failure.origin.stepAllowedOrigins",
        "login.failure.origin.stepFullOrigin",
        "login.failure.origin.stepRestart",
      ],
    });
  }

  if (lower.includes("protocol mismatch")) {
    return buildFeedback(rawError, {
      kind: "protocol-mismatch",
      docsHref:
        "https://docs.openclaw.ai/web/control-ui/development#debugging%2Ftesting%3A-dev-server-%2B-remote-gateway",
      titleKey: "login.failure.protocol.title",
      summaryKey: "login.failure.protocol.summary",
      refreshAction: { label: t("login.failure.protocol.refresh") },
      stepKeys: [
        { key: "login.failure.protocol.stepDashboard", commands: ["openclaw dashboard"] },
        { key: "login.failure.protocol.stepDevUi", commands: ["pnpm ui:dev"] },
        "login.failure.protocol.stepRestart",
      ],
    });
  }

  const authHintKind = resolveAuthHintKind(params);
  const expectsPassword = isPasswordModeErrorCode(lastErrorCode);
  if (authHintKind === "trusted-proxy") {
    return buildFeedback(rawError, {
      kind: "trusted-proxy",
      titleKey: "login.failure.trustedProxy.title",
      summaryKey: "login.failure.trustedProxy.summary",
      stepKeys: [
        "login.failure.trustedProxy.stepSignIn",
        "login.failure.trustedProxy.stepHeaders",
        "login.failure.trustedProxy.stepNoToken",
      ],
      docsHref: "https://docs.openclaw.ai/gateway/trusted-proxy-auth",
    });
  }
  if (authHintKind === "required" || authHintKind === "failed") {
    const required = authHintKind === "required";
    return buildFeedback(rawError, {
      kind: required ? "auth-required" : "auth-failed",
      placement: "form",
      tone: required ? "warn" : "danger",
      field: "credential",
      titleKey: expectsPassword
        ? "login.failure.authRequired.passwordTitle"
        : required || lastErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH
          ? "login.failure.authRequired.title"
          : "login.failure.authFailed.title",
      summaryKey: required
        ? "login.failure.authRequired.summary"
        : (lastErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH ||
              lastErrorCode === ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH) &&
            classifyGatewaySecret(params.secret ?? "") === "setup-code"
          ? "login.setupCodeHint"
          : "login.failure.authFailed.summary",
      stepKeys: expectsPassword
        ? ["login.failure.authRequired.stepPassword", "login.failure.authRequired.stepConnect"]
        : required
          ? [
              {
                key: "login.failure.authRequired.stepPaste",
                commands: ["openclaw gateway auth-token --show"],
              },
              {
                key: "login.failure.authRequired.stepGenerate",
                commands: ["openclaw doctor --generate-gateway-token"],
              },
              "login.failure.authRequired.stepConnect",
            ]
          : [
              {
                key: "login.failure.authFailed.stepDashboard",
                commands: ["openclaw dashboard --no-open", "openclaw gateway auth-token --show"],
              },
              "login.failure.authFailed.stepReplace",
            ],
      stepParams: { host },
    });
  }

  return buildFeedback(rawError, {
    kind: "network",
    placement: "form",
    tone: "warn",
    field: "url",
    titleKey: "login.failure.network.title",
    summaryKey: "login.failure.network.summary",
    stepKeys: [
      {
        key: "login.failure.network.stepGateway",
        commands: ["openclaw status", "openclaw gateway run"],
      },
      "login.failure.network.stepUrl",
      {
        key: "login.failure.network.stepDashboard",
        commands: ["openclaw dashboard --no-open"],
      },
    ],
    stepParams: { host },
  });
}
