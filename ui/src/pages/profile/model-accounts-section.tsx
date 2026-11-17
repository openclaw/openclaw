import type { JSX } from "@solidjs/web";
import { createDeferred, createMemo, Errored, For, isPending, Loading, Show } from "solid-js";
import type { UserModelAccount } from "../../../../packages/gateway-protocol/src/index.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { Picker } from "../../components/select-picker.ts";
import { SettingsSectionHelp } from "../../components/solid/settings-section-help.tsx";
import {
  LearnMoreLink,
  SettingsEmpty,
  SettingsLoadingSkeleton,
  SettingsRow,
  SettingsSection,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { WizardStepControls } from "../../components/wizard-step-controls.tsx";
import { registerModelAccountsEnglish } from "../../i18n/locales/en-model-accounts.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import {
  ModelProviderIcon,
  useProviderDisplayLabel,
} from "../../lib/reactive/provider-presentation.tsx";
import type { ModelAccountsActions } from "./model-accounts-actions.ts";
import type { ModelAccountsState } from "./model-accounts-state.ts";

registerEnglishCatalog(registerModelAccountsEnglish);

type StateProps = { readState: () => ModelAccountsState; actions: ModelAccountsActions };

function gatewayEndpoint(gatewayUrl: string): string {
  const url = URL.parse(gatewayUrl);
  return url ? `${url.origin}${url.pathname}` : t("profilePage.modelAccounts.gatewayUnavailable");
}

// Not a valid auth profile id: profile ids always carry a provider prefix.
const GATEWAY_DEFAULT_OPTION = "gateway-default";
// The shared width of lone value controls in settings rows, so these read as one column.
const PICKER_WIDTH = "width:340px;max-width:100%;min-width:0";

function ProviderRow(
  props: StateProps & {
    pending: boolean;
    provider: string;
    accounts: readonly UserModelAccount[];
    linkedId: string | undefined;
  },
) {
  const providerDisplayLabel = useProviderDisplayLabel();
  const state = () => props.readState();
  const name = () => providerDisplayLabel(props.provider);
  const options = createMemo(() => {
    const labels = props.accounts.map((account) => account.label);
    return [
      ...props.accounts.map((account) => {
        const kind = t(`profilePage.modelAccounts.authTypes.${account.authType}`);
        return {
          value: account.authProfileId,
          label: account.label,
          // Only identical labels need the stored profile id to tell them apart.
          description:
            labels.indexOf(account.label) === labels.lastIndexOf(account.label)
              ? kind
              : `${kind} · ${account.authProfileId}`,
        };
      }),
      // A selected account can sit on an inventory page that has not loaded yet.
      ...(props.linkedId &&
      !props.accounts.some((account) => account.authProfileId === props.linkedId)
        ? [{ value: props.linkedId, label: t("profilePage.modelAccounts.gatewayAccount") }]
        : []),
      { value: GATEWAY_DEFAULT_OPTION, label: t("profilePage.modelAccounts.unlinkAction") },
    ];
  });
  return (
    <SettingsRow
      title={name()}
      control={
        <Picker
          style={PICKER_WIDTH}
          params={{
            label: `${name()}: ${t("profilePage.modelAccounts.linkedStatus")}`,
            className: "profile-auth-account-picker",
            value: props.linkedId ?? GATEWAY_DEFAULT_OPTION,
            options: options(),
            disabled: props.pending || props.actions.saving() || state().busy,
            onChange: (value) => {
              void (value === GATEWAY_DEFAULT_OPTION
                ? props.actions.updateAccount("unlink", props.provider)
                : props.actions.updateAccount("select", value));
            },
          }}
        />
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
      <SettingsRow
        title={t("profilePage.modelAccounts.provider")}
        stackedOnNarrow
        control={
          <Picker
            style={PICKER_WIDTH}
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
              renderLeading: (entry) => <ModelProviderIcon provider={entry.value} />,
              onChange: (value) => state().selectProvider(value),
            }}
          />
        }
      />
      <Show when={provider()}>
        <SettingsRow
          title={t("profilePage.modelAccounts.method")}
          stackedOnNarrow
          control={
            <Picker
              style={PICKER_WIDTH}
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
          }
        />
      </Show>
      <Show
        when={!props.pending && !state().busy && !state().error && choice()?.providers.length === 0}
      >
        <SettingsRow title={t("profilePage.modelAccounts.noMethods")} />
      </Show>
      <div class="settings-row settings-row--actions">
        <div class="settings-row__control">
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

/** Where a sign-in lands: only worth reading while signing in or diagnosing why it can't. */
function SignInContext(props: { readState: () => ModelAccountsState }) {
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
  return (
    <>
      <SettingsRow
        title={t("profilePage.modelAccounts.gateway")}
        control={
          <SettingsValue
            mono
            value={gatewayEndpoint((state().target?.client ?? snapshot().client!).gatewayUrl)}
          />
        }
      />
      <SettingsRow
        title={t("profilePage.modelAccounts.person")}
        control={<SettingsValue value={personLabel() ?? t("profilePage.modelAccounts.noPerson")} />}
      />
    </>
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
      <Show
        when={flow()}
        fallback={
          <>
            <SettingsRow
              title={t("profilePage.modelAccounts.addAccount")}
              description={t("profilePage.modelAccounts.personalDescription")}
            />
            <SignInContext readState={props.readState} />
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
          </>
        }
      >
        <SettingsRow
          stacked
          title={
            flow()?.step?.title ?? provider()?.label ?? t("profilePage.modelAccounts.connectAction")
          }
          control={
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
          }
        />
      </Show>
    </Show>
  );
}

export function ModelAccountInventory(props: StateProps & { pending: boolean }) {
  const state = () => props.readState();
  const accounts = createMemo(() => state().accounts);
  // Group once: status publications must not rescan the inventory per row.
  const accountsByProvider = createMemo(() => Map.groupBy(accounts(), (entry) => entry.provider));
  const linkedByProvider = createMemo(
    () => new Map(props.actions.links().map((link) => [link.provider, link.authProfileId])),
  );
  // One row per provider, in inventory order so choosing a default never reorders the list.
  const providers = createMemo(() => [
    ...new Set([...accountsByProvider().keys(), ...linkedByProvider().keys()]),
  ]);
  return (
    <>
      <Show
        when={providers().length}
        fallback={
          <Show
            when={!props.pending && !state().inventoryLoading}
            fallback={<SettingsLoadingSkeleton label={t("common.loading")} rows={2} />}
          >
            {/* A failed read says so below; it must not also claim there is nothing selected. */}
            <Show when={!state().inventoryError}>
              <SettingsEmpty message={t("profilePage.modelAccounts.empty")} />
            </Show>
          </Show>
        }
      >
        <For each={providers()} keyed={(provider) => provider}>
          {(provider) => (
            <ProviderRow
              readState={props.readState}
              actions={props.actions}
              pending={props.pending}
              provider={provider()}
              accounts={accountsByProvider().get(provider()) ?? []}
              linkedId={linkedByProvider().get(provider())}
            />
          )}
        </For>
      </Show>
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
      <Show when={state().signIn && state().target?.canAdmin}>
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
          <span class="settings-row__desc">
            {t("profilePage.modelAccounts.inventoryFailed")} {state().inventoryError}
          </span>
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
  const unavailableReason = () =>
    snapshot().phase !== "connected"
      ? "disconnected"
      : !person()
        ? "identity"
        : hasOperatorWriteAccess(snapshot().hello?.auth ?? null)
          ? "profile"
          : "write";
  return (
    <SettingsSection
      title={t("profilePage.modelAccounts.title")}
      description={t("profilePage.modelAccounts.description")}
      actions={
        <>
          <Show when={state().target && !state().signIn}>
            <button
              type="button"
              class="btn btn--sm primary profile-auth-add-account"
              disabled={props.actions.saving() || state().busy}
              onClick={() => state().openSignIn()}
            >
              {t("profilePage.modelAccounts.addAccount")}
            </button>
          </Show>
          <SettingsSectionHelp
            id="settings-profile-model-accounts-help"
            section={t("profilePage.modelAccounts.title")}
          >
            <p>{t("profilePage.modelAccounts.descriptionMore")}</p>
          </SettingsSectionHelp>
        </>
      }
    >
      <Show when={state().target && snapshot().phase !== "connected"}>
        <SettingsRow
          title={t("profilePage.modelAccounts.signInUnavailable")}
          description={t("profilePage.modelAccounts.unavailable.disconnected")}
        />
      </Show>
      <Show
        when={state().target}
        fallback={
          <>
            <SignInContext readState={props.readState} />
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
          </>
        }
      >
        {props.inventory}
        <ModelAccountActions readState={props.readState} actions={props.actions} />
      </Show>
    </SettingsSection>
  );
}
