import { For, Show } from "solid-js";
import type {
  UserModelAccount,
  UserProfileAuthLink,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
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
import { LitContent } from "../../lit/solid-bridge.ts";
import type { ModelAccountsState } from "./model-accounts-state.ts";

registerEnglishCatalog(registerModelAccountsEnglish);

type StateProps = { readState: () => ModelAccountsState };

function gatewayEndpoint(gatewayUrl: string): string {
  const url = URL.parse(gatewayUrl);
  return url ? `${url.origin}${url.pathname}` : t("profilePage.modelAccounts.gatewayUnavailable");
}

function AccountRow(props: {
  readState: () => ModelAccountsState;
  row: { kind: "linked"; link: UserProfileAuthLink } | { kind: "saved"; account: UserModelAccount };
}) {
  const state = () => props.readState();
  const linked = () => props.row.kind === "linked";
  const reference = () => (props.row.kind === "linked" ? props.row.link : props.row.account);
  const account = () =>
    props.row.kind === "linked"
      ? state().accounts.find((candidate) => candidate.authProfileId === reference().authProfileId)
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
          <span class="model-accounts__id">{label()}</span>{" "}
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
              state().accounts.some(
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
            disabled={state().busy}
            onClick={() =>
              linked()
                ? state().updateAccount("unlink", reference().provider)
                : state().updateAccount("select", reference().authProfileId)
            }
          >
            {action()}
          </button>
        </>
      }
    />
  );
}

function SignIn(props: StateProps) {
  const state = () => props.readState();
  const choice = () => state().signIn;
  const provider = () => choice()?.providers.find((entry) => entry.id === choice()?.provider);
  const flow = () => state().connectFlow;
  const cancel = () => (
    <button
      type="button"
      class="btn btn--sm profile-auth-connect-cancel"
      disabled={state().cancelBusy}
      onClick={() => (flow() ? state().connectStatus("cancel") : state().closeSignIn())}
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
                  render={() =>
                    renderPicker({
                      label: t("profilePage.modelAccounts.provider"),
                      className: "profile-auth-provider",
                      value: choice()?.provider || null,
                      options:
                        choice()?.providers.map((entry) => ({
                          value: entry.id,
                          label: entry.label,
                        })) ?? [],
                      disabled: state().busy,
                      renderLeading: (entry) => renderProviderBrandIcon(entry.value),
                      onChange: (value) => state().selectProvider(value),
                    })
                  }
                />
                <Show when={provider()}>
                  <LitContent
                    render={() =>
                      renderPicker({
                        label: t("profilePage.modelAccounts.method"),
                        className: "profile-auth-method",
                        value: choice()?.method || null,
                        options:
                          provider()?.methods.map((method) => ({
                            value: method.id,
                            label: method.label,
                            description: method.hint,
                          })) ?? [],
                        disabled: state().busy,
                        onChange: (value) => state().selectMethod(value),
                      })
                    }
                  />
                </Show>
                <Show when={!state().busy && !state().error && choice()?.providers.length === 0}>
                  <span>{t("profilePage.modelAccounts.noMethods")}</span>
                </Show>
                <div class="wizard-step__actions">
                  {cancel()}
                  <button
                    type="button"
                    class="btn btn--sm primary profile-auth-connect-start"
                    disabled={state().busy || !choice()?.method}
                    onClick={() => state().startConnect()}
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
                    render={() => {
                      const renderedStep = step();
                      const cancelAction = document.createElement("button");
                      cancelAction.type = "button";
                      cancelAction.className = "btn btn--sm profile-auth-connect-cancel";
                      cancelAction.disabled = state().cancelBusy;
                      cancelAction.textContent = t("profilePage.modelAccounts.cancelAction");
                      cancelAction.addEventListener("click", () => state().connectStatus("cancel"));
                      return renderWizardStepControls({
                        step: renderedStep,
                        value: state().stepValue,
                        busy: state().busy,
                        inputId: "profile-account-auth-answer",
                        leadingAction: cancelAction,
                        onValueChange: (value) => state().setStepValue(renderedStep.id, value),
                        onAnswer: (value) => state().answerStep(renderedStep.id, value),
                      });
                    }}
                  />
                )}
              </Show>
              <Show when={state().statusUnavailable}>
                <button
                  type="button"
                  class="btn btn--sm profile-auth-connect-check"
                  disabled={state().cancelBusy}
                  onClick={() => state().connectStatus("status")}
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

function ModelAccountRows(props: StateProps) {
  const state = () => props.readState();
  return (
    <>
      <Show
        when={state().links.length}
        fallback={<SettingsEmpty message={t("profilePage.modelAccounts.empty")} />}
      >
        <For each={state().links} keyed={(link) => link.authProfileId}>
          {(link) => (
            <AccountRow readState={props.readState} row={{ kind: "linked", link: link() }} />
          )}
        </For>
      </Show>
      <For
        each={state().accounts.filter((account) => !account.selected)}
        keyed={(account) => account.authProfileId}
      >
        {(account) => (
          <AccountRow readState={props.readState} row={{ kind: "saved", account: account() }} />
        )}
      </For>
      <Show when={Boolean(state().nextCursor)}>
        <SettingsRow
          title={t("profilePage.modelAccounts.savedAccounts")}
          control={
            <button
              type="button"
              class="btn btn--sm profile-auth-accounts-more"
              disabled={state().busy}
              onClick={() => void state().loadAccounts(state().nextCursor)}
            >
              {t("profilePage.modelAccounts.loadMore")}
            </button>
          }
        />
      </Show>
      <SignIn readState={props.readState} />
      <Show when={state().target?.canAdmin}>
        <SettingsRow
          title={t("profilePage.modelAccounts.inputLabel")}
          description={t("profilePage.modelAccounts.inputDescription")}
          stackedOnNarrow
          control={
            <form
              class="model-accounts-form"
              onSubmit={(event) => {
                event.preventDefault();
                state().updateAccount("link", state().linkDraft.trim());
              }}
            >
              <input
                class="settings-input profile-auth-link-input"
                type="text"
                aria-label={t("profilePage.modelAccounts.inputLabel")}
                value={state().linkDraft}
                placeholder={t("profilePage.modelAccounts.inputPlaceholder")}
                disabled={state().busy}
                onInput={(event) => state().setLinkDraft(event.currentTarget.value)}
              />
              <button
                type="submit"
                class="btn btn--sm profile-auth-link-submit"
                disabled={state().busy || !state().linkDraft.trim()}
              >
                {t("profilePage.modelAccounts.linkAction")}
              </button>
            </form>
          }
        />
      </Show>
      <Show when={state().notice}>
        <div class="settings-row model-accounts-notice" role="status">
          <span class="settings-row__desc">
            {t(`profilePage.modelAccounts.notices.${state().notice}`)}
          </span>
        </div>
      </Show>
      <Show when={state().error}>
        <div class="settings-row model-accounts-error" role="alert">
          <span class="settings-row__desc">{state().error}</span>
        </div>
      </Show>
      <Show when={state().inventoryError}>
        <div class="settings-row model-accounts-error" role="alert">
          {t("profilePage.modelAccounts.inventoryFailed")} {state().inventoryError}
        </div>
      </Show>
    </>
  );
}

export function ModelAccountsSection(props: StateProps) {
  const state = () => props.readState();
  const snapshot = () => state().context.gateway.snapshot;
  const person = () =>
    snapshot().selfUser?.id === state().props.identityId ? snapshot().selfUser : null;
  const personLabel = () =>
    person()
      ? state().props.personLabel ||
        person()?.name ||
        person()?.email ||
        t("profilePage.modelAccounts.currentPerson")
      : null;
  const unavailableReason = () =>
    !person()
      ? "identity"
      : hasOperatorWriteAccess(snapshot().hello?.auth ?? null)
        ? "profile"
        : "write";
  return (
    <SettingsSection
      title={t("profilePage.modelAccounts.title")}
      description={t("profilePage.modelAccounts.description")}
      actions={
        <Show when={state().target}>
          <Show when={!state().signIn}>
            <button
              type="button"
              class="btn btn--sm primary profile-auth-add-account"
              disabled={state().busy}
              onClick={() => state().openSignIn()}
            >
              {t("profilePage.modelAccounts.addAccount")}
            </button>
          </Show>
          <button
            type="button"
            class="btn btn--sm profile-auth-accounts-refresh"
            disabled={state().inventoryLoading}
            onClick={() => void state().loadAccounts()}
          >
            {t("common.refresh")}
          </button>
        </Show>
      }
    >
      <SettingsRow
        title={t("profilePage.modelAccounts.gateway")}
        stackedOnNarrow
        control={
          <SettingsValue
            mono
            value={gatewayEndpoint((state().target?.client ?? snapshot().client!).gatewayUrl)}
          />
        }
      />
      <SettingsRow
        title={t("profilePage.modelAccounts.person")}
        stackedOnNarrow
        control={<SettingsValue value={personLabel() ?? t("profilePage.modelAccounts.noPerson")} />}
      />
      <SettingsRow
        title={t("profilePage.modelAccounts.scope")}
        description={t("profilePage.modelAccounts.personalDescription")}
        control={<SettingsValue value={t("profilePage.modelAccounts.personal")} />}
      />
      <Show
        when={state().target}
        fallback={
          <SettingsRow
            title={t("profilePage.modelAccounts.signInUnavailable")}
            description={t(`profilePage.modelAccounts.unavailable.${unavailableReason()}`)}
            stacked
            control={
              <>
                <button
                  type="button"
                  class="btn btn--sm"
                  onClick={() => state().context.navigate("connection")}
                >
                  {t("profilePage.modelAccounts.connectionSettings")}
                </button>
                <LearnMoreLink url="https://docs.openclaw.ai/concepts/multi-user#per-person-model-accounts" />
              </>
            }
          />
        }
      >
        <ModelAccountRows readState={props.readState} />
      </Show>
    </SettingsSection>
  );
}
