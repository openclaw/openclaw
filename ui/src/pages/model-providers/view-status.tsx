import { SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import type { ModelProviderAuthKind, ModelProviderCard } from "./data.ts";

registerEnglishCatalog(registerModelControlsEnglish);

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

export function hasProviderCredentials(card: ModelProviderCard): boolean {
  return card.hasConfigApiKey || Boolean(card.apiKey) || card.profiles.length > 0;
}

function needsAuthAttention(card: ModelProviderCard): boolean {
  return (
    card.auth?.kind === "expired" || card.auth?.kind === "missing" || card.auth?.kind === "expiring"
  );
}

export function hasVerifiedProvider(card: ModelProviderCard): boolean {
  return card.catalogStatus === "ready" && !needsAuthAttention(card);
}

export function renderProviderStatus(card: ModelProviderCard) {
  if (card.checkingModels) {
    return (
      <SettingsStatus
        kind={"muted"}
        label={t("chat.modelControls.checkingProviderModels", { providers: card.displayName })}
      />
    );
  }
  if (needsAuthAttention(card)) {
    return renderAuthStatus(card);
  }
  if (card.catalogStatus === "auth-rejected") {
    return <SettingsStatus kind={"danger"} label={t("modelProviders.status.denied")} />;
  }
  if (card.catalogStatus === "unavailable") {
    return <SettingsStatus kind={"warn"} label={t("modelProviders.status.modelsUnavailable")} />;
  }
  if (!hasProviderCredentials(card)) {
    return renderAuthStatus(card);
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
      <div class={"callout " + message.kind} role={message.kind === "error" ? "alert" : "status"}>
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

export type ModelProviderConnectActionProps = {
  onConnect: () => void;
  connectDisabled: boolean;
  primary?: boolean;
  compact?: boolean;
};

export function ModelProviderConnectAction(props: ModelProviderConnectActionProps) {
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
