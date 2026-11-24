import { createMemo, createSignal, For, Show } from "solid-js";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { IconButton } from "../../components/solid/icon-button.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { RefreshButton } from "../../components/solid/refresh-button.tsx";
import {
  LearnMoreLink,
  SettingsEmpty,
  SettingsGroup,
  SettingsLoadingSkeleton,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerRouteSubtitlesEnglish } from "../../i18n/locales/en-route-subtitles.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatTimeMs } from "../../lib/format.ts";
import { canonicalModelAuthProviderId } from "../../lib/model-auth.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import {
  ModelProviderIcon,
  useProviderDisplayLabel,
} from "../../lib/reactive/provider-presentation.tsx";
import type { JSX } from "../../types/solid-elements.js";
import "../../styles/model-providers.css";
import { MODEL_SETTINGS_TARGET_IDS } from "../config/route-data.ts";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import { DefaultModels } from "./default-models-view.tsx";
import { ProviderCatalog } from "./provider-catalog.tsx";
import {
  ApiKeyInput,
  configMutationDisabled,
  ProviderRow,
  UnconnectedProviderRow,
} from "./provider-row.tsx";
import { hasVerifiedProvider, isProviderUsable, renderMutationMessage } from "./view-status.tsx";
import type { ModelProvidersViewProps } from "./view-types.ts";

registerEnglishCatalog(registerSettingsEnglish);
// The page header reads subtitles.modelProviders from the route subtitle catalog.
registerRouteSubtitlesEnglish();

function AddProvider(props: ModelProvidersViewProps) {
  const displayLabel = useProviderDisplayLabel();
  const busy = () => Boolean(props.busy.add);
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
        <div class="oc-dialog model-setup-wizard" data-models-key-dialog>
          <div class="oc-dialog__header">
            <h2 class="oc-dialog__title">
              <ModelProviderIcon provider={props.addProviderId} class="model-providers__icon" />{" "}
              {provider()?.displayName ?? displayLabel(props.addProviderId)}
            </h2>
            <IconButton
              size={28}
              class="oc-dialog__close"
              icon="x"
              label={t("common.close")}
              tooltip={false}
              disabled={busy()}
              onClick={() => props.onAddProviderToggle()}
            />
            <div class="oc-dialog__description">
              <p>{t("modelProviders.credentials.label", { agent: props.credentialAgentLabel })}</p>
            </div>
          </div>
          <div class="oc-dialog__body model-setup-wizard__body">
            <Show when={!props.addStartChat}>
              <ApiKeyInput
                value={props.addProviderKey}
                disabled={disabled()}
                labelOnly
                onInput={props.onAddProviderKeyChange}
              />
            </Show>
            {renderMutationMessage(props.messages.add)}
          </div>
          <openclaw-modal-actions class="oc-dialog__footer model-setup-wizard__footer">
            <button class="btn" disabled={busy()} onClick={() => props.onAddProviderToggle()}>
              {t(props.addStartChat ? "common.close" : "common.cancel")}
            </button>
            <Show
              when={props.addStartChat}
              fallback={
                <button
                  class="btn primary"
                  disabled={disabled() || !props.addProviderId || !props.addProviderKey.trim()}
                  // With no usable model yet, saving also makes this key the agent's model.
                  onClick={() => props.onAddProvider(props.modelRequired)}
                >
                  {props.busy["check:add"]
                    ? t("modelProviders.apiKey.checking")
                    : busy()
                      ? t("modelProviders.saving")
                      : t("modelProviders.add.save")}
                </button>
              }
            >
              {(model) => (
                <button
                  class="btn primary"
                  disabled={busy()}
                  onClick={() => props.onAddStartChat()}
                >
                  {t("modelProviders.login.startChat", { model: model().name })}
                </button>
              )}
            </Show>
          </openclaw-modal-actions>
        </div>
      </openclaw-modal-dialog>
    </Show>
  );
}

function renderProviderNoticeRow(text: string, detail?: string) {
  return (
    <div class="settings-row" role="alert">
      <div class="settings-row__text">
        <span class="settings-row__desc provider-usage__error">{text}</span>
        <Show when={detail && detail !== text}>
          <span class="settings-row__desc">{detail}</span>
        </Show>
      </div>
    </div>
  );
}

export function ModelProviders(props: ModelProvidersViewProps) {
  // A provider counts once the agent can use it; its other credential owners count with it.
  const connected = createMemo(() => {
    const ids = new Set<string>();
    for (const card of props.cards.filter(isProviderUsable)) {
      for (const id of [card.id, ...card.credentialProviderIds]) {
        ids.add(canonicalModelAuthProviderId(id));
      }
    }
    return ids;
  });
  // Settled once per load: a reload keeps the catalog, and any search typed in it, in place.
  const first = createMemo<boolean | undefined>((previous) =>
    props.providerDetailsReady === false || props.loading ? previous : connected().size === 0,
  );
  const available = (model: { available?: boolean }) => model.available !== false;
  // A provider with credentials can list models, so its listing errors (shown in the defaults
  // heading, with Retry) matter; before that the defaults are empty controls.
  const providerSetUp = () =>
    props.cards.some((card) => isProviderUsable(card) || card.profiles.length > 0);
  const savedDefaults = () => {
    const saved = props.defaultModels;
    return (
      Boolean(
        saved.primary || saved.fallbacks.length || saved.utilityModel || saved.decisionModel,
      ) ||
      props.thinkingOverridden ||
      props.fastModeOverridden
    );
  };
  // A decision model works without a chat model, so its choices alone keep the defaults reachable.
  const hasDefaults = () =>
    savedDefaults() ||
    props.configuredModels.some(available) ||
    providerSetUp() ||
    props.decisionModels.length > 0;
  // A new user's first action is the catalog; unset defaults wait below it. Saved defaults and
  // returning users keep them on top, where data arriving later never pushes them down.
  const defaultsBelow = () => first() === true && !savedDefaults();
  const defaults = () => (
    <div id={MODEL_SETTINGS_TARGET_IDS.behavior}>
      <DefaultModels
        {...props}
        models={props.configuredModels}
        selection={props.defaultModels}
        canMutate={props.defaultsMutationBlockedReason === null && !props.configBusy}
        mutationBlockedReason={props.defaultsMutationBlockedReason}
        message={props.messages.defaults}
        // Before any provider or default is set up, providers can't list models and the
        // catalog is the call to action; a listing failure isn't news then.
        catalogDiscoveryError={
          !props.defaultModels.primary && !providerSetUp() ? null : props.catalogDiscoveryError
        }
      />
    </div>
  );
  const signedInNoModels = () =>
    props.modelRequired &&
    props.cards.some(hasVerifiedProvider) &&
    !props.configuredModels.some(available);
  const catalog = () => (
    <ProviderCatalog
      providers={props.catalogProviders}
      connected={connected()}
      first={first() === true}
      agentLabel={props.credentialAgentLabel}
      disabled={configMutationDisabled(props) || props.loginBusy || props.addProviderOpen}
      loading={props.loading}
      initialQuery={first() ? props.providerQuery : undefined}
      searchRef={props.catalogSearchRef}
      onConnect={props.onCatalogConnect}
      onDiscover={props.onDiscover}
      discoverDisabled={props.discoverDisabled}
    />
  );
  return (
    <>
      <SettingsPage carapace>
        {props.accountRecovery}
        <Show when={signedInNoModels()}>
          <InlineAlert tone="warning" role="status" data-model-readiness="no-models">
            {t("modelProviders.readiness.signedInNoModels")}
          </InlineAlert>
        </Show>
        <Show when={hasDefaults() && (first() === false || savedDefaults())}>{defaults()}</Show>
        <Show
          when={first() !== undefined}
          fallback={
            <div class="model-providers__loading">
              <SettingsLoadingSkeleton rows={2} />
            </div>
          }
        >
          <Show when={first()}>{catalog()}</Show>
          <Show when={props.loading && first() === false}>
            <SettingsLoadingSkeleton rows={2} />
          </Show>
          <Show
            when={
              !props.loading &&
              (props.cards.length > 0 ||
                props.error ||
                props.providerUsageFailed ||
                props.providerUsageStalled)
            }
          >
            <ProviderAccess {...props} />
          </Show>
          {props.installedAgents}
          <Show when={hasDefaults() && defaultsBelow()}>{defaults()}</Show>
          <Show when={first() === false}>{catalog()}</Show>
          {props.providerUsageStalled ? (
            <InlineAlert tone="warning" role="status">
              {t("usage.providerUsage.stalled")}
            </InlineAlert>
          ) : undefined}
        </Show>
      </SettingsPage>
      <AddProvider {...props} />
    </>
  );
}

function ProviderAccess(props: ModelProvidersViewProps) {
  // Local draft: typing filters here without a page update. Only a different
  // deep-linked provider from the route re-derives it; the memo drops equal
  // values from page revalidation.
  const routeQuery = createMemo(() => props.providerQuery ?? "");
  const [search, setSearch] = createSignal(() => routeQuery());
  const query = () => search().trim().toLocaleLowerCase().normalize("NFC");
  const matchingCards = createMemo(() =>
    props.cards.filter((card) =>
      [card.id, card.displayName, ...card.credentialProviderIds].some((value) =>
        value.toLocaleLowerCase().normalize("NFC").includes(query()),
      ),
    ),
  );
  // Usable providers lead; the rest sit below in a quieter group.
  const groups = createMemo(() => {
    const ranked = matchingCards().toSorted((a, b) => a.displayName.localeCompare(b.displayName));
    return {
      connected: ranked.filter(isProviderUsable),
      unconnected: ranked.filter((card) => !isProviderUsable(card)),
    };
  });
  const connected = () => groups().connected;
  const unconnected = () => groups().unconnected;
  // The last refresh time lives in the refresh tooltip instead of the header row.
  const refreshTooltip = () =>
    props.updatedAt && !props.refreshing
      ? t("modelProviders.updated", {
          time: formatTimeMs(props.updatedAt, { hour: "numeric", minute: "2-digit" }),
        })
      : undefined;
  // A short list reads at a glance; the filter earns its row on a long one. Once shown (or seeded
  // by a link) it stays, so clearing the field never removes it mid-typing.
  const filterable = createMemo<boolean>(
    (shown) => shown === true || props.cards.length > 6 || Boolean(search()),
  );
  return (
    <SettingsSection
      carapace
      title={t("modelProviders.accessTitle")}
      description={t("modelProviders.accessDescription", { agent: props.credentialAgentLabel })}
      actions={
        <>
          <button type="button" class="btn btn--sm btn--ghost" onClick={() => props.onOpenUsage()}>
            {t("modelProviders.viewUsage")}
          </button>
          <RefreshButton
            class="model-providers__refresh-button"
            label={t("common.refresh")}
            tooltip={refreshTooltip()}
            disabled={props.refreshing}
            onClick={() => props.onRefresh()}
          />
        </>
      }
    >
      <Show when={filterable()}>
        <label class="field model-providers__search">
          <input
            type="search"
            aria-label={t("modelProviders.searchConnected")}
            placeholder={t("modelProviders.searchConnected")}
            value={search()}
            onInput={(event) => setSearch(event.currentTarget.value)}
          />
        </label>
      </Show>
      <div class="model-providers__provider-list">
        <Show when={props.error}>
          {(error) => (
            <SettingsGroup>
              {renderProviderNoticeRow(t("modelProviders.configUnavailable"), error())}
              <button
                type="button"
                class="btn btn--sm"
                disabled={props.refreshing}
                onClick={() => props.onRefresh()}
              >
                {t("common.retry")}
              </button>
            </SettingsGroup>
          )}
        </Show>
        {props.providerUsageFailed ? (
          <SettingsGroup>
            {renderProviderNoticeRow(t("usage.providerUsage.unavailable"))}
          </SettingsGroup>
        ) : undefined}
        <Show when={connected().length > 0}>
          <SettingsGroup carapace>
            <ul class="provider-list">
              <For each={connected()} keyed={(card) => card.id}>
                {(card) => <ProviderRow {...props} card={card()} />}
              </For>
            </ul>
          </SettingsGroup>
        </Show>
        <Show when={unconnected().length > 0}>
          <section class="settings-section provider-list__section">
            <h3 class="settings-section__heading">{t("modelProviders.row.notConnected")}</h3>
            <SettingsGroup carapace>
              <ul class="provider-list provider-list--quiet">
                <For each={unconnected()} keyed={(card) => card.id}>
                  {(card) => <UnconnectedProviderRow {...props} card={card()} />}
                </For>
              </ul>
            </SettingsGroup>
          </section>
        </Show>
        {props.cards.length > 0 && matchingCards().length === 0 ? (
          <SettingsEmpty message={t("modelProviders.noMatches")} />
        ) : undefined}
      </div>
    </SettingsSection>
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
            {t("subtitles.modelProviders")}{" "}
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
