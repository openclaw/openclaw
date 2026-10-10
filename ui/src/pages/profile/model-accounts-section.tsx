import { html } from "lit";
import { For, Show } from "solid-js";
import type {
  UserModelAccount,
  UserProfileAuthLink,
  UsersAuthConnectCatalogResult,
  UsersAuthConnectStartResult,
  WizardStep,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { providerDisplayLabel, renderProviderBrandIcon } from "../../components/provider-icon.ts";
import { renderPicker } from "../../components/select-picker.ts";
import {
  LearnMoreLink,
  SettingsEmpty,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { renderWizardStepControls } from "../../components/wizard-step-controls.ts";
import { registerModelAccountsEnglish } from "../../i18n/locales/en-model-accounts.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/solid-content.tsx";

registerEnglishCatalog(registerModelAccountsEnglish);

type ModelAccountsContext = {
  gatewayUrl: string;
  personLabel: string | null;
  unavailableReason: "identity" | "write" | "profile";
  onConnectionSettings: () => void;
};

export type ModelAccountsSectionProps = {
  links: UserProfileAuthLink[];
  accounts: UserModelAccount[];
  hasMore: boolean;
  inventoryLoading: boolean;
  inventoryError: string | null;
  /** Linking an arbitrary stored credential is operator.admin-only server-side. */
  showManualLink: boolean;
  busy: boolean;
  cancelBusy: boolean;
  error: string | null;
  notice: string | null;
  statusUnavailable: boolean;
  linkDraft: string;
  signIn: {
    providers: UsersAuthConnectCatalogResult["providers"];
    provider: string;
    method: string;
  } | null;
  connectFlow: (UsersAuthConnectStartResult & { step?: WizardStep }) | null;
  stepValue: unknown;
  onLinkDraftInput: (value: string) => void;
  onLink: () => void;
  onUnlink: (provider: string) => void;
  onSelectAccount: (authProfileId: string) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
  onAddAccount: () => void;
  onProviderChange: (provider: string) => void;
  onMethodChange: (method: string) => void;
  onCloseSignIn: () => void;
  onConnectStart: () => void;
  onStepValueChange: (stepId: string, value: unknown) => void;
  onStepAnswer: (stepId: string, value: unknown) => void;
  onConnectCancel: () => void;
  onConnectCheck: () => void;
};

function gatewayEndpoint(gatewayUrl: string): string {
  const url = URL.parse(gatewayUrl);
  return url ? `${url.origin}${url.pathname}` : t("profilePage.modelAccounts.gatewayUnavailable");
}

function AccountRow(props: {
  state: ModelAccountsSectionProps;
  row: { kind: "linked"; link: UserProfileAuthLink } | { kind: "saved"; account: UserModelAccount };
}) {
  const linked = () => props.row.kind === "linked";
  const reference = () => (props.row.kind === "linked" ? props.row.link : props.row.account);
  const account = () =>
    props.row.kind === "linked"
      ? props.state.accounts.find(
          (candidate) => candidate.authProfileId === reference().authProfileId,
        )
      : props.row.account;
  const label = () => account()?.label ?? t("profilePage.modelAccounts.gatewayAccount");
  const provider = () => providerDisplayLabel(reference().provider);
  const action = () =>
    t(
      linked()
        ? "profilePage.modelAccounts.unlinkAction"
        : "profilePage.modelAccounts.selectAction",
    );
  return (
    <SettingsRow
      title={
        <>
          <span class="model-accounts__id">{label()}</span>
          <span class="model-accounts__provider">{provider()}</span>
        </>
      }
      description={
        <>
          {props.row.kind === "linked"
            ? t("profilePage.modelAccounts.linkedDescription")
            : t(`profilePage.modelAccounts.authTypes.${props.row.account.authType}`)}
          <Show
            when={
              account() &&
              props.state.accounts.some(
                (candidate) =>
                  candidate.authProfileId !== reference().authProfileId &&
                  candidate.provider === reference().provider &&
                  candidate.label === label(),
              )
            }
          >
            {" "}
            <code>{reference().authProfileId}</code>
          </Show>
        </>
      }
      control={
        <>
          <Show when={linked()}>
            <SettingsStatus kind="ok" label={t("profilePage.modelAccounts.linkedStatus")} />
          </Show>
          <button
            type="button"
            class={[
              "btn btn--sm",
              { "profile-auth-link-unlink": linked(), "profile-auth-account-select": !linked() },
            ]}
            data-auth-profile-id={linked() ? undefined : reference().authProfileId}
            aria-label={
              linked()
                ? `${action()}: ${provider()} · ${account()?.label ?? reference().authProfileId}`
                : `${action()}: ${provider()} · ${label()} (${reference().authProfileId})`
            }
            disabled={props.state.busy}
            onClick={() =>
              linked()
                ? props.state.onUnlink(reference().provider)
                : props.state.onSelectAccount(reference().authProfileId)
            }
          >
            {action()}
          </button>
        </>
      }
    />
  );
}

function SignIn(props: { state: ModelAccountsSectionProps }) {
  const choice = () => props.state.signIn;
  const provider = () => choice()?.providers.find((entry) => entry.id === choice()?.provider);
  const flow = () => props.state.connectFlow;
  const cancel = () => (
    <button
      type="button"
      class="btn btn--sm profile-auth-connect-cancel"
      disabled={props.state.cancelBusy}
      onClick={() => (flow() ? props.state.onConnectCancel() : props.state.onCloseSignIn())}
    >
      {t("profilePage.modelAccounts.cancelAction")}
    </button>
  );
  return (
    <Show when={choice()}>
      <SettingsRow
        stacked
        title={
          flow()
            ? (flow()?.step?.title ??
              provider()?.label ??
              t("profilePage.modelAccounts.connectAction"))
            : t("profilePage.modelAccounts.addAccount")
        }
        control={
          <Show
            when={flow()}
            fallback={
              <div class="model-accounts-choice">
                <LitContent
                  value={renderPicker({
                    label: t("profilePage.modelAccounts.provider"),
                    className: "profile-auth-provider",
                    value: choice()?.provider || null,
                    options:
                      choice()?.providers.map((entry) => ({
                        value: entry.id,
                        label: entry.label,
                      })) ?? [],
                    disabled: props.state.busy,
                    renderLeading: (entry) => renderProviderBrandIcon(entry.value),
                    onChange: props.state.onProviderChange,
                  })}
                />
                <Show when={provider()}>
                  <LitContent
                    value={renderPicker({
                      label: t("profilePage.modelAccounts.method"),
                      className: "profile-auth-method",
                      value: choice()?.method || null,
                      options:
                        provider()?.methods.map((method) => ({
                          value: method.id,
                          label: method.label,
                          description: method.hint,
                        })) ?? [],
                      disabled: props.state.busy,
                      onChange: props.state.onMethodChange,
                    })}
                  />
                </Show>
                <Show
                  when={!props.state.busy && !props.state.error && choice()?.providers.length === 0}
                >
                  <span>{t("profilePage.modelAccounts.noMethods")}</span>
                </Show>
                <div class="wizard-step__actions">
                  {cancel()}
                  <button
                    type="button"
                    class="btn btn--sm primary profile-auth-connect-start"
                    disabled={props.state.busy || !choice()?.method}
                    onClick={() => props.state.onConnectStart()}
                  >
                    {t("profilePage.modelAccounts.connectAction")}
                  </button>
                </div>
              </div>
            }
          >
            <div class="model-accounts-flow">
              <Show
                when={flow()?.step}
                fallback={
                  <>
                    <span role="status">{t("common.loading")}</span>
                    {cancel()}
                  </>
                }
              >
                {(step) => (
                  <LitContent
                    value={renderWizardStepControls({
                      step: step(),
                      value: props.state.stepValue,
                      busy: props.state.busy,
                      inputId: "profile-account-auth-answer",
                      leadingAction: html`<button
                        type="button"
                        class="btn btn--sm profile-auth-connect-cancel"
                        ?disabled=${props.state.cancelBusy}
                        @click=${props.state.onConnectCancel}
                      >
                        ${t("profilePage.modelAccounts.cancelAction")}
                      </button>`,
                      onValueChange: (value) => props.state.onStepValueChange(step().id, value),
                      onAnswer: (value) => props.state.onStepAnswer(step().id, value),
                    })}
                  />
                )}
              </Show>
              <Show when={props.state.statusUnavailable}>
                <button
                  type="button"
                  class="btn btn--sm profile-auth-connect-check"
                  disabled={props.state.cancelBusy}
                  onClick={() => props.state.onConnectCheck()}
                >
                  {t("profilePage.modelAccounts.checkStatusAction")}
                </button>
              </Show>
            </div>
          </Show>
        }
      />
    </Show>
  );
}

function ModelAccountRows(props: { state: ModelAccountsSectionProps }) {
  return (
    <>
      <Show
        when={props.state.links.length}
        fallback={<SettingsEmpty message={t("profilePage.modelAccounts.empty")} />}
      >
        <For each={props.state.links} keyed={(link) => link.authProfileId}>
          {(link) => <AccountRow state={props.state} row={{ kind: "linked", link: link() }} />}
        </For>
      </Show>
      <For
        each={props.state.accounts.filter((account) => !account.selected)}
        keyed={(account) => account.authProfileId}
      >
        {(account) => (
          <AccountRow state={props.state} row={{ kind: "saved", account: account() }} />
        )}
      </For>
      <Show when={props.state.hasMore}>
        <SettingsRow
          title={t("profilePage.modelAccounts.savedAccounts")}
          control={
            <button
              type="button"
              class="btn btn--sm profile-auth-accounts-more"
              disabled={props.state.busy}
              onClick={() => props.state.onLoadMore()}
            >
              {t("profilePage.modelAccounts.loadMore")}
            </button>
          }
        />
      </Show>
      <SignIn state={props.state} />
      <Show when={props.state.showManualLink}>
        <SettingsRow
          title={t("profilePage.modelAccounts.inputLabel")}
          description={t("profilePage.modelAccounts.inputDescription")}
          stackedOnNarrow
          control={
            <form
              class="model-accounts-form"
              onSubmit={(event) => {
                event.preventDefault();
                props.state.onLink();
              }}
            >
              <input
                class="settings-input profile-auth-link-input"
                type="text"
                aria-label={t("profilePage.modelAccounts.inputLabel")}
                value={props.state.linkDraft}
                placeholder={t("profilePage.modelAccounts.inputPlaceholder")}
                disabled={props.state.busy}
                onInput={(event) => props.state.onLinkDraftInput(event.currentTarget.value)}
              />
              <button
                type="submit"
                class="btn btn--sm profile-auth-link-submit"
                disabled={props.state.busy || !props.state.linkDraft.trim()}
              >
                {t("profilePage.modelAccounts.linkAction")}
              </button>
            </form>
          }
        />
      </Show>
      <For each={["notice", "error"] as const}>
        {(kind) => (
          <Show when={props.state[kind]}>
            <div
              class={[
                "settings-row",
                {
                  "model-accounts-notice": kind === "notice",
                  "model-accounts-error": kind === "error",
                },
              ]}
              role={kind === "notice" ? "status" : "alert"}
            >
              <span class="settings-row__desc">{props.state[kind]}</span>
            </div>
          </Show>
        )}
      </For>
      <Show when={props.state.inventoryError}>
        <div class="settings-row model-accounts-error" role="alert">
          {t("profilePage.modelAccounts.inventoryFailed")} {props.state.inventoryError}
        </div>
      </Show>
    </>
  );
}

export function ModelAccountsSection(props: {
  context: ModelAccountsContext;
  state: ModelAccountsSectionProps | null;
}) {
  return (
    <SettingsSection
      title={t("profilePage.modelAccounts.title")}
      description={t("profilePage.modelAccounts.description")}
      actions={
        <Show when={props.state}>
          {(state) => (
            <>
              <Show when={!state().signIn}>
                <button
                  type="button"
                  class="btn btn--sm primary profile-auth-add-account"
                  disabled={state().busy}
                  onClick={() => state().onAddAccount()}
                >
                  {t("profilePage.modelAccounts.addAccount")}
                </button>
              </Show>
              <button
                type="button"
                class="btn btn--sm profile-auth-accounts-refresh"
                disabled={state().inventoryLoading}
                onClick={() => state().onRefresh()}
              >
                {t("common.refresh")}
              </button>
            </>
          )}
        </Show>
      }
    >
      <SettingsRow
        title={t("profilePage.modelAccounts.gateway")}
        stackedOnNarrow
        control={<SettingsValue mono value={gatewayEndpoint(props.context.gatewayUrl)} />}
      />
      <SettingsRow
        title={t("profilePage.modelAccounts.person")}
        stackedOnNarrow
        control={
          <SettingsValue
            value={props.context.personLabel ?? t("profilePage.modelAccounts.noPerson")}
          />
        }
      />
      <SettingsRow
        title={t("profilePage.modelAccounts.scope")}
        description={t("profilePage.modelAccounts.personalDescription")}
        control={<SettingsValue value={t("profilePage.modelAccounts.personal")} />}
      />
      <Show
        when={props.state}
        fallback={
          <SettingsRow
            title={t("profilePage.modelAccounts.signInUnavailable")}
            description={t(
              `profilePage.modelAccounts.unavailable.${props.context.unavailableReason}`,
            )}
            stacked
            control={
              <>
                <button
                  type="button"
                  class="btn btn--sm"
                  onClick={() => props.context.onConnectionSettings()}
                >
                  {t("profilePage.modelAccounts.connectionSettings")}
                </button>
                <LearnMoreLink url="https://docs.openclaw.ai/concepts/multi-user#per-person-model-accounts" />
              </>
            }
          />
        }
      >
        {(state) => <ModelAccountRows state={state()} />}
      </Show>
    </SettingsSection>
  );
}
