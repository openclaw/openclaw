import { For, Show } from "solid-js";
import { nativeSetupCapability } from "../../app/native-setup.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { renderWizardStepControls } from "../../components/wizard-step-controls.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge, LitContent, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import { useSolidControllerHost } from "../../lit/solid-controller-host.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import type { CustodianAutoSetup } from "./custodian-auto-setup.ts";
import { custodianSessionStore, type CustodianSessionStore } from "./custodian-session-store.ts";
import "../../styles/custodian-setup-card.css";

function SignInWizard(props: { setup: () => CustodianAutoSetup }) {
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
            <LitContent
              render={() =>
                renderWizardStepControls({
                  step: current().step,
                  value: props.setup().wizardValue,
                  busy: current().busy,
                  externalAuthInput: current().externalAuthInput,
                  inputId: "custodian-setup-sign-in",
                  validationErrorId: current().validationError
                    ? "custodian-setup-validation"
                    : undefined,
                  sensitiveRevealed: props.setup().wizardSecretVisible,
                  onValueChange: (value) => props.setup().setWizardValue(value),
                  onAnswer: (value) => void props.setup().answerWizard(value),
                  onToggleSensitiveVisibility: () => props.setup().toggleWizardSecretVisibility(),
                })
              }
            />
            <button
              class="btn btn--ghost"
              type="button"
              onClick={() => void props.setup().cancelWizard()}
            >
              {t("custodian.cancel")}
            </button>
          </div>
        )}
      </Show>
    </>
  );
}

type Props = { store: CustodianSessionStore };
type SetupCardElement = SolidBridgeElement<Props>;

defineSolidBridge<Props>(
  "openclaw-custodian-setup-card",
  (props) => {
    const context = useApplication();
    const { host, revision } = useSolidControllerHost(() => props.store);
    new SubscriptionsController(host)
      .watchStore(() => props.store)
      .watchStore(() => context.nativeDeviceSettings);
    const setup = () => {
      revision();
      return props.store.autoSetup;
    };
    const result = () => setup().result;
    const native = () => {
      revision();
      return nativeSetupCapability(context);
    };
    const busy = () => {
      const current = setup();
      return (
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
      if (current.pending) {
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
      <Show when={setup().supported && !setup().dismissed}>
        <section class="custodian-setup" aria-label={t("custodian.autoSetup.title")}>
          <div class="custodian-setup__heading">
            <h2>{title()}</h2>
            <button
              class="custodian__nudge-dismiss"
              type="button"
              aria-label={t("common.dismiss")}
              onClick={() => setup().dismiss()}
            >
              <Icon name="x" />
            </button>
          </div>
          <Show when={setup().pending}>
            <p class="custodian-setup__progress" role="status">
              <span class="btn__spinner" aria-hidden="true" />
              {t("custodian.autoSetup.verifying")}
            </p>
          </Show>
          <Show when={!setup().pending && result()?.status === "needs-sign-in"}>
            <p>{t("custodian.autoSetup.signInBody")}</p>
            <Show when={!busy()}>
              <button class="btn primary" type="button" onClick={() => void setup().signIn()}>
                {t("custodian.autoSetup.signIn")}
              </button>
            </Show>
          </Show>
          <Show when={!setup().pending && result()?.status === "unavailable"}>
            <p>{t("custodian.autoSetup.unavailableBody")}</p>
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
                      onClick={() => void setup().activate(candidate)}
                    >
                      {candidate.label}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
          <SignInWizard setup={setup} />
          <Show when={setup().error}>
            {(error) => (
              <div class="custodian-setup__error" role="alert">
                <p>{error()}</p>
                <button
                  class="btn"
                  type="button"
                  disabled={busy()}
                  onClick={() => void setup().retry()}
                >
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
    );
  },
  { properties: { store: { default: custodianSessionStore, attribute: false } } },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-custodian-setup-card": SetupCardElement;
  }
}
