import { createMemo, createSignal, For, Show } from "solid-js";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { ProviderBrandIcon } from "../../components/solid/provider-icon.tsx";
import { RefreshButton } from "../../components/solid/refresh-button.tsx";
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
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatTimeMs } from "../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { JSX } from "../../types/solid-elements.js";
import { MODEL_SETTINGS_TARGET_IDS } from "../config/route-data.ts";
import "../../styles/model-providers.css";
import "../../styles/usage.css";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import { DefaultModels } from "./default-models-view.tsx";
import {
  ApiKeyInput,
  configMutationDisabled,
  ProviderRow,
  UnconnectedProviderRow,
} from "./provider-row.tsx";
import {
  hasVerifiedProvider,
  isProviderUsable,
  needsModelSetup,
  renderMutationMessage,
  ModelProviderConnectAction,
} from "./view-status.tsx";
import type { ModelProvidersViewProps } from "./view-types.ts";

registerEnglishCatalog(registerSettingsEnglish);

function AddProvider(props: ModelProvidersViewProps) {
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
              <ProviderBrandIcon provider={props.addProviderId} class="model-providers__icon" />{" "}
              {provider()?.displayName ?? props.addProviderId}
            </h2>
            <button
              class="oc-dialog__close"
              type="button"
              aria-label={t("common.close")}
              disabled={busy()}
              onClick={() => props.onAddProviderToggle()}
            >
              <Icon name="x" />
            </button>
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
                  onClick={() => props.onAddProvider(needsModelSetup(props))}
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

/** Setup prompt shown only until a usable model exists; Provider access takes over after. */
function ModelReadiness(props: ModelProvidersViewProps) {
  const signedIn = () => props.cards.some(hasVerifiedProvider);
  return (
    <Show when={needsModelSetup(props)}>
      <div class="model-providers__setup" data-model-readiness="model-required">
        <SettingsSection title={t("modelProviders.readiness.title")}>
          <SettingsRow
            title={t("modelProviders.readiness.heading")}
            description={
              signedIn()
                ? t("modelProviders.readiness.signedInNoModels")
                : t("modelProviders.readiness.notConfigured")
            }
            control={
              <>
                <SettingsStatus
                  kind="warn"
                  label={
                    signedIn()
                      ? t("modelProviders.readiness.noModels")
                      : t("modelProviders.readiness.modelRequired")
                  }
                />
                {/* An open API key form holds the page's one accent action until it closes. */}
                <button
                  class={["btn", { primary: !props.keyEditorProvider }]}
                  data-models-connect
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
  return (
    <>
      <SettingsPage>
        <>
          <ModelReadiness {...props} />
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
            <ProviderAccess {...props} />
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
  const refreshLabel = () =>
    props.refreshing ? t("modelProviders.refreshing") : t("common.refresh");
  // The last refresh time lives in the refresh tooltip instead of the header row.
  const refreshTooltip = () =>
    props.updatedAt && !props.refreshing
      ? `${refreshLabel()} · ${t("modelProviders.updated", {
          time: formatTimeMs(props.updatedAt, { hour: "numeric", minute: "2-digit" }),
        })}`
      : refreshLabel();
  // Setup with nothing connected has no list to filter.
  const nothingToSearch = () =>
    needsModelSetup(props) && props.cards.length === 0 && !props.error && !search();
  const providerRows = () => (
    <>
      <Show when={!nothingToSearch()}>
        <label class="field model-providers__search">
          <input
            type="search"
            aria-label={t("modelProviders.search")}
            placeholder={t("modelProviders.search")}
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
          <>
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
          </>
        )}
        {props.cards.length > 0 && matchingCards().length === 0 ? (
          <SettingsEmpty message={t("modelProviders.noMatches")} />
        ) : undefined}
      </div>
    </>
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
          {needsModelSetup(props) ? undefined : props.providerScope}
          <RefreshButton
            class="model-providers__refresh-button"
            label={refreshLabel()}
            tooltip={refreshTooltip()}
            busy={props.refreshing}
            onClick={() => props.onRefresh()}
          />
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

/** Provider access connects for the agent its description names. */
export function renderModelProviderScope(props: {
  onConnect: () => void;
  connectDisabled: boolean;
}): JSX.Element {
  return <ModelProviderConnectAction {...props} compact />;
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
