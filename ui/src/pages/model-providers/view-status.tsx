import type { ModelAuthStatusProfile } from "../../api/types.ts";
import { SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import type { ModelProviderAuthKind, ModelProviderCard } from "./data.ts";

registerEnglishCatalog(registerSettingsEnglish);

/** The auth owner supplies a reason for unusable grants, not for routine access expiry. */
export function isAccessTokenExpiry(profile: ModelAuthStatusProfile): boolean {
  return (
    profile.type === "oauth" &&
    (profile.status === "expiring" || profile.status === "expired") &&
    profile.reasonCode === undefined
  );
}

export function profileAuthProblem(profile: ModelAuthStatusProfile): string | undefined {
  if (profile.type !== "oauth") {
    return undefined;
  }
  if (profile.reasonCode === "missing_credential") {
    return "modelProviders.status.signInAgain";
  }
  // The existing reason covers both pending and failed refresh markers, not just rejection.
  return profile.reasonCode === "expired" ? "modelProviders.status.signInUnavailable" : undefined;
}

const AUTH_STATUS: Record<
  ModelProviderAuthKind,
  { kind: "ok" | "warn" | "danger" | "muted"; labelKey: string }
> = {
  ok: { kind: "ok", labelKey: "modelProviders.status.ok" },
  expiring: { kind: "warn", labelKey: "modelProviders.status.expiring" },
  expired: { kind: "danger", labelKey: "modelProviders.status.expired" },
  missing: { kind: "danger", labelKey: "modelProviders.status.missing" },
  "api-key": { kind: "muted", labelKey: "modelProviders.status.apiKey" },
};

function renderAuthStatus(auth: ModelProviderCard["auth"]) {
  if (!auth) {
    return undefined;
  }
  const status = AUTH_STATUS[auth.kind];
  const label = t(status.labelKey);
  const detail = auth.expiryLabel
    ? t("modelProviders.expiresIn", { time: auth.expiryLabel })
    : undefined;
  return (
    <span title={detail ?? label}>
      {" "}
      <SettingsStatus kind={status.kind} label={label} />{" "}
    </span>
  );
}

/**
 * Usable through OpenClaw: credentials it stores, or a catalog that reports the
 * provider ready (for example a CLI backend or plugin that owns its own login).
 */
/** Usage the provider reported, even an error, proves a credential it accepted. */
export function isProviderUsable(card: ModelProviderCard): boolean {
  return (
    card.configApiKeys.length > 0 ||
    Boolean(card.apiKey) ||
    card.profiles.length > 0 ||
    card.availableModelCount > 0 ||
    card.catalogStatus === "ready" ||
    card.usage !== undefined
  );
}

export function needsAuthAttention(card: ModelProviderCard): boolean {
  if (card.auth?.kind === "missing") {
    return true;
  }
  if (card.auth?.kind !== "expired" && card.auth?.kind !== "expiring") {
    return false;
  }
  // A rollup has no credential type. Unknown or mixed expiry retains its warning.
  const expiring = card.profiles.filter((profile) => profile.status === card.auth?.kind);
  return expiring.length === 0 || !expiring.every(isAccessTokenExpiry);
}

export function hasVerifiedProvider(card: ModelProviderCard): boolean {
  return card.catalogStatus === "ready" && !needsAuthAttention(card);
}

export function renderProviderStatus(card: ModelProviderCard) {
  if (card.checkingModels) {
    return (
      <SettingsStatus
        kind="muted"
        dot={false}
        label={
          <span class="model-providers__checking" role="status">
            <span class="btn__spinner" aria-hidden="true" />
            <span>{t("modelProviders.status.checking")}</span>
          </span>
        }
      />
    );
  }
  if (card.catalogStatus === "auth-rejected") {
    // The card-wide outcome does not identify which saved credential was rejected.
    return <SettingsStatus kind="danger" label={t("modelProviders.status.denied")} />;
  }
  if (needsAuthAttention(card)) {
    return renderAuthStatus(card.auth);
  }
  if (card.catalogStatus === "unavailable") {
    return <SettingsStatus kind={"warn"} label={t("modelProviders.status.modelsUnavailable")} />;
  }
  if (!isProviderUsable(card)) {
    return renderAuthStatus(card.auth);
  }
  const verified = hasVerifiedProvider(card);
  const ready = verified && card.availableModelCount > 0;
  return (
    <SettingsStatus
      kind={ready ? "ok" : "muted"}
      label={t(
        ready
          ? "modelProviders.status.ready"
          : verified
            ? "modelProviders.status.ok"
            : "modelProviders.status.configured",
      )}
    />
  );
}

export function renderMutationMessage(message: ModelProviderRowMessage | undefined) {
  if (!message) {
    return undefined;
  }
  return (
    <>
      <div class={["callout", message.kind]} role={message.kind === "error" ? "alert" : "status"}>
        {message.text}
      </div>
      {message.warning ? (
        <div class="callout warning" role="status">
          {message.warning}
        </div>
      ) : undefined}
    </>
  );
}

export function ModelProviderConnectAction(props: {
  onConnect: () => void;
  connectDisabled: boolean;
  primary?: boolean;
  compact?: boolean;
}) {
  return (
    <button
      class={["btn", { primary: props.primary, "btn--sm": props.compact }]}
      data-models-connect
      disabled={props.connectDisabled}
      onClick={() => props.onConnect()}
    >
      {t("modelProviders.login.action")}
    </button>
  );
}
