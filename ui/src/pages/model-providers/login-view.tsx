import { createMemo, Errored, For, Loading, Show } from "solid-js";
import type { ModelAuthStatusResult } from "../../api/types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { ModelProviderIcon } from "../../lib/reactive/provider-presentation.tsx";
import { ModelSetupWizard } from "../model-setup/wizard-view-solid.tsx";
import type { ModelProviderLogin } from "./login-controller.ts";
import { ProviderAccountSummary } from "./profiles-view.tsx";

export function ModelProviderLoginView(props: { controller: ModelProviderLogin }) {
  const picker = createMemo(() => props.controller.pickerView());
  const wizard = createMemo(() => props.controller.wizardViewProps);
  return (
    <Show
      when={picker()}
      fallback={
        <div onModal-cancel={(event: Event) => event.preventDefault()}>
          <ModelSetupWizard
            {...wizard()}
            busy={props.controller.saving()}
            doneAction={props.controller.doneAction()}
          />
        </div>
      }
    >
      {(current) => (
        <Show when={current().inventory} keyed>
          {(inventory) => (
            <Errored
              fallback={(error) => (
                <PickerDialog
                  controller={props.controller}
                  current={current()}
                  error={formatUiError(error(), t("modelProviders.requestFailed"))}
                />
              )}
            >
              <Loading
                fallback={
                  <PickerDialog controller={props.controller} current={current()} loading />
                }
              >
                <InventoryPicker controller={props.controller} inventory={inventory} />
              </Loading>
            </Errored>
          )}
        </Show>
      )}
    </Show>
  );
}

function InventoryPicker(props: {
  controller: ModelProviderLogin;
  inventory: { value: ModelAuthStatusResult | Promise<ModelAuthStatusResult | null> };
}) {
  const inventory = createMemo(() => props.inventory.value);
  const picker = createMemo(() => props.controller.pickerView(inventory()));
  return (
    <Show when={picker()}>
      {(current) => <PickerDialog controller={props.controller} current={current()} />}
    </Show>
  );
}

function PickerDialog(props: {
  controller: ModelProviderLogin;
  current: NonNullable<ReturnType<ModelProviderLogin["pickerView"]>>;
  loading?: boolean;
  error?: string;
}) {
  let searchInput: HTMLInputElement | undefined;
  const current = createMemo(() => props.current);
  return (
    <openclaw-modal-dialog
      prop:initialFocus={() => (searchInput?.isConnected ? searchInput : null)}
      label={current().provider?.label ?? t("modelProviders.login.title")}
      onModal-cancel={() => current().onClose()}
    >
      <div
        class={[
          "oc-dialog model-setup-wizard model-provider-login",
          { "model-provider-login--catalog": !current().provider },
        ]}
      >
        <div class="oc-dialog__header">
          <h2 class="oc-dialog__title">
            <Show when={current().provider} fallback={t("modelProviders.login.title")}>
              {(provider) => (
                <>
                  <ModelProviderIcon provider={provider().id} class="model-providers__icon" />{" "}
                  {provider().label}
                </>
              )}
            </Show>
          </h2>
          <button
            class="oc-dialog__close"
            type="button"
            aria-label={t("common.close")}
            onClick={() => current().onClose()}
          >
            <Icon name="x" />
          </button>
          <div class="oc-dialog__description">
            <p>{current().description}</p>
            <Show when={current().provider && !props.loading && !props.error}>
              <p>
                <a
                  class="learn-more-link"
                  href={current().docsUrl}
                  target={EXTERNAL_LINK_TARGET}
                  rel={buildExternalLinkRel()}
                >
                  {t("modelProviders.login.compareMethods")}
                </a>
              </p>
            </Show>
          </div>
        </div>
        <div class="oc-dialog__body model-setup-wizard__body">
          <Show when={props.loading}>
            <div role="status">{t("common.loading")}</div>
          </Show>
          <Show when={props.error}>
            <div class="callout danger" role="alert">
              {props.error}
            </div>
          </Show>
          <Show when={!props.loading && !props.error}>
            <Show
              when={current().provider}
              fallback={
                <>
                  <div class="model-provider-login__search">
                    <input
                      class="input"
                      type="search"
                      data-models-login-search
                      autofocus
                      autocomplete="off"
                      aria-label={t("modelProviders.search")}
                      placeholder={t("modelProviders.search")}
                      ref={[
                        (element) => {
                          searchInput = element;
                        },
                        props.controller.setSearchInput.bind(props.controller),
                      ]}
                      value={current().query}
                      onInput={(event) => current().onQuery(event.currentTarget.value)}
                    />
                  </div>
                  <ul
                    class="model-provider-login__providers"
                    aria-label={t("modelSetup.manual.provider")}
                  >
                    <For each={current().matches} keyed={(group) => group.id}>
                      {(group) => (
                        <li>
                          <LoginOption
                            provider={group().id}
                            label={group().label}
                            hint={
                              // A provider with only a key has one way in, so its row stays quiet.
                              group().choices.length
                                ? [
                                    ...group().choices.map((choice) => choice.label),
                                    ...(group().apiKeyProvider
                                      ? [t("modelProviders.status.apiKey")]
                                      : []),
                                  ].join(" · ")
                                : undefined
                            }
                            disabled={current().disabled}
                            onClick={() => current().onProvider(group().id)}
                          />
                        </li>
                      )}
                    </For>
                  </ul>
                  <Show when={!current().matches.length}>
                    <p class="muted" role="status">
                      {t(
                        current().query.trim()
                          ? "modelProviders.noMatches"
                          : "modelProviders.login.noProviders",
                      )}
                    </p>
                  </Show>
                </>
              }
            >
              {(provider) => (
                <>
                  <Show when={current().unavailable}>
                    {(unavailable) => <p role="status">{unavailable().message}</p>}
                  </Show>
                  <Show when={!current().unavailable}>
                    <ProviderAccountSummary
                      cards={current().accounts}
                      recovery={
                        current().recovery
                          ? {
                              authProvider: current().recovery!.authProvider,
                              disabled: current().disabled || !current().canStart,
                              onUse: (profileId) => current().onUseProfile(profileId),
                            }
                          : undefined
                      }
                    />
                  </Show>
                  <section class="model-provider-login__methods">
                    <h3>{t("modelProviders.login.connectAccount")}</h3>
                    <div
                      data-models-login-choice
                      ref={props.controller.setMethodChoices.bind(props.controller)}
                    >
                      <For each={provider().choices} keyed={(choice) => choice.id}>
                        {(selected) => (
                          <LoginOption
                            label={selected().label}
                            hint={selected().hint || undefined}
                            card
                            disabled={current().disabled}
                            onClick={() => current().onChoice(selected())}
                          />
                        )}
                      </For>
                    </div>
                    <Show when={provider().apiKeyProvider}>
                      <LoginOption
                        buttonRef={props.controller.setApiKeyChoice.bind(props.controller)}
                        label={t("modelProviders.status.apiKey")}
                        hint={t("modelProviders.login.apiKeyHint")}
                        apiKey
                        card
                        disabled={current().disabled}
                        onClick={() => current().onApiKey()}
                      />
                    </Show>
                  </section>
                </>
              )}
            </Show>
          </Show>
        </div>
        <Show when={current().provider || current().showDiscover}>
          <openclaw-modal-actions class="oc-dialog__footer model-setup-wizard__footer">
            <Show
              when={current().provider}
              fallback={
                <button
                  class="btn model-provider-login__secondary"
                  data-models-login-discover
                  disabled={current().discoverDisabled}
                  onClick={() => current().onDiscover()}
                >
                  {t("modelProviders.login.discover")}
                </button>
              }
            >
              <button
                class="btn model-provider-login__secondary"
                data-models-login-back
                onClick={() => current().onBack()}
              >
                {t("common.back")}
              </button>
            </Show>
          </openclaw-modal-actions>
        </Show>
      </div>
    </openclaw-modal-dialog>
  );
}

function LoginOption(props: {
  label: string;
  hint?: string;
  provider?: string;
  apiKey?: boolean;
  /** Connection methods are cards; catalog providers are plain rows. */
  card?: boolean;
  disabled: boolean;
  onClick: () => void;
  buttonRef?: (element: HTMLButtonElement) => void;
}) {
  return (
    <button
      ref={props.buttonRef}
      type="button"
      class={["model-provider-login__option", { btn: props.card }]}
      data-models-login-provider={props.provider}
      data-models-login-api-key={props.apiKey ? "" : undefined}
      disabled={props.disabled}
      onClick={() => props.onClick()}
    >
      <Show when={props.provider}>
        {(provider) => <ModelProviderIcon provider={provider()} class="model-providers__icon" />}
      </Show>
      <span class="model-provider-login__copy">
        <strong>{props.label}</strong>
        <Show when={props.hint !== undefined}>
          <span>{props.hint}</span>
        </Show>
      </span>
    </button>
  );
}

export function ModelProviderAccountRecovery(props: { controller: ModelProviderLogin }) {
  const recovery = createMemo(() => props.controller.recoveryView());
  return (
    <Show when={recovery()}>
      {(current) => (
        <div class="callout warning" role="status" data-models-account-recovery>
          <p>{t("modelProviders.login.missingSelection", { model: current().model })}</p>
          <button
            class="btn"
            data-models-recover-account
            disabled={current().disabled}
            onClick={() => current().onChoose()}
          >
            {t("modelProviders.login.chooseAccount")}
          </button>
        </div>
      )}
    </Show>
  );
}
