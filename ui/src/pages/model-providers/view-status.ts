import { html, nothing } from "lit";
import { renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import type { ModelProviderAuthKind, ModelProviderCard } from "./data.ts";

registerModelControlsEnglish();

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

function renderAuthStatus(card: ModelProviderCard) {
  const auth = card.auth;
  if (!auth) {
    return nothing;
  }
  const status = AUTH_STATUS[auth.kind];
  const label = t(status.labelKey);
  const detail = auth.expiryLabel
    ? t("modelProviders.expiresIn", { time: auth.expiryLabel })
    : undefined;
  return html`
    <span title=${detail ?? label}> ${renderSettingsStatus({ kind: status.kind, label })} </span>
  `;
}

export function hasProviderCredentials(card: ModelProviderCard): boolean {
  return card.hasConfigApiKey || Boolean(card.apiKey) || card.profiles.length > 0;
}

export function hasVerifiedProvider(card: ModelProviderCard): boolean {
  return (
    card.catalogStatus === "ready" &&
    card.auth?.kind !== "expired" &&
    card.auth?.kind !== "missing" &&
    card.auth?.kind !== "expiring"
  );
}

export function renderProviderStatus(card: ModelProviderCard) {
  if (card.checkingModels) {
    return renderSettingsStatus({
      kind: "muted",
      label: t("chat.modelControls.checkingProviderModels", { providers: card.displayName }),
    });
  }
  if (
    card.auth?.kind === "expired" ||
    card.auth?.kind === "missing" ||
    card.auth?.kind === "expiring"
  ) {
    return renderAuthStatus(card);
  }
  if (card.catalogStatus === "auth-rejected") {
    return renderSettingsStatus({ kind: "danger", label: t("modelProviders.status.denied") });
  }
  if (card.catalogStatus === "unavailable") {
    return renderSettingsStatus({
      kind: "warn",
      label: t("modelProviders.status.modelsUnavailable"),
    });
  }
  if (!hasProviderCredentials(card)) {
    return renderAuthStatus(card);
  }
  const verified = hasVerifiedProvider(card);
  const ready = verified && card.availableModelCount > 0;
  return renderSettingsStatus({
    kind: ready ? "ok" : "muted",
    label: t(
      ready
        ? "modelProviders.status.ready"
        : verified
          ? "modelProviders.status.ok"
          : "modelProviders.status.configured",
    ),
  });
}

export function renderMutationMessage(message: ModelProviderRowMessage | undefined) {
  if (!message) {
    return nothing;
  }
  return html`
    <div class="callout ${message.kind}" role=${message.kind === "error" ? "alert" : "status"}>
      ${message.text}
    </div>
    ${message.warning ? html`<div class="callout warning" role="status">${message.warning}</div>` : nothing}
  `;
}

export function renderModelProviderConnectAction(
  props: {
    onConnect: () => void;
    connectDisabled: boolean;
  },
  primary = false,
) {
  return html`<button
    class=${primary ? "btn primary" : "btn"}
    data-models-connect
    ?disabled=${props.connectDisabled}
    @click=${props.onConnect}
  >
    ${t("modelProviders.login.action")}
  </button>`;
}
