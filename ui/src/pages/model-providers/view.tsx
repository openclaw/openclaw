import { createMemo, Errored, For, isPending, latest, Loading, Show } from "solid-js";
import type { ModelsProbeResult } from "../../api/types.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { ProviderBrandIcon } from "../../components/solid/provider-icon.tsx";
import { renderProviderUsageDetails } from "../../components/solid/provider-usage.tsx";
import {
  LearnMoreLink,
  SettingsEmpty,
  SettingsGroup,
  SettingsLoadingSkeleton,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { formatCompactTokenCount, formatCost, formatTimeMs } from "../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { JSX } from "../../types/solid-elements.js";
import { MODEL_SETTINGS_TARGET_IDS } from "../config/route-data.ts";
import "../../styles/model-providers.css";
import "../../styles/usage.css";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import type { DefaultModelSelection, ModelProviderCard } from "./data.ts";
import { DefaultModels, type DefaultModelsViewProps } from "./default-models-view.tsx";
import { MODEL_PROVIDERS_COST_DAYS } from "./load.ts";
import type { ModelProvidersOwner } from "./model-providers-controller.ts";
import {
  apiKeySource,
  ProviderProfiles,
  type ProviderProfilesViewProps,
} from "./profiles-view.tsx";
import {
  hasVerifiedProvider,
  hasProviderCredentials,
  renderProviderStatus,
  renderMutationMessage,
  ModelProviderConnectAction,
} from "./view-status.tsx";

registerEnglishCatalog(registerSettingsEnglish);

type SharedModelProvidersProps = Omit<DefaultModelsViewProps, "models" | "selection" | "message"> &
  Omit<ProviderProfilesViewProps, "onAddAccount" | "addAccountDisabled">;
type ModelProvidersOwnerProps = Omit<
  ReturnType<ModelProvidersOwner["viewProps"]>["props"],
  | keyof SharedModelProvidersProps
  | "installedAgents"
  | "defaultModels"
  | "providerQuery"
  | "onProviderQueryChange"
>;

export type ModelProvidersViewProps = SharedModelProvidersProps & {
  [Key in keyof ModelProvidersOwnerProps]: Key extends "canConnect"
    ? ModelProvidersOwnerProps[Key]
    : ModelProvidersOwnerProps[Key] extends (...args: infer Args) => unknown
      ? (...args: Args) => void
      : ModelProvidersOwnerProps[Key];
} & {
  defaultModels: DefaultModelSelection;
  loading: boolean;
  catalogDiscovering: boolean;
  catalogDiscoveryError: string | null;
  providerDetailsReady?: boolean;
  apiKeySaving?: Record<string, boolean>;
  installedAgents: JSX.Element | typeof undefined;
  providerScope?: JSX.Element;
  accountRecovery?: JSX.Element | typeof undefined;
  providerQuery?: string;
  onProviderQueryChange?: (value: string) => void;
};

function configMutationDisabled(state: ModelProvidersViewProps): boolean {
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

function renderLocalCost(cost: ModelProviderCard["localCost"]) {
  const unavailable = cost?.usageReport?.state === "unavailable";
  if (!cost || (!unavailable && cost.totalTokens === 0 && cost.totalCost === 0)) {
    return undefined;
  }
  return (
    <div class="model-providers__local-cost">
      <div class="provider-usage-billing-row">
        <span>{t("modelProviders.localCost", { days: String(MODEL_PROVIDERS_COST_DAYS) })}</span>
        <strong>{unavailable ? t("common.unknown") : formatCost(cost.totalCost)}</strong>
      </div>
      <div class="model-providers__local-cost-detail">
        {t("modelProviders.localCostDetail", {
          tokens: unavailable ? t("common.unknown") : formatCompactTokenCount(cost.totalTokens),
          messages: String(cost.messageCount),
        })}
      </div>
    </div>
  );
}

function renderGlobalUsage(usage: ModelProviderCard["usage"], loading: boolean) {
  return usage ? (
    renderProviderUsageDetails(usage)
  ) : (
    <div class="model-providers__no-stats">
      {t(loading ? "common.loading" : "modelProviders.noStats")}
    </div>
  );
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
  return (
    <div class="model-providers__credentials">
      <span>{t("modelProviders.credentials.label", { agent: agentLabel })}</span>
      <strong>{parts.length > 0 ? parts.join(" · ") : t("modelProviders.credentials.none")}</strong>
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

function ApiKeyInput(props: {
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
  const busy = () =>
    Boolean(props.apiKeySaving?.[`key:${props.card.id}`] || props.busy[`key:${props.card.id}`]);
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

function ProviderActions(props: ModelProvidersViewProps & { card: ModelProviderCard }) {
  const authModeBlocked = () =>
    Boolean(props.card.configAuthMode && props.card.configAuthMode !== "api-key");
  const keyDisabled = () =>
    Boolean(props.apiKeySaving?.[`key:${props.card.id}`] || props.busy[`key:${props.card.id}`]) ||
    configMutationDisabled(props) ||
    authModeBlocked();
  const keyTitle = () =>
    authModeBlocked()
      ? t("modelProviders.apiKey.authModeBlocked", { mode: props.card.configAuthMode ?? "" })
      : (props.mutationBlockedReason ?? "");
  return (
    <div class="model-providers__card-actions">
      <Show when={props.canConnect(props.card) && props.card.profiles.length === 0}>
        <button
          class="btn btn--sm"
          data-models-connect-provider={props.card.id}
          disabled={configMutationDisabled(props) || props.loginBusy}
          onClick={() => props.onConnect(props.card)}
        >
          {t("modelProviders.login.action")}
        </button>
      </Show>
      <Show when={hasProviderCredentials(props.card)}>
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
          onClick={() =>
            props.onProbe(
              props.card.id,
              props.card.credentialProviderIds.length
                ? props.card.credentialProviderIds
                : [props.card.id],
            )
          }
        >
          {t(
            props.busy[`probe:${props.card.id}`]
              ? "modelProviders.probe.testing"
              : "modelProviders.probe.test",
          )}
        </button>
      </Show>
      <Show when={props.card.apiKeySupported !== false}>
        <button
          class="btn btn--sm"
          disabled={keyDisabled()}
          title={keyTitle()}
          onClick={() => props.onOpenKeyEditor(props.card.id)}
        >
          {t("modelProviders.apiKey.set")}
        </button>
      </Show>
      <Show
        when={
          props.card.hasConfigApiKey ||
          props.card.profiles.some(
            (profile) => profile.type === "api_key" && profile.logoutSupported,
          )
        }
      >
        <button
          class="btn btn--sm danger"
          disabled={keyDisabled()}
          title={keyTitle()}
          onClick={() => props.onRemoveKey(props.card.id, props.card.configKey ?? props.card.id)}
        >
          {t("modelProviders.apiKey.remove")}
        </button>
      </Show>
    </div>
  );
}

function ProviderRow(props: ModelProvidersViewProps & { card: ModelProviderCard }) {
  const card = () => props.card;
  const models = () => modelsText(card());
  const usage = () => props.metrics.usage.value().get(card().id)?.snapshot ?? card().usage;
  const plan = (value: ModelProviderCard["usage"]) =>
    value?.plan ? <SettingsValue value={value.plan} /> : undefined;
  const message = () => props.messages[`key:${card().id}`] ?? props.messages[card().id];
  return (
    <div
      class="settings-row settings-row--stacked model-providers__row"
      data-provider-id={card().id}
    >
      <div class="model-providers__head">
        <div class="model-providers__identity">
          <ProviderBrandIcon provider={card().id} class="model-providers__icon" />
          <div class="settings-row__text">
            <span class="settings-row__title">{card().displayName}</span>
            <span class="settings-row__desc">
              {card().id}
              {models() ? <> · {models()}</> : undefined}
            </span>
          </div>
        </div>
        <div class="settings-row__control">
          <Errored fallback={() => plan(card().usage)}>
            <Loading on={props.metrics.usage.request()} fallback={plan(card().usage)}>
              {plan(usage())}
            </Loading>
          </Errored>
          {renderProviderStatus(card())}
        </div>
      </div>
      {card().profiles.length > 0 && props.canViewProfiles ? (
        <ProviderProfiles
          {...props}
          canMutate={props.canMutate && !props.configBusy}
          onAddAccount={props.canConnect(card()) ? () => props.onConnect(card()) : undefined}
          addAccountDisabled={props.loginBusy || configMutationDisabled(props)}
        />
      ) : (
        renderCredentialSummary(card(), props.credentialAgentLabel)
      )}
      <div
        class="model-providers__global-metrics"
        aria-busy={props.supplementalLoading ? "true" : "false"}
      >
        <div class="model-providers__global-metrics-title">{t("modelProviders.globalUsage")}</div>
        <Errored fallback={() => renderGlobalUsage(card().usage, props.supplementalLoading)}>
          <Loading
            on={props.metrics.usage.request()}
            fallback={renderGlobalUsage(card().usage, props.supplementalLoading)}
          >
            {renderGlobalUsage(usage(), props.supplementalLoading)}
          </Loading>
        </Errored>
        <Errored fallback={() => renderLocalCost(card().localCost)}>
          <Loading on={props.metrics.cost.request()} fallback={renderLocalCost(card().localCost)}>
            {renderLocalCost(props.metrics.cost.value().get(card().id) ?? card().localCost)}
          </Loading>
        </Errored>
      </div>
      <ProviderActions {...props} /> <KeyEditor {...props} />
      {renderProbeResult(props.probeResults[card().id])} {renderMutationMessage(message())}
    </div>
  );
}

function AddProvider(props: ModelProvidersViewProps) {
  const busy = () => Boolean(props.apiKeySaving?.add) || Boolean(props.busy.add);
  const disabled = () => configMutationDisabled(props) || busy();
  const provider = () =>
    props.unconfiguredProviders.find((entry) => entry.id === props.addProviderId);
  return (
    <Show when={props.addProviderOpen}>
      <openclaw-modal-dialog
        label={t("modelProviders.add.title")}
        onModal-cancel={(event: Event) => {
          event.preventDefault();
          if (!busy()) {
            props.onAddProviderToggle();
          }
        }}
      >
        <div class="model-setup-wizard" data-models-key-dialog>
          <div class="model-setup-wizard__header">
            <h2>{provider()?.displayName ?? props.addProviderId}</h2>
          </div>
          <div class="model-setup-wizard__body">
            <p>{t("modelProviders.credentials.label", { agent: props.credentialAgentLabel })}</p>
            <ApiKeyInput
              value={props.addProviderKey}
              disabled={disabled()}
              onInput={props.onAddProviderKeyChange}
            />
            {renderMutationMessage(props.messages.add)}
          </div>
          <openclaw-modal-actions class="model-setup-wizard__footer">
            <button class="btn" disabled={busy()} onClick={() => props.onAddProviderToggle()}>
              {t("common.cancel")}
            </button>
            <button
              class="btn primary"
              disabled={disabled() || !props.addProviderId || !props.addProviderKey.trim()}
              onClick={() => props.onAddProvider()}
            >
              {busy() ? t("modelProviders.saving") : t("modelProviders.add.save")}
            </button>
          </openclaw-modal-actions>
        </div>
      </openclaw-modal-dialog>
    </Show>
  );
}

function ModelReadiness(props: ModelProvidersViewProps) {
  const signedIn = () => props.cards.some(hasVerifiedProvider);
  const ready = () => props.configuredModels.some((model) => model.available !== false);
  return (
    <div class="model-providers__setup" data-model-readiness={ready() ? "ready" : "model-required"}>
      <SettingsSection title={t("modelProviders.readiness.title")}>
        <SettingsRow
          title={t(
            ready() ? "modelProviders.readiness.readyHeading" : "modelProviders.readiness.heading",
          )}
          description={
            ready()
              ? t("modelProviders.readiness.readyDescription")
              : signedIn()
                ? t("modelProviders.readiness.signedInNoModels")
                : t("modelProviders.readiness.notConfigured")
          }
          control={
            <>
              <SettingsStatus
                kind={ready() ? "ok" : "warn"}
                label={
                  ready()
                    ? t("modelProviders.status.ready")
                    : signedIn()
                      ? t("modelProviders.readiness.noModels")
                      : t("modelProviders.readiness.modelRequired")
                }
              />
              <button
                class="btn primary"
                disabled={configMutationDisabled(props) || props.loginBusy}
                title={props.mutationBlockedReason ?? ""}
                onClick={() => props.onConnectProvider()}
              >
                {t("modelProviders.login.action")}
              </button>
            </>
          }
        />
      </SettingsSection>
    </div>
  );
}

function renderProviderNoticeRow(text: string) {
  return (
    <div class="settings-row">
      <div class="settings-row__text">
        <span class="settings-row__desc provider-usage-error">{text}</span>
      </div>
    </div>
  );
}

export function ModelProviders(props: ModelProvidersViewProps) {
  const receipt = createMemo(() => props.coreReceipt);
  // Observe core refreshes without holding edits; initial loading stays router-owned.
  const coreReady = createMemo(() => receipt()?.promise.then(() => null) ?? null, {
    loadingValue: null,
  });
  return (
    <>
      <Loading fallback={null}>{latest(coreReady)}</Loading>
      <SettingsPage>
        <>
          <Show when={props.connected || !props.loading}>
            <ModelReadiness {...props} />
          </Show>
          <div id={MODEL_SETTINGS_TARGET_IDS.behavior}>
            <DefaultModels
              {...props}
              models={props.configuredModels}
              selection={props.defaultModels}
              canMutate={props.defaultsMutationBlockedReason === null && !props.configBusy}
              mutationBlockedReason={props.defaultsMutationBlockedReason}
              message={props.messages.defaults}
            />
          </div>
          <Show
            when={props.providerDetailsReady !== false}
            fallback={
              <div class="model-providers__loading">
                <SettingsLoadingSkeleton rows={1} />
              </div>
            }
          >
            {props.installedAgents}
            <ProviderAccess {...props} refreshing={isPending(coreReady)} />
            {props.providerUsageStalled ? (
              <div class="callout warning" role="status">
                {t("usage.providerUsage.stalled")}
              </div>
            ) : undefined}
          </Show>
        </>
      </SettingsPage>
      <AddProvider {...props} />
    </>
  );
}

function CoreReadFeedback(props: Pick<ModelProvidersViewProps, "coreReceipt" | "error">) {
  const result = createMemo(() => props.coreReceipt?.promise);
  const feedback = createMemo(() => {
    result();
    if (props.error) {
      throw new Error(props.error);
    }
    return undefined;
  });
  return <>{feedback()}</>;
}

function ProviderReadFeedback(props: ModelProvidersViewProps & { refreshing: boolean }) {
  // Data rollback can clear an accepted error without starting another core read.
  const feedback = createMemo(() => ({ receipt: props.coreReceipt, error: props.error }), {
    equals: (before, after) => before.receipt === after.receipt && before.error === after.error,
  });
  return (
    <Show when={props.scopeError ?? props.error}>
      <SettingsGroup>
        <Show
          when={props.scopeError}
          fallback={
            <Show when={feedback()} keyed>
              {(current) => (
                <Errored fallback={(error) => renderProviderNoticeRow(formatUiError(error()))}>
                  <Loading
                    fallback={current.error ? renderProviderNoticeRow(current.error) : undefined}
                  >
                    <CoreReadFeedback coreReceipt={current.receipt} error={current.error} />
                  </Loading>
                </Errored>
              )}
            </Show>
          }
        >
          {(error) => renderProviderNoticeRow(error())}
        </Show>
        <button
          type="button"
          class="btn btn--sm"
          disabled={props.refreshing}
          onClick={() => props.onRefresh()}
        >
          {t("common.retry")}
        </button>
      </SettingsGroup>
    </Show>
  );
}

function ProviderAccess(props: ModelProvidersViewProps & { refreshing: boolean }) {
  const query = () => (props.providerQuery ?? "").trim().toLocaleLowerCase();
  const matchingCards = createMemo(() =>
    props.cards.filter((card) =>
      [card.id, card.displayName, ...card.credentialProviderIds].some((value) =>
        value.toLocaleLowerCase().includes(query()),
      ),
    ),
  );
  const providerRows = () => (
    <>
      <label class="field model-providers__search">
        <input
          type="search"
          aria-label={t("modelProviders.search")}
          placeholder={t("modelProviders.search")}
          value={props.providerQuery ?? ""}
          onInput={(event) => props.onProviderQueryChange?.(event.currentTarget.value)}
        />
      </label>
      <div class="model-providers__provider-list">
        <ProviderReadFeedback {...props} />
        {props.providerUsageFailed ? (
          <SettingsGroup>
            {renderProviderNoticeRow(t("usage.providerUsage.unavailable"))}
          </SettingsGroup>
        ) : undefined}
        {props.cards.length === 0 ? (
          <SettingsGroup>
            <SettingsEmpty
              message={
                <>
                  <strong>{t("modelProviders.emptyTitle")}</strong>
                  <br />
                  {t("modelProviders.emptySubtitle")}
                </>
              }
            />
          </SettingsGroup>
        ) : (
          <For each={matchingCards()} keyed={(card) => card.id}>
            {(card) => (
              <SettingsGroup>
                <ProviderRow {...props} card={card()} />
              </SettingsGroup>
            )}
          </For>
        )}
        {props.cards.length > 0 && matchingCards().length === 0 ? (
          <SettingsEmpty message={t("modelProviders.noMatches")} />
        ) : undefined}
      </div>
    </>
  );

  return (
    <SettingsSection
      title={t("modelProviders.accessTitle")}
      description={t("modelProviders.accessDescription")}
      count={props.cards.length}
      actions={
        <>
          {props.providerScope}
          {props.updatedAt ? (
            <span class="model-providers__updated">
              {t("modelProviders.updated", {
                time: formatTimeMs(props.updatedAt, {
                  hour: "numeric",
                  minute: "2-digit",
                }),
              })}
            </span>
          ) : undefined}
          <openclaw-tooltip
            prop:content={props.refreshing ? t("modelProviders.refreshing") : t("common.refresh")}
          >
            <button
              type="button"
              class="btn btn--icon btn--ghost btn--xs model-providers__refresh-button"
              aria-label={props.refreshing ? t("modelProviders.refreshing") : t("common.refresh")}
              disabled={props.refreshing}
              onClick={() => props.onRefresh()}
            >
              <Icon name="refresh" />
            </button>
          </openclaw-tooltip>
        </>
      }
    >
      <>
        {props.accountRecovery}
        {props.loading ? (
          <SettingsGroup>
            <SettingsLoadingSkeleton />
          </SettingsGroup>
        ) : props.cards.length === 0 &&
          props.installedAgents !== undefined &&
          !props.error &&
          !props.providerUsageFailed ? undefined : (
          providerRows()
        )}
      </>
    </SettingsSection>
  );
}

/** The Settings selection scopes provider access, never the global defaults above it. */
export function renderModelProviderScope(props: {
  agentLabel: string;
  onConnect: () => void;
  connectDisabled: boolean;
}): JSX.Element {
  return (
    <>
      <span class="muted" data-models-provider-agent>
        {t("agentScope.label")}: {props.agentLabel}
      </span>
      <ModelProviderConnectAction {...props} />
    </>
  );
}

export function renderModelProvidersPageShell(props: {
  body: JSX.Element;
  login: JSX.Element;
  loginMessage?: ModelProviderRowMessage;
}): JSX.Element {
  return (
    <ShellLayoutBoundary traits={{ settingsPage: true }}>
      <SettingsPageHeader
        title={t("routeTitles.modelProviders")}
        subtitle={
          <>
            {t("modelProviders.subtitle")}{" "}
            <LearnMoreLink url={"https://docs.openclaw.ai/concepts/model-providers"} />
          </>
        }
      />
      <SettingsWorkspace>
        <>
          {renderMutationMessage(props.loginMessage)}
          {props.body}
        </>
      </SettingsWorkspace>
      {props.login}
    </ShellLayoutBoundary>
  );
}
