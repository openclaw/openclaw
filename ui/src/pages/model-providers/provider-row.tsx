// Provider access keeps account credentials and plan limits together in each row.
import { createSignal, For, Show } from "solid-js";
import type { ModelsProbeResult } from "../../api/types.ts";
import { providerDisplayLabel } from "../../components/provider-icon-data.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { ProviderBrandIcon } from "../../components/solid/provider-icon.tsx";
import {
  hasProviderUsageDetails,
  ProviderUsageChips,
  ProviderUsagePanel,
} from "../../components/solid/provider-usage.tsx";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ModelProviderCard, ModelProviderRemovalTarget } from "./data.ts";
import { apiKeySource, profileIdentity, ProviderProfiles } from "./profiles-view.tsx";
import {
  isProviderUsable,
  needsAuthAttention,
  renderMutationMessage,
  renderProviderStatus,
} from "./view-status.tsx";
import type { ModelProvidersViewProps } from "./view-types.ts";

type ProviderRowProps = ModelProvidersViewProps & { card: ModelProviderCard };

export function configMutationDisabled(state: ModelProvidersViewProps): boolean {
  return !state.canMutate || state.configBusy;
}

function modelsText(card: ModelProviderCard): string | null {
  if (card.modelCount === 0) {
    return null;
  }
  return card.availableModelCount < card.modelCount
    ? t("modelProviders.modelsAvailable", {
        available: String(card.availableModelCount),
        count: String(card.modelCount),
      })
    : card.modelCount === 1
      ? t("modelProviders.modelOne")
      : t("modelProviders.models", { count: String(card.modelCount) });
}

function renderCredentialSummary(card: ModelProviderCard, agentLabel: string) {
  const oauthCount = card.profiles.filter((profile) => profile.type === "oauth").length;
  const tokenCount = card.profiles.filter((profile) => profile.type === "token").length;
  const apiProfileCount = card.profiles.filter((profile) => profile.type === "api_key").length;
  const parts = [];
  if (oauthCount > 0) {
    parts.push(t("modelProviders.credentials.oauth", { count: String(oauthCount) }));
  }
  if (tokenCount > 0) {
    parts.push(t("modelProviders.credentials.tokenProfiles", { count: String(tokenCount) }));
  }
  const source = apiKeySource(card);
  if (source !== undefined) {
    parts.push(source);
  } else if (apiProfileCount > 0) {
    parts.push(t("modelProviders.credentials.profileKey", { count: String(apiProfileCount) }));
  }
  // Same shape as a saved account row, so every expanded provider reads alike.
  return (
    <div class="model-providers__profile model-providers__credentials">
      <span aria-hidden="true" />
      <span class="model-providers__profile-avatar" aria-hidden="true">
        <Icon name="key" />
      </span>
      <div class="model-providers__profile-copy">
        <strong>
          {parts.length > 0
            ? parts.join(" · ")
            : t(
                isProviderUsable(card)
                  ? "modelProviders.row.managedOutside"
                  : "modelProviders.credentials.none",
              )}
        </strong>
        <span>{t("modelProviders.credentials.label", { agent: agentLabel })}</span>
      </div>
    </div>
  );
}

function renderProbeResult(result: ModelsProbeResult | undefined) {
  if (!result) {
    return undefined;
  }
  const hasWarnings =
    result.status === "ok" && result.results.some((target) => target.status !== "ok");
  const presentation = hasWarnings ? "warning" : result.status === "ok" ? "success" : "error";
  return (
    <div
      class={["model-providers__probe", `model-providers__probe--${presentation}`]}
      role="status"
    >
      <div class="model-providers__probe-summary">
        <strong>
          {hasWarnings
            ? t("modelProviders.probe.status.partial")
            : t(`modelProviders.probe.status.${result.status}`)}
        </strong>
      </div>
      {result.error ? <div>{formatUiExternalText(result.error)}</div> : undefined}
      <For each={result.results}>
        {(target) => (
          <div class="model-providers__probe-target">
            <span>{target.label}</span>
            <span>
              {t(`modelProviders.probe.status.${target.status}`)}
              {target.latencyMs !== undefined
                ? ` · ${t("modelProviders.probe.latency", { ms: String(target.latencyMs) })}`
                : ""}
            </span>
            {target.error ? <small>{formatUiExternalText(target.error)}</small> : undefined}
          </div>
        )}
      </For>
    </div>
  );
}

export function ApiKeyInput(props: {
  value: string;
  disabled: boolean;
  onInput: (value: string) => void;
  replace?: boolean;
}) {
  return (
    <label class="field">
      <span>{t("modelProviders.apiKey.label")}</span>
      <input
        type="password"
        autocomplete="off"
        placeholder={t(
          props.replace
            ? "modelProviders.apiKey.replacePlaceholder"
            : "modelProviders.apiKey.placeholder",
        )}
        value={props.value}
        disabled={props.disabled}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </label>
  );
}

function KeyEditor(props: ModelProvidersViewProps & { card: ModelProviderCard }) {
  const busy = () => Boolean(props.busy[`key:${props.card.id}`]);
  const authModeBlocked = () =>
    props.card.apiKeySupported === false ||
    Boolean(props.card.configAuthMode && props.card.configAuthMode !== "api-key");
  const mutationDisabled = () => configMutationDisabled(props);
  return (
    <Show when={props.keyEditorProvider === props.card.id}>
      <div class="model-providers__inline-form">
        <ApiKeyInput
          value={props.keyDraft}
          disabled={busy() || mutationDisabled() || authModeBlocked()}
          onInput={(value) => props.onKeyDraftChange(value)}
          replace={props.card.apiKey?.source === "config"}
        />
        <div class="model-providers__form-actions">
          <button
            class="btn primary btn--sm"
            disabled={busy() || mutationDisabled() || authModeBlocked() || !props.keyDraft.trim()}
            onClick={() => props.onSaveKey(props.card.id, props.card.configKey ?? props.card.id)}
          >
            {busy() ? t("modelProviders.saving") : t("common.save")}
          </button>
          <button class="btn btn--sm" disabled={busy()} onClick={() => props.onCloseKeyEditor()}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </Show>
  );
}

/** What "Remove provider" can delete, and the credential it has to leave behind. */
function removalPlan(card: ModelProviderCard): {
  removeTargets: ModelProviderRemovalTarget[];
  keptSource?: string;
  configKey?: string;
} {
  const providers = new Set(card.logoutTargets.map((target) => target.provider));
  for (const profile of card.profiles) {
    if (profile.type === "api_key" && profile.logoutSupported) {
      providers.add(card.profileProviderIds[profile.profileId] ?? card.id);
    }
  }
  const references = card.configApiKeys.filter((key) => key.reference);
  const external = [
    card.apiKey?.source === "env" ? apiKeySource(card) : undefined,
    references.length
      ? t("modelProviders.remove.secretReferences", {
          keys: references.map(({ key }) => key).join(", "),
        })
      : undefined,
    card.profiles.some((profile) => profile.externallyManaged || profile.source === "external")
      ? t("modelProviders.row.managedOutside")
      : undefined,
  ]
    .filter(Boolean)
    .join("; ");
  const configKey = card.configApiKeys.find((key) => !key.reference)?.key;
  return {
    ...(configKey ? { configKey } : {}),
    removeTargets: [
      ...[...providers].map((provider) => ({ provider })),
      // This form also clears saved API-key profiles and literal keys on config aliases.
      ...(configKey ? [{ provider: configKey, credentialType: "api_key" as const }] : []),
    ],
    ...(external ? { keptSource: external } : {}),
  };
}

function ProviderActions(props: ModelProvidersViewProps & { card: ModelProviderCard }) {
  const authModeBlocked = () =>
    Boolean(props.card.configAuthMode && props.card.configAuthMode !== "api-key");
  const keyDisabled = () =>
    Boolean(props.busy[`key:${props.card.id}`]) ||
    configMutationDisabled(props) ||
    authModeBlocked();
  const keyTitle = () =>
    authModeBlocked()
      ? t("modelProviders.apiKey.authModeBlocked", { mode: props.card.configAuthMode ?? "" })
      : (props.mutationBlockedReason ?? "");
  const removal = () => removalPlan(props.card);
  const connectLabel = () =>
    t(
      isProviderUsable(props.card) || props.card.profiles.length > 0
        ? "modelProviders.profiles.addAccount"
        : "modelProviders.login.action",
    );
  const probeLabel = () =>
    t(
      props.busy[`probe:${props.card.id}`]
        ? "modelProviders.probe.testing"
        : "modelProviders.probe.test",
    );
  return (
    <div class="model-providers__card-actions provider-row__footer">
      <Show when={removal().removeTargets.length > 0}>
        <button
          class="btn btn--sm btn--ghost danger provider-row__remove"
          disabled={configMutationDisabled(props) || Boolean(props.busy[`logout:${props.card.id}`])}
          title={props.mutationBlockedReason ?? ""}
          aria-label={t("modelProviders.actionNamed", {
            action: t("modelProviders.remove.action"),
            name: providerName(props.card),
          })}
          onClick={() =>
            props.onRequestLogout({
              cardId: props.card.id,
              label: providerName(props.card),
              ...removal(),
            })
          }
        >
          {t("modelProviders.remove.action")}
        </button>
      </Show>
      <Show when={props.canConnect(props.card)}>
        <button
          class="btn btn--sm"
          data-models-connect-provider={props.card.id}
          aria-label={t("modelProviders.actionNamed", {
            action: connectLabel(),
            name: providerName(props.card),
          })}
          disabled={configMutationDisabled(props) || props.loginBusy}
          onClick={() => props.onConnect(props.card)}
        >
          {connectLabel()}
        </button>
      </Show>
      <Show when={isProviderUsable(props.card)}>
        <button
          class="btn btn--sm"
          disabled={
            Boolean(props.busy[`probe:${props.card.id}`]) ||
            !props.canMutate ||
            !props.probeAvailable
          }
          title={
            !props.probeAvailable
              ? t("modelProviders.probe.unavailable")
              : (props.mutationBlockedReason ?? "")
          }
          aria-label={t("modelProviders.actionNamed", {
            action: probeLabel(),
            name: providerName(props.card),
          })}
          onClick={() =>
            props.onProbe(
              props.card.id,
              props.card.credentialProviderIds.length
                ? props.card.credentialProviderIds
                : [props.card.id],
            )
          }
        >
          {probeLabel()}
        </button>
      </Show>
      <Show when={props.card.apiKeySupported !== false}>
        <button
          class="btn btn--sm"
          disabled={keyDisabled()}
          title={keyTitle()}
          aria-label={t("modelProviders.actionNamed", {
            action: t("modelProviders.apiKey.set"),
            name: providerName(props.card),
          })}
          onClick={() => props.onOpenKeyEditor(props.card.id)}
        >
          {t("modelProviders.apiKey.set")}
        </button>
      </Show>
    </div>
  );
}

/** Gateways often echo the raw id as the name; the shared label map reads better. */
function providerName(card: ModelProviderCard): string {
  return card.displayName && card.displayName !== card.id
    ? card.displayName
    : providerDisplayLabel(card.id);
}

function needsAttention(card: ModelProviderCard): boolean {
  return (
    card.catalogStatus === "auth-rejected" ||
    (needsAuthAttention(card) && card.auth?.kind !== "expiring") ||
    Boolean(card.usage?.error)
  );
}

/** One line naming the credential: the single account, a key source, or a count. */
function credentialLine(card: ModelProviderCard): string | undefined {
  if (card.profiles.length === 1) {
    return profileIdentity(card.profiles[0]!, card.profiles);
  }
  if (card.profiles.length > 1) {
    return t("modelProviders.profiles.accounts", { count: String(card.profiles.length) });
  }
  return (
    apiKeySource(card) ??
    (isProviderUsable(card) ? t("modelProviders.row.managedOutside") : undefined)
  );
}

/** A provider with saved credentials: a dense summary that expands in place. */
export function ProviderRow(props: ProviderRowProps) {
  const card = () => props.card;
  const message = () => props.messages[`key:${card().id}`] ?? props.messages[card().id];
  const limits = () => (hasProviderUsageDetails(card().usage) ? card().usage : undefined);
  const [expanded, setExpanded] = createSignal(false);
  // Work in progress and problems keep the detail open until they settle.
  const pinned = () =>
    props.keyEditorProvider === card().id ||
    Boolean(message()) ||
    Boolean(props.probeResults[card().id]) ||
    Boolean(props.busy[`probe:${card().id}`]) ||
    needsAttention(card());
  const open = () => expanded() || pinned();
  const detailId = () => `provider-detail-${card().id.replace(/[^a-z0-9-]/giu, "-")}`;
  const meta = () =>
    [modelsText(card()), credentialLine(card())].filter((part): part is string => Boolean(part));
  return (
    <li
      class={["provider-row model-providers__row", { "provider-row--open": open() }]}
      data-provider-id={card().id}
    >
      <button
        type="button"
        class="provider-row__summary model-providers__head"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={detailId()}
        onClick={() => setExpanded(!open())}
      >
        <ProviderBrandIcon provider={card().id} class="provider-row__icon model-providers__icon" />
        <span class="provider-row__identity">
          <span class="provider-row__name">
            {providerName(card())}
            <Show when={card().usage?.plan}>
              {(plan) => <span class="provider-row__plan">{plan()}</span>}
            </Show>
          </span>
          <span class="provider-row__meta settings-row__desc">{meta().join(" · ")}</span>
        </span>
        {/* The open row shows the full panel below; its empty chip cell collapses. */}
        <ProviderUsageChips usage={open() ? undefined : card().usage} />
        <span class="provider-row__status">{renderProviderStatus(card())}</span>
        <Icon name="chevronDown" class="provider-row__chevron" />
      </button>
      <Show when={open()}>
        <div class="provider-row__detail" id={detailId()}>
          <Show when={limits()}>
            {(usage) => (
              <section
                class="provider-row__limits-pane"
                aria-label={t("modelProviders.limits.title")}
              >
                <ProviderUsagePanel usage={usage()} />
              </section>
            )}
          </Show>
          <section class="provider-row__accounts" aria-label={t("modelProviders.row.accounts")}>
            {card().profiles.length > 0 && props.canViewProfiles ? (
              <ProviderProfiles {...props} canMutate={props.canMutate && !props.configBusy} />
            ) : (
              renderCredentialSummary(card(), props.credentialAgentLabel)
            )}
          </section>
          <KeyEditor {...props} />
          {renderProbeResult(props.probeResults[card().id])}
          {renderMutationMessage(message())}
          <ProviderActions {...props} />
        </div>
      </Show>
    </li>
  );
}

/** A provider seen in usage or the catalog without saved credentials. */
export function UnconnectedProviderRow(props: ProviderRowProps) {
  const card = () => props.card;
  const message = () => props.messages[`key:${card().id}`] ?? props.messages[card().id];
  const reason = () =>
    card().modelCount > 0
      ? t("modelProviders.row.catalogOnly", { models: modelsText(card()) ?? "" })
      : t("modelProviders.row.noCredentials");
  return (
    <li class="provider-row provider-row--quiet model-providers__row" data-provider-id={card().id}>
      <div class="provider-row__summary model-providers__head">
        <ProviderBrandIcon provider={card().id} class="provider-row__icon model-providers__icon" />
        <span class="provider-row__identity">
          <span class="provider-row__name">{providerName(card())}</span>
          <span class="provider-row__meta settings-row__desc">
            {card().id} · {renderProviderStatus(card()) ?? reason()}
          </span>
        </span>
        <ProviderActions {...props} />
      </div>
      <KeyEditor {...props} />
      {renderMutationMessage(message())}
    </li>
  );
}
