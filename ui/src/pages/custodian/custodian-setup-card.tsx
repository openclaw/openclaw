import { createMemo, For, Show } from "solid-js";
import { nativeSetupCapability } from "../../app/native-setup.ts";
import { Icon, type IconName } from "../../components/solid/icon.tsx";
import { WizardStepControls } from "../../components/wizard-step-controls.tsx";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { isLoopbackHostname } from "../../lib/gateway-locality.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import type { CustodianSetupActions } from "./custodian-actions.ts";
import type { CustodianAutoSetup } from "./custodian-auto-setup.ts";
import type { CustodianSessionStore } from "./custodian-session-store.ts";
import "../../styles/custodian-setup-card.css";

function ErrorDetails(props: { text: string }) {
  return (
    <details class="stack">
      <summary>{t("custodian.autoSetup.showDetails")}</summary>
      <pre>{props.text}</pre>
      <button
        class="btn btn--ghost btn--sm"
        type="button"
        onClick={() => void copyToClipboard(props.text)}
      >
        {t("custodian.autoSetup.copyError")}
      </button>
    </details>
  );
}

function SignInWizard(props: { setup: () => CustodianAutoSetup; actions: CustodianSetupActions }) {
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
          <div class="callout warn stack" role="alert">
            <Show when={state().phase === "error"} fallback={message()}>
              <strong>{t("custodian.autoSetup.signInFailedTitle")}</strong>
              <ErrorDetails text={message()} />
            </Show>
          </div>
        )}
      </Show>
      <Show when={step()}>
        {(current) => (
          <div class="stack">
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

export function CustodianSetupCard(props: {
  store: CustodianSessionStore;
  actions: CustodianSetupActions;
}) {
  const context = useApplication();
  const source = createMemo(() => props.store);
  const projection = createMemo(() => projectOwner(source(), (store) => store.autoSetup));
  const setup = () => projection().read();
  const result = () => setup().result;
  const native = context.nativeDeviceSettings
    ? projectOwner(context.nativeDeviceSettings, () => nativeSetupCapability(context)).read
    : () => nativeSetupCapability(context);
  const busy = () => {
    const current = setup();
    return (
      props.actions.verifying ||
      props.actions.answering ||
      current.pending ||
      current.wizard.state.phase === "starting" ||
      current.wizard.state.phase === "step"
    );
  };
  const gatewayHost = () => {
    try {
      return new URL(context.gateway.connection.gatewayUrl).hostname;
    } catch {
      return "";
    }
  };
  const local = () => {
    const kind = native()?.currentGateway?.kind;
    return kind ? kind === "local" : isLoopbackHostname(gatewayHost());
  };
  // A loopback address means nothing to the user; a remote host name does.
  const gatewayLabel = () =>
    native()?.currentGateway?.name || (local() ? undefined : gatewayHost());
  // The other place is another Gateway: the shell's Gateways window, or this page's connection.
  const changeGateway = () => {
    const openGateways = native()?.openGateways;
    if (openGateways) {
      openGateways();
    } else {
      context.navigate("connection");
    }
  };
  const title = () => {
    const current = setup();
    if (props.actions.verifying || current.pending) {
      return t("custodian.autoSetup.connecting");
    }
    if (current.ready) {
      return t("custodian.autoSetup.doneTitle");
    }
    return t(
      current.result?.status === "needs-sign-in"
        ? "custodian.autoSetup.signInTitle"
        : "custodian.autoSetup.unavailableTitle",
    );
  };
  const summary = () => {
    const selected = result()?.selected;
    if (!selected) {
      return undefined;
    }
    const { label, modelRef } = selected;
    const gateway = gatewayLabel();
    return local() || !gateway
      ? t("custodian.autoSetup.usingHere", { label, modelRef })
      : t("custodian.autoSetup.using", { label, modelRef, gateway });
  };
  const failedAttempts = () =>
    !setup().pending && !setup().ready
      ? result()
          ?.attempts.map(({ label, error }) => `${label}: ${error}`)
          .join("\n")
      : undefined;
  function Welcome() {
    return (
      <div class="stack custodian-setup__page">
        <h2>{t("custodian.autoSetup.welcomeTitle")}</h2>
        <p class="muted">{t("custodian.autoSetup.welcomeSubtitle")}</p>
        <p class="muted">{t("custodian.autoSetup.welcomeBody")}</p>
        <div class="callout stack">
          <For
            each={
              [
                ["wandSparkles", "featureAskTitle", "featureAskBody"],
                ["messageSquare", "featureChatTitle", "featureChatBody"],
                ["hand", "featureControlTitle", "featureControlBody"],
              ] as const satisfies readonly (readonly [IconName, string, string])[]
            }
          >
            {(feature) => (
              <div class="row">
                <Icon name={feature[0]} />
                <div class="option-card__choice-copy">
                  <strong>{t(`custodian.autoSetup.${feature[1]}`)}</strong>
                  <span class="option-card__description">
                    {t(`custodian.autoSetup.${feature[2]}`)}
                  </span>
                </div>
              </div>
            )}
          </For>
        </div>
        <p class="muted row">
          <Icon name="info" />
          <span>{t("custodian.autoSetup.safety")}</span>
        </p>
        <footer class="filters custodian-setup__heading">
          <div class="filters">
            <button class="btn btn--ghost" type="button" onClick={changeGateway}>
              {t("custodian.autoSetup.differentGateway")}
            </button>
            <Show when={native()?.reviewPermissions}>
              {(review) => (
                <button class="btn btn--ghost" type="button" onClick={() => review()()}>
                  {t("custodian.autoSetup.reviewPermissions")}
                </button>
              )}
            </Show>
          </div>
          <button class="btn primary" type="button" onClick={() => setup().setStep("ai")}>
            {t("common.next")}
          </button>
        </footer>
      </div>
    );
  }
  return (
    <openclaw-custodian-setup-card>
      <Show when={setup().supported && !setup().dismissed && setup().step !== null}>
        <section class="custodian-setup" aria-label={t("custodian.autoSetup.title")}>
          <Show when={setup().step === "ai"} fallback={<Welcome />}>
            <div class="row custodian-setup__heading">
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
            <Show when={summary()}>{(value) => <p class="muted">{value()}</p>}</Show>
            <Show when={props.actions.verifying || setup().pending}>
              <p class="row custodian-setup__progress" role="status">
                <span class="btn__spinner" aria-hidden="true" />
                {t("custodian.autoSetup.verifying")}
              </p>
            </Show>
            <Show when={!setup().pending && result()?.selected?.shared}>
              <p>{t("custodian.autoSetup.sharedCodexLogin")}</p>
              <Show when={result()?.separateSignIn}>
                <button
                  class="btn"
                  type="button"
                  disabled={busy()}
                  onClick={() => props.actions.signIn()}
                >
                  {t("custodian.autoSetup.separateLogin")}
                </button>
              </Show>
            </Show>
            <Show when={!setup().pending && !setup().ready && result()?.signIn}>
              <Show when={!busy()}>
                <button class="btn primary" type="button" onClick={() => props.actions.signIn()}>
                  {t("custodian.autoSetup.signIn")}
                </button>
              </Show>
            </Show>
            <Show when={failedAttempts()}>{(details) => <ErrorDetails text={details()} />}</Show>
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
              <div class="stack custodian-setup__alternatives">
                <h3>{t("custodian.autoSetup.alternatives")}</h3>
                <div class="filters">
                  <For each={result()?.alternatives}>
                    {(candidate) => (
                      <button
                        class="btn"
                        type="button"
                        title={candidate.detail}
                        disabled={busy()}
                        onClick={() => props.actions.activate(candidate)}
                      >
                        {candidate.label}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>
            <SignInWizard setup={setup} actions={props.actions} />
            <Show when={setup().error}>
              {(error) => (
                <div class="callout warn stack" role="alert">
                  <strong>{t("custodian.autoSetup.failedTitle")}</strong>
                  <ErrorDetails text={error()} />
                  <button
                    class="btn"
                    type="button"
                    disabled={busy()}
                    onClick={() => props.actions.retry()}
                  >
                    {t("common.retry")}
                  </button>
                </div>
              )}
            </Show>
            <Show when={native()?.openGateways || native()?.reviewPermissions}>
              <div class="filters">
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
            <Show when={!setup().ready}>
              <p class="muted">{t("custodian.autoSetup.safety")}</p>
            </Show>
          </Show>
        </section>
      </Show>
    </openclaw-custodian-setup-card>
  );
}
