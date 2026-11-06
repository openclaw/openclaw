// Provider access keeps account credentials and plan limits together in each row.
import type { JSX } from "@solidjs/web";
import { createSignal, For, onSettled, Show } from "solid-js";
import { splitTrailingAuthProfile } from "../../../../src/agents/model-ref-profile.js";
import type { ModelsProbeResult } from "../../api/types.ts";
import { providerDisplayLabel } from "../../components/provider-icon-data.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { ProviderBrandIcon } from "../../components/solid/provider-icon.tsx";
import {
  hasProviderUsageDetails,
  ProviderUsagePanel,
} from "../../components/solid/provider-usage.tsx";
import { SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { canonicalModelAuthProviderId } from "../../lib/model-auth.ts";
import { modelSettingFallbacks, modelSettingPrimary } from "../../lib/model-setting.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  modelCatalogRef,
  type ModelProviderCard,
  type ModelProviderRemovalTarget,
} from "./data.ts";
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
  if (card.availableModelCount < card.modelCount) {
    return card.modelCount === 1
      ? t("modelProviders.modelsAvailableOne", { available: String(card.availableModelCount) })
      : t("modelProviders.modelsAvailable", {
          available: String(card.availableModelCount),
          count: String(card.modelCount),
        });
  }
  return card.modelCount === 1
    ? t("modelProviders.modelOne")
    : t("modelProviders.models", { count: String(card.modelCount) });
}

/** Where a key outside the saved accounts comes from, without saying "API key" again. */
function keySource(card: ModelProviderCard): string | undefined {
  if (card.apiKey?.source === "config") {
    return t("modelProviders.credentials.keyFromConfig");
  }
  if (card.apiKey?.source !== "env") {
    return undefined;
  }
  return card.apiKey.envVar
    ? t("modelProviders.credentials.keyFromEnvNamed", { name: card.apiKey.envVar })
    : t("modelProviders.credentials.keyFromEnv");
}

/**
 * The provider's only key, shown as a row; replacing it belongs to that row, not to the footer.
 * With several keys the Gateway picks which one a new key replaces, so no row can promise it.
 */
function hasKeyRow(card: ModelProviderCard, showProfiles: boolean): boolean {
  const savedKeys = card.profiles.filter((profile) => profile.type === "api_key").length;
  const sourceKeys = keySource(card) === undefined ? 0 : 1;
  return savedKeys + sourceKeys === 1 && (sourceKeys === 1 || showProfiles);
}

function CredentialRow(props: { title: string; detail?: string; action?: JSX.Element }) {
  return (
    <div class="model-providers__profile model-providers__credentials">
      <div class="model-providers__profile-copy">
        <strong>{props.title}</strong>
        <Show when={props.detail}>
          <span>{props.detail}</span>
        </Show>
      </div>
      <span class="model-providers__profile-actions">{props.action}</span>
    </div>
  );
}

/** What this viewer may not see account by account, in one line. */
function hiddenCredentialSummary(card: ModelProviderCard): string | undefined {
  const count = (type: ModelProviderCard["profiles"][number]["type"]) =>
    card.profiles.filter((profile) => profile.type === type).length;
  const parts = [];
  if (count("oauth") > 0) {
    parts.push(t("modelProviders.credentials.oauth", { count: String(count("oauth")) }));
  }
  if (count("token") > 0) {
    parts.push(t("modelProviders.credentials.tokenProfiles", { count: String(count("token")) }));
  }
  if (count("api_key") > 0 && apiKeySource(card) === undefined) {
    parts.push(t("modelProviders.credentials.profileKey", { count: String(count("api_key")) }));
  }
  if (parts.length > 0) {
    return parts.join(" · ");
  }
  if (apiKeySource(card) !== undefined) {
    return undefined;
  }
  return t(
    isProviderUsable(card)
      ? "modelProviders.row.managedOutside"
      : "modelProviders.credentials.none",
  );
}

/** Every credential as one row: saved accounts, then a key from config or the environment. */
function ProviderCredentials(props: ProviderRowProps) {
  const showProfiles = () => props.card.profiles.length > 0 && props.canViewProfiles;
  const keyAction = () =>
    hasKeyRow(props.card, showProfiles()) ? <KeyButton {...props} replace /> : undefined;
  return (
    <section class="provider-row__accounts" aria-label={t("modelProviders.row.accounts")}>
      <Show
        when={showProfiles()}
        fallback={
          <Show when={hiddenCredentialSummary(props.card)}>
            {(summary) => <CredentialRow title={summary()} />}
          </Show>
        }
      >
        <ProviderProfiles
          {...props}
          canMutate={props.canMutate && !props.configBusy}
          keyAction={keySource(props.card) === undefined ? keyAction : undefined}
        />
      </Show>
      <Show when={keySource(props.card)}>
        {(source) => (
          <CredentialRow
            title={t("modelProviders.apiKey.label")}
            detail={source()}
            action={keyAction()}
          />
        )}
      </Show>
    </section>
  );
}

function renderProbeResult(result: ModelsProbeResult | undefined) {
  if (!result) {
    return undefined;
  }
  const hasWarnings =
    result.status === "ok" && result.results.some((target) => target.status !== "ok");
  const kind = hasWarnings ? "warn" : result.status === "ok" ? "ok" : "danger";
  return (
    <div class="model-providers__probe" role="status">
      <div class="model-providers__probe-summary">
        <SettingsStatus
          kind={kind}
          label={
            hasWarnings
              ? t("modelProviders.probe.status.partial")
              : t(`modelProviders.probe.status.${result.status}`)
          }
        />
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
  /** Inline beside its own actions, where the placeholder already names the field. */
  labelHidden?: boolean;
  inputRef?: (element: HTMLInputElement) => void;
  /** The label already names the field; a form with nothing else needs no second prompt. */
  labelOnly?: boolean;
}) {
  return (
    <label class="field">
      <span class={{ "settings-control__sr-label": props.labelHidden }}>
        {t("modelProviders.apiKey.label")}
      </span>
      <input
        ref={(element) => props.inputRef?.(element)}
        type="password"
        autocomplete="off"
        placeholder={
          props.labelOnly
            ? undefined
            : t(
                props.replace
                  ? "modelProviders.apiKey.replacePlaceholder"
                  : "modelProviders.apiKey.placeholder",
              )
        }
        value={props.value}
        disabled={props.disabled}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </label>
  );
}

function keyEditorOpen(props: ProviderRowProps): boolean {
  return props.keyEditorProvider === props.card.id;
}

/** Opens the key form, which then stands in for this button until it closes. */
function KeyButton(props: ProviderRowProps & { replace?: boolean }) {
  const authModeBlocked = () =>
    Boolean(props.card.configAuthMode && props.card.configAuthMode !== "api-key");
  return (
    <Show when={props.card.apiKeySupported !== false && !keyEditorOpen(props)}>
      <button
        class="btn btn--sm"
        disabled={
          Boolean(props.busy[`key:${props.card.id}`]) ||
          configMutationDisabled(props) ||
          authModeBlocked()
        }
        title={
          authModeBlocked()
            ? t("modelProviders.apiKey.authModeBlocked", { mode: props.card.configAuthMode ?? "" })
            : (props.mutationBlockedReason ?? "")
        }
        aria-label={t("modelProviders.actionNamed", {
          action: t(
            props.replace ? "modelProviders.apiKey.replaceNamed" : "modelProviders.apiKey.set",
          ),
          name: providerName(props.card),
        })}
        onClick={() => props.onOpenKeyEditor(props.card.id)}
      >
        {t(props.replace ? "modelProviders.apiKey.replace" : "modelProviders.apiKey.set")}
      </button>
    </Show>
  );
}

function KeyForm(props: ProviderRowProps & { onCancel?: () => void }) {
  const busy = () => Boolean(props.busy[`key:${props.card.id}`]);
  const authModeBlocked = () =>
    props.card.apiKeySupported === false ||
    Boolean(props.card.configAuthMode && props.card.configAuthMode !== "api-key");
  const mutationDisabled = () => configMutationDisabled(props);
  let input: HTMLInputElement | undefined;
  // The button that opened this form is gone, so focus moves into it.
  onSettled(() => {
    input?.focus();
  });
  return (
    <div class="model-providers__inline-form">
      <ApiKeyInput
        labelHidden
        inputRef={(element) => (input = element)}
        value={props.keyDraft}
        disabled={busy() || mutationDisabled() || authModeBlocked()}
        onInput={(value) => props.onKeyDraftChange(value)}
        replace={
          props.card.apiKey?.source === "config" ||
          props.card.profiles.some((profile) => profile.type === "api_key")
        }
      />
      <div class="model-providers__form-actions">
        <button
          class="btn btn--sm"
          disabled={busy()}
          onClick={() => {
            props.onCloseKeyEditor();
            props.onCancel?.();
          }}
        >
          {t("common.cancel")}
        </button>
        <button
          class="btn primary btn--sm"
          disabled={busy() || mutationDisabled() || authModeBlocked() || !props.keyDraft.trim()}
          onClick={() => props.onSaveKey(props.card.id, props.card.configKey ?? props.card.id)}
        >
          {props.busy[`check:key:${props.card.id}`]
            ? t("modelProviders.apiKey.checking")
            : busy()
              ? t("modelProviders.saving")
              : t("common.save")}
        </button>
      </div>
    </div>
  );
}

function KeyEditor(props: ProviderRowProps & { onCancel?: () => void }) {
  return (
    <Show when={keyEditorOpen(props)}>
      <KeyForm {...props} />
    </Show>
  );
}

/** Defaults for all agents served by this provider; removal keeps them selected. */
function defaultModelsUsing(props: ProviderRowProps): string | undefined {
  const { primary, fallbacks, utilityModel } = props.defaultModels;
  const names = [
    primary,
    ...fallbacks,
    modelSettingPrimary(utilityModel),
    ...modelSettingFallbacks(utilityModel),
  ].flatMap((ref) => {
    const model = ref ? splitTrailingAuthProfile(ref).model : "";
    // Aliases resolve through their catalog entry; other refs name the provider first.
    const entry = props.configuredModels.find((candidate) => modelCatalogRef(candidate) === model);
    const provider = entry?.provider ?? (model.includes("/") ? model.split("/", 1)[0] : "");
    return provider && canonicalModelAuthProviderId(provider) === props.card.id
      ? [entry?.name ?? model]
      : [];
  });
  return names.length ? [...new Set(names)].join(", ") : undefined;
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

function ProviderActions(props: ProviderRowProps) {
  const removal = () => removalPlan(props.card);
  const defaultModels = () => defaultModelsUsing(props);
  const connected = () => isProviderUsable(props.card) || props.card.profiles.length > 0;
  const connectName = () =>
    t(connected() ? "modelProviders.profiles.addAccount" : "modelProviders.login.action");
  const connectLabel = () =>
    t(connected() ? "modelProviders.profiles.addAccount" : "modelProviders.row.connect");
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
              ...(defaultModels() ? { defaultModels: defaultModels() } : {}),
            })
          }
        >
          {t("modelProviders.remove.action")}
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
      <Show when={props.canConnect(props.card)}>
        <button
          class="btn btn--sm"
          data-models-connect-provider={props.card.id}
          aria-label={t("modelProviders.actionNamed", {
            action: connectName(),
            name: providerName(props.card),
          })}
          disabled={configMutationDisabled(props) || props.loginBusy}
          onClick={() => props.onConnect(props.card)}
        >
          {connectLabel()}
        </button>
      </Show>
      <Show when={!hasKeyRow(props.card, props.canViewProfiles)}>
        <KeyButton {...props} />
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

/** A credential that stopped working opens to its fix; anything else waits for a click. */
function needsCredentialFix(card: ModelProviderCard): boolean {
  return (
    card.catalogStatus === "auth-rejected" ||
    (needsAuthAttention(card) && card.auth?.kind !== "expiring")
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

/**
 * A provider with saved credentials. Closed, it answers "does this work, and with what":
 * identity on one line and one status word that only changes when something needs a look.
 * Open, it lists credentials, then what they allow, then the provider's actions.
 */
export function ProviderRow(props: ProviderRowProps) {
  let summary: HTMLButtonElement | undefined;
  const card = () => props.card;
  const message = () => props.messages[`key:${card().id}`] ?? props.messages[card().id];
  const limits = () => (hasProviderUsageDetails(card().usage) ? card().usage : undefined);
  const [expanded, setExpanded] = createSignal<boolean>();
  // Work in progress and broken credentials start open; a click always wins.
  const startsOpen = () =>
    keyEditorOpen(props) ||
    Boolean(message()) ||
    Boolean(props.probeResults[card().id]) ||
    Boolean(props.busy[`probe:${card().id}`]) ||
    needsCredentialFix(card());
  const open = () => expanded() ?? startsOpen();
  const detailId = () => `provider-detail-${card().id.replace(/[^a-z0-9-]/giu, "-")}`;
  // Open, the credential rows below name the account, so the summary doesn't.
  const credential = () => (open() ? undefined : credentialLine(card()));
  return (
    <li
      class={["provider-row model-providers__row", { "provider-row--open": open() }]}
      data-provider-id={card().id}
    >
      <button
        type="button"
        class="provider-row__summary model-providers__head"
        ref={(element) => (summary = element)}
        aria-expanded={open() ? "true" : "false"}
        aria-controls={detailId()}
        onClick={() => setExpanded(!open())}
      >
        <ProviderBrandIcon provider={card().id} class="provider-row__icon model-providers__icon" />
        <span class="provider-row__identity">
          <span class="provider-row__name">{providerName(card())}</span>
          <span class="provider-row__meta settings-row__desc">
            <span class="provider-row__meta-part">{credential()}</span>
            <Show when={card().usage?.plan}>
              {(plan) => <span class="provider-row__meta-part provider-row__plan">{plan()}</span>}
            </Show>
            <span class="provider-row__meta-part">{modelsText(card())}</span>
          </span>
        </span>
        <span class="provider-row__status">{renderProviderStatus(card())}</span>
        <Icon name="chevronDown" class="provider-row__chevron" />
      </button>
      <Show when={open()}>
        <div class="provider-row__detail" id={detailId()}>
          <ProviderCredentials {...props} />
          <KeyEditor {...props} onCancel={() => summary?.focus()} />
          <Show when={limits()}>
            {(usage) => (
              <section
                class="provider-row__limits-pane"
                aria-label={t("modelProviders.limits.title")}
              >
                <ProviderUsagePanel compact usage={usage()} />
              </section>
            )}
          </Show>
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
  const catalog = () =>
    card().modelCount === 0
      ? undefined
      : t("modelProviders.row.catalogOnly", {
          models:
            card().modelCount === 1
              ? t("modelProviders.modelOne")
              : t("modelProviders.models", { count: String(card().modelCount) }),
        });
  return (
    <li class="provider-row provider-row--quiet model-providers__row" data-provider-id={card().id}>
      <div class="provider-row__summary model-providers__head">
        <ProviderBrandIcon provider={card().id} class="provider-row__icon model-providers__icon" />
        <span class="provider-row__identity">
          <span class="provider-row__name">{providerName(card())}</span>
          <span class="provider-row__meta settings-row__desc">
            {renderProviderStatus(card()) ?? catalog()}
          </span>
        </span>
        <ProviderActions {...props} />
      </div>
      <KeyEditor {...props} />
      {renderMutationMessage(message())}
    </li>
  );
}
