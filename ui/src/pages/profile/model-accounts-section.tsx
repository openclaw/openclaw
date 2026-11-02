import type { JSX } from "@solidjs/web";
import { createDeferred, createMemo, Errored, For, isPending, Loading, Show } from "solid-js";
import type { UserModelAccount } from "../../../../packages/gateway-protocol/src/index.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { providerDisplayLabel } from "../../components/provider-icon-data.ts";
import { Picker } from "../../components/select-picker.ts";
import { ProviderBrandIcon } from "../../components/solid/provider-icon.tsx";
import {
  LearnMoreLink,
  SettingsEmpty,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { WizardStepControls } from "../../components/wizard-step-controls.tsx";
import { registerModelAccountsEnglish } from "../../i18n/locales/en-model-accounts.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { ModelAccountsActions } from "./model-accounts-actions.ts";
import type { ModelAccountsState } from "./model-accounts-state.ts";

registerEnglishCatalog(registerModelAccountsEnglish);

type StateProps = { readState: () => ModelAccountsState; actions: ModelAccountsActions };

function gatewayEndpoint(gatewayUrl: string): string {
  const url = URL.parse(gatewayUrl);
  return url ? `${url.origin}${url.pathname}` : t("profilePage.modelAccounts.gatewayUnavailable");
}

function AccountRow(
  props: StateProps & {
    pending: boolean;
    row:
      | { kind: "linked"; link: { provider: string; authProfileId: string } }
      | { kind: "saved"; account: UserModelAccount };
  },
) {
  const state = () => props.readState();
  const accounts = createMemo(() => state().accounts);
  const linked = () => props.row.kind === "linked";
  const reference = () => (props.row.kind === "linked" ? props.row.link : props.row.account);
  const account = createMemo(() =>
    props.row.kind === "linked"
      ? accounts().find((candidate) => candidate.authProfileId === reference().authProfileId)
      : props.row.account,
  );
  const label = () => account()?.label ?? t("profilePage.modelAccounts.gatewayAccount");
  const duplicateLabel = createMemo(
    () =>
      account() &&
      accounts().some(
        (candidate) =>
          candidate.authProfileId !== reference().authProfileId &&
          candidate.provider === reference().provider &&
          candidate.label === label(),
      ),
  );
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
          <Show when={duplicateLabel()}>
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
            disabled={props.pending || props.actions.saving() || state().busy}
            onClick={() => {
              void (linked()
                ? props.actions.updateAccount("unlink", reference().provider)
                : props.actions.updateAccount("select", reference().authProfileId));
            }}
          >
            {action()}
          </button>
        </>
      }
    />
  );
}

function SignInChoice(props: StateProps & { pending: boolean; cancel: JSX.Element }) {
  const state = () => props.readState();
  const choice = () => state().signIn;
  const provider = () => choice()?.providers.find((entry) => entry.id === choice()?.provider);
  return (
    <div class="model-accounts-choice">
      <Picker
        params={{
          label: t("profilePage.modelAccounts.provider"),
          className: "profile-auth-provider",
          value: choice()?.provider || null,
          options:
            choice()?.providers.map((entry) => ({
              value: entry.id,
              label: entry.label,
            })) ?? [],
          disabled: props.pending || state().busy,
          renderLeading: (entry) => <ProviderBrandIcon provider={entry.value} />,
          onChange: (value) => state().selectProvider(value),
        }}
      />
      <Show when={provider()}>
        <Picker
          params={{
            label: t("profilePage.modelAccounts.method"),
            className: "profile-auth-method",
            value: choice()?.method || null,
            options:
              provider()?.methods.map((method) => ({
                value: method.id,
                label: method.label,
                description: method.hint,
              })) ?? [],
            disabled: props.pending || state().busy,
            onChange: (value) => state().selectMethod(value),
          }}
        />
      </Show>
      <Show
        when={!props.pending && !state().busy && !state().error && choice()?.providers.length === 0}
      >
        <span>{t("profilePage.modelAccounts.noMethods")}</span>
      </Show>
      <div class="wizard-step__actions">
        {props.cancel}
        <button
          type="button"
          class="btn btn--sm primary profile-auth-connect-start"
          disabled={props.pending || state().busy || !choice()?.method}
          onClick={() => void props.actions.startConnect()}
        >
          {t("profilePage.modelAccounts.connectAction")}
        </button>
      </div>
    </div>
  );
}

function StatusCheck(props: StateProps & { pending: boolean; onCheck: () => void }) {
  const state = () => props.readState();
  return (
    <Show when={state().statusUnavailable || props.pending}>
      <button
        type="button"
        class="btn btn--sm profile-auth-connect-check"
        disabled={props.pending || state().cancelBusy}
        onClick={() => props.onCheck()}
      >
        {t("profilePage.modelAccounts.checkStatusAction")}
      </button>
    </Show>
  );
}

function SignIn(props: StateProps) {
  const state = () => props.readState();
  const choice = () => state().signIn;
  const provider = () => choice()?.providers.find((entry) => entry.id === choice()?.provider);
  const flow = () => props.actions.flow();
  const catalogReceipt = createMemo(() => state().catalogReceipt);
  const catalogRead = createDeferred(() =>
    catalogReceipt().result.then((error) => {
      if (error) {
        throw new Error(error);
      }
    }),
  );
  const statusReceipt = createMemo(() => state().statusReceipt);
  const statusRead = createDeferred(() =>
    statusReceipt().result.then((error) => {
      if (error) {
        throw new Error(error);
      }
    }),
  );
  const readCatalog = () => {
    catalogRead();
    return null;
  };
  const readStatus = () => {
    statusRead();
    return null;
  };
  const cancel = () => (
    <button
      type="button"
      class="btn btn--sm profile-auth-connect-cancel"
      disabled={state().cancelBusy}
      onClick={() => {
        if (flow()) {
          void props.actions.cancel();
        } else {
          state().closeSignIn();
        }
      }}
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
              <Errored
                fallback={() => (
                  <SignInChoice
                    readState={props.readState}
                    actions={props.actions}
                    pending={false}
                    cancel={cancel()}
                  />
                )}
              >
                <Loading
                  fallback={
                    <SignInChoice
                      readState={props.readState}
                      actions={props.actions}
                      pending
                      cancel={cancel()}
                    />
                  }
                >
                  {readCatalog()}
                  <SignInChoice
                    readState={props.readState}
                    actions={props.actions}
                    pending={isPending(catalogRead)}
                    cancel={cancel()}
                  />
                </Loading>
              </Errored>
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
                  <WizardStepControls
                    step={step()}
                    value={state().stepValue}
                    busy={state().busy}
                    inputId="profile-account-auth-answer"
                    leadingAction={cancel()}
                    onValueChange={(value) => state().setStepValue(step().id, value)}
                    onAnswer={(value) => void props.actions.answerStep(step().id, value)}
                  />
                )}
              </Show>
              <Errored
                fallback={(_error, reset) => (
                  <StatusCheck
                    readState={props.readState}
                    actions={props.actions}
                    pending={false}
                    onCheck={() => {
                      void state().connectStatus("status");
                      reset();
                    }}
                  />
                )}
              >
                <Loading
                  fallback={
                    <StatusCheck
                      readState={props.readState}
                      actions={props.actions}
                      pending
                      onCheck={() => void state().connectStatus("status")}
                    />
                  }
                >
                  {readStatus()}
                  <StatusCheck
                    readState={props.readState}
                    actions={props.actions}
                    pending={isPending(statusRead)}
                    onCheck={() => void state().connectStatus("status")}
                  />
                </Loading>
              </Errored>
            </div>
          </Show>
        }
      />
    </Show>
  );
}

export function ModelAccountInventory(props: StateProps & { pending: boolean }) {
  const state = () => props.readState();
  const accounts = createMemo(() => state().accounts);
  const savedAccounts = createMemo(() =>
    accounts().filter(
      (account) =>
        !props.actions.links().some((link) => link.authProfileId === account.authProfileId),
    ),
  );
  return (
    <>
      <Show
        when={props.actions.links().length}
        fallback={<SettingsEmpty message={t("profilePage.modelAccounts.empty")} />}
      >
        <For each={props.actions.links()} keyed={(link) => link.authProfileId}>
          {(link) => (
            <AccountRow
              readState={props.readState}
              actions={props.actions}
              pending={props.pending}
              row={{ kind: "linked", link: link() }}
            />
          )}
        </For>
      </Show>
      <For each={savedAccounts()} keyed={(account) => account.authProfileId}>
        {(account) => (
          <AccountRow
            readState={props.readState}
            actions={props.actions}
            pending={props.pending}
            row={{ kind: "saved", account: account() }}
          />
        )}
      </For>
      <Show when={Boolean(state().nextCursor)}>
        <SettingsRow
          title={t("profilePage.modelAccounts.savedAccounts")}
          control={
            <button
              type="button"
              class="btn btn--sm profile-auth-accounts-more"
              disabled={props.pending || props.actions.saving() || state().busy}
              onClick={() => void state().loadAccounts(state().nextCursor)}
            >
              {t("profilePage.modelAccounts.loadMore")}
            </button>
          }
        />
      </Show>
    </>
  );
}

function ModelAccountActions(props: StateProps) {
  const state = () => props.readState();
  return (
    <>
      <SignIn readState={props.readState} actions={props.actions} />
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
                void props.actions.updateAccount("link", state().linkDraft.trim());
              }}
            >
              <input
                class="settings-input profile-auth-link-input"
                type="text"
                aria-label={t("profilePage.modelAccounts.inputLabel")}
                value={state().linkDraft}
                placeholder={t("profilePage.modelAccounts.inputPlaceholder")}
                disabled={props.actions.saving() || state().busy}
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

export function ModelAccountsSection(props: StateProps & { inventory: JSX.Element }) {
  const state = () => props.readState();
  const snapshot = () => state().props.target.read().gateway;
  const person = () =>
    snapshot().selfUser?.id === state().props.target.read().identityId ? snapshot().selfUser : null;
  const personLabel = () =>
    person() || state().target
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
              disabled={props.actions.saving() || state().busy}
              onClick={() => state().openSignIn()}
            >
              {t("profilePage.modelAccounts.addAccount")}
            </button>
          </Show>
          <button
            type="button"
            class="btn btn--sm profile-auth-accounts-refresh"
            disabled={!state().connected || state().inventoryLoading}
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
        {props.inventory}
        <ModelAccountActions readState={props.readState} actions={props.actions} />
      </Show>
    </SettingsSection>
  );
}
