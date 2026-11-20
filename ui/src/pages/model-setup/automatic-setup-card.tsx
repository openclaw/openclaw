import { For, Show } from "solid-js";
import { nativeSetupCapability } from "../../app/native-setup.ts";
import { IconButton } from "../../components/solid/icon-button.tsx";
import { WizardStepControls } from "../../components/wizard-step-controls.tsx";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import type { AutomaticModelSetup } from "./automatic-setup.ts";
import { openFirstAgentConversation } from "./first-agent-handoff.ts";
import "../../styles/custodian-setup-card.css";

registerPluginManagementEnglish();

type AutomaticSetupActions = {
  readonly answering: boolean;
  readonly cancelling: boolean;
  readonly verifying: boolean;
  signIn(): void;
  retry(): void;
  answer(value: unknown): void;
  cancel(): void;
  activate(candidate: NonNullable<AutomaticModelSetup["result"]>["alternatives"][number]): void;
};

function SignInWizard(props: { setup: () => AutomaticModelSetup; actions: AutomaticSetupActions }) {
  const state = () => props.setup().wizard.state;
  const step = () => {
    const current = state();
    return current.phase === "step" ? current : undefined;
  };
  const error = () => {
    const current = state();
    return current.phase === "error" || current.phase === "cancelled" ? current.message : null;
  };
  return (
    <>
      <Show when={state().phase === "starting"}>
        <p role="status">{t("custodian.autoSetup.startingSignIn")}</p>
      </Show>
      <Show when={error()}>
        {(message) => (
          <p class="custodian-setup__error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={step()}>
        {(current) => (
          <div class="custodian-setup__wizard">
            <Show when={current().step.title}>
              {(title) => <h3>{formatUiExternalText(title())}</h3>}
            </Show>
            <Show when={current().validationError}>
              {(message) => (
                <p id="custodian-setup-validation" class="custodian-setup__error" role="alert">
                  {message()}
                </p>
              )}
            </Show>
            <WizardStepControls
              step={current().step}
              value={props.setup().wizardValue}
              busy={props.actions.answering || current().busy}
              externalAuthInput={current().externalAuthInput}
              inputId="custodian-setup-sign-in"
              validationErrorId={
                current().validationError ? "custodian-setup-validation" : undefined
              }
              sensitiveRevealed={props.setup().wizardSecretVisible}
              onValueChange={(value) => props.setup().setWizardValue(value)}
              onAnswer={(value) => props.actions.answer(value)}
              onToggleSensitiveVisibility={() => props.setup().toggleWizardSecretVisibility()}
            />
            <button
              class="btn btn--ghost"
              type="button"
              disabled={props.actions.cancelling}
              onClick={() => props.actions.cancel()}
            >
              {t("custodian.cancel")}
            </button>
          </div>
        )}
      </Show>
    </>
  );
}

export function AutomaticSetupCard(props: { owner: AutomaticModelSetup; revision: () => number }) {
  const context = useApplication();
  const setup = () => {
    props.revision();
    return props.owner;
  };
  const run = (command: (owner: AutomaticModelSetup) => Promise<void>) => {
    const owner = props.owner;
    void command(owner).catch((error: unknown) => owner.reportError(error));
  };
  const actions: AutomaticSetupActions = {
    get verifying() {
      return setup().pending;
    },
    get answering() {
      const state = setup().wizard.state;
      return state.phase === "starting" || (state.phase === "step" && state.busy);
    },
    get cancelling() {
      return setup().cancelling;
    },
    retry: () => run((owner) => owner.retry()),
    signIn: () => run((owner) => owner.signIn()),
    answer: (value) => run((owner) => owner.answerWizard(value)),
    cancel: () => run((owner) => owner.cancelWizard()),
    activate: (candidate) => run((owner) => owner.activate(candidate)),
  };
  const result = () => setup().result;
  const native = context.nativeDeviceSettings
    ? projectOwner(context.nativeDeviceSettings, () => nativeSetupCapability(context)).read
    : () => nativeSetupCapability(context);
  const busy = () => {
    const current = setup();
    return (
      actions.verifying ||
      actions.answering ||
      current.pending ||
      current.wizard.state.phase === "starting" ||
      current.wizard.state.phase === "step"
    );
  };
  const gatewayLabel = () => {
    const gateway = native()?.currentGateway;
    if (gateway) {
      return gateway.name;
    }
    try {
      return new URL(context.gateway.connection.gatewayUrl).hostname;
    } catch {
      return t("custodian.autoSetup.thisGateway");
    }
  };
  const title = () => {
    const current = setup();
    if (actions.verifying || current.pending) {
      return t("custodian.autoSetup.connecting");
    }
    const selected = current.result?.selected;
    if (selected) {
      return t("custodian.autoSetup.using", {
        label: selected.label,
        modelRef: selected.modelRef,
        gateway: gatewayLabel(),
      });
    }
    return t(
      current.result?.status === "needs-sign-in"
        ? "custodian.autoSetup.signInTitle"
        : "custodian.autoSetup.unavailableTitle",
    );
  };
  return (
    <openclaw-custodian-setup-card>
      <Show when={setup().supported && !setup().dismissed}>
        <section class="custodian-setup" aria-label={t("custodian.autoSetup.title")}>
          <div class="custodian-setup__heading">
            <h2>{title()}</h2>
            <IconButton
              size={28}
              icon="x"
              class="custodian__nudge-dismiss"
              label={t("common.dismiss")}
              onClick={() => setup().dismiss()}
            />
          </div>
          <Show when={actions.verifying || setup().pending}>
            <p class="custodian-setup__progress" role="status">
              <span class="btn__spinner" aria-hidden="true" />
              {t("custodian.autoSetup.verifying")}
            </p>
          </Show>
          <Show when={!setup().pending && result()?.selected?.shared}>
            <p>{t("custodian.autoSetup.sharedCodexLogin")}</p>
            <Show when={result()?.separateSignIn}>
              <button class="btn" type="button" disabled={busy()} onClick={() => actions.signIn()}>
                {t("custodian.autoSetup.separateLogin")}
              </button>
            </Show>
          </Show>
          <Show when={!setup().pending && !setup().ready && result()?.signIn}>
            <Show when={!busy()}>
              <button class="btn primary" type="button" onClick={() => actions.signIn()}>
                {t("custodian.autoSetup.signIn")}
              </button>
            </Show>
          </Show>
          <Show when={!setup().pending && !setup().ready}>
            <Show when={result()?.attempts.length}>
              <ul class="custodian-setup__attempts">
                <For each={result()?.attempts}>
                  {(attempt) => (
                    <li>
                      <strong>{attempt.label}:</strong> {attempt.error}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
          <Show when={!setup().pending && result()?.status === "unavailable"}>
            <p>{t("custodian.autoSetup.unavailableBody")}</p>
            <Show
              when={native()?.openAiSetup}
              fallback={
                <p>
                  {t("custodian.autoSetup.commandHint")} <code>openclaw onboard</code>
                </p>
              }
            >
              <button class="btn" type="button" onClick={() => native()?.openAiSetup?.()}>
                {t("custodian.autoSetup.nativeSetup")}
              </button>
            </Show>
          </Show>
          <Show when={result()?.alternatives.length}>
            <div class="custodian-setup__alternatives">
              <h3>{t("custodian.autoSetup.alternatives")}</h3>
              <div class="custodian-setup__actions">
                <For each={result()?.alternatives}>
                  {(candidate) => (
                    <button
                      class="btn"
                      type="button"
                      title={candidate.detail}
                      disabled={busy()}
                      onClick={() => actions.activate(candidate)}
                    >
                      {candidate.label}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
          <SignInWizard setup={setup} actions={actions} />
          <Show when={result()?.firstAgent}>
            {(agent) => (
              <button
                class="btn primary"
                type="button"
                disabled={busy()}
                onClick={() => openFirstAgentConversation(context, agent())}
              >
                {t("modelSetup.startTalking")}
              </button>
            )}
          </Show>
          <Show when={setup().error}>
            {(error) => (
              <div class="custodian-setup__error" role="alert">
                <p>{error()}</p>
                <button class="btn" type="button" disabled={busy()} onClick={() => actions.retry()}>
                  {t("common.retry")}
                </button>
              </div>
            )}
          </Show>
          <Show when={native()?.openGateways || native()?.reviewPermissions}>
            <div class="custodian-setup__actions custodian-setup__native-actions">
              <Show when={native()?.openGateways}>
                <button
                  class="btn btn--ghost"
                  type="button"
                  onClick={() => native()?.openGateways?.()}
                >
                  {t("custodian.autoSetup.differentGateway")}
                </button>
              </Show>
              <Show when={native()?.reviewPermissions}>
                <button
                  class="btn btn--ghost"
                  type="button"
                  onClick={() => native()?.reviewPermissions?.()}
                >
                  {t("custodian.autoSetup.reviewPermissions")}
                </button>
              </Show>
            </div>
          </Show>
          <p class="custodian-setup__safety">{t("custodian.autoSetup.safety")}</p>
        </section>
      </Show>
    </openclaw-custodian-setup-card>
  );
}
