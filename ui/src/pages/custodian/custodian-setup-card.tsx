import { createMemo, For, Show } from "solid-js";
import { nativeSetupCapability } from "../../app/native-setup.ts";
import {
  providerDisplayLabel,
  providerIdFromModelRef,
} from "../../components/provider-icon-data.ts";
import { Icon, type IconName } from "../../components/solid/icon.tsx";
import { isLoopbackHostname } from "../../lib/gateway-locality.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import type { CustodianSetupActions } from "./custodian-actions.ts";
import type { SetupStep } from "./custodian-auto-setup.ts";
import type { CustodianSessionStore } from "./custodian-session-store.ts";
import { ChoiceRow, ConnectAi, WizardSteps } from "./custodian-setup-ai.tsx";
import { setupPicker } from "./custodian-setup-picker.ts";

const STEPS: SetupStep[] = ["welcome", "where", "ai"];

export function CustodianSetupCard(props: {
  store: CustodianSessionStore;
  actions: CustodianSetupActions;
}) {
  const context = useApplication();
  const source = createMemo(() => props.store);
  const projection = createMemo(() => projectOwner(source(), (store) => store.autoSetup));
  const setup = () => projection().read();
  const native = context.nativeDeviceSettings
    ? projectOwner(context.nativeDeviceSettings, () => nativeSetupCapability(context)).read
    : () => nativeSetupCapability(context);
  const busy = () => {
    const current = setup();
    return (
      props.actions.verifying ||
      props.actions.answering ||
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
  const summary = () => {
    const current = setup();
    const connection = current.connection;
    const modelRef = connection?.modelRef ?? current.detection?.configuredModel;
    if (!modelRef) {
      return undefined;
    }
    const label =
      connection?.label ?? providerDisplayLabel(providerIdFromModelRef(modelRef) ?? modelRef);
    const gateway = gatewayLabel();
    return local() || !gateway
      ? t("custodian.autoSetup.usingHere", { label, modelRef })
      : t("custodian.autoSetup.using", { label, modelRef, gateway });
  };
  const separateSignIn = () =>
    setup().connection?.shared && setup().detection
      ? setupPicker(setup().detection!).chatgptSignIn
      : undefined;
  const stepIndex = () => STEPS.indexOf(setup().step);
  const go = (step: SetupStep) => setup().setStep(step);
  return (
    <openclaw-custodian-setup-card>
      <Show when={setup().supported && !setup().dismissed}>
        <section class="custodian-setup" aria-label={t("custodian.autoSetup.title")}>
          <button
            class="custodian__nudge-dismiss custodian-setup__dismiss"
            type="button"
            aria-label={t("common.dismiss")}
            onClick={() => setup().dismiss()}
          >
            <Icon name="x" />
          </button>
          <Show
            when={!setup().ready}
            fallback={
              <header class="custodian-setup__page">
                <span class="custodian-setup__row">
                  <Icon name="circleCheck" />
                </span>
                <h2>{t("custodian.autoSetup.doneTitle")}</h2>
                <Show when={summary()}>{(text) => <p class="muted">{text()}</p>}</Show>
                <Show when={setup().connection?.shared}>
                  <p class="muted">{t("custodian.autoSetup.sharedCodexLogin")}</p>
                  <Show when={separateSignIn()}>
                    {(option) => (
                      <button
                        class="btn"
                        type="button"
                        disabled={busy()}
                        onClick={() =>
                          props.actions.signIn(option(), t("custodian.autoSetup.chatgpt"))
                        }
                      >
                        {t("custodian.autoSetup.separateLogin")}
                      </button>
                    )}
                  </Show>
                </Show>
                <div class="custodian-setup__stack">
                  <WizardSteps setup={setup} actions={props.actions} />
                </div>
              </header>
            }
          >
            <div class="custodian-setup__page">
              <Show when={setup().step === "welcome"}>
                <h2>{t("custodian.autoSetup.welcomeTitle")}</h2>
                <p class="muted">{t("custodian.autoSetup.welcomeSubtitle")}</p>
                <p class="muted">{t("custodian.autoSetup.welcomeBody")}</p>
                <div class="callout custodian-setup__stack">
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
                      <div class="custodian-setup__row">
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
                <p class="muted custodian-setup__row">
                  <Icon name="info" />
                  <span>{t("custodian.autoSetup.safety")}</span>
                </p>
              </Show>
              <Show when={setup().step === "where"}>
                <h2>{t("custodian.autoSetup.whereTitle")}</h2>
                <p class="muted">{t("custodian.autoSetup.whereBody")}</p>
                <div class="callout custodian-setup__stack">
                  <ChoiceRow
                    icon={<Icon name="monitor" />}
                    title={
                      <>
                        {t("custodian.autoSetup.whereLocal")}{" "}
                        <span class="chip custodian-setup__badge">
                          {t("custodian.autoSetup.recommended")}
                        </span>
                      </>
                    }
                    detail={(local() && gatewayLabel()) || t("custodian.autoSetup.whereLocalBody")}
                    selected={local()}
                    trailing={local() ? <Icon name="circleCheck" /> : undefined}
                    onClick={() => !local() && changeGateway()}
                  />
                  <ChoiceRow
                    icon={<Icon name="server" />}
                    title={t("custodian.autoSetup.whereRemote")}
                    detail={
                      (!local() && gatewayLabel()) || t("custodian.autoSetup.whereRemoteBody")
                    }
                    selected={!local()}
                    trailing={!local() ? <Icon name="circleCheck" /> : undefined}
                    onClick={() => local() && changeGateway()}
                  />
                </div>
              </Show>
              <Show when={setup().step === "ai"}>
                <ConnectAi
                  setup={setup}
                  actions={props.actions}
                  busy={busy}
                  local={local}
                  native={() => native() != null}
                />
              </Show>
            </div>
            <footer class="custodian-setup__footer">
              <div class="custodian-setup__row">
                <Show when={stepIndex() > 0}>
                  <button
                    class="btn btn--ghost"
                    type="button"
                    disabled={busy()}
                    onClick={() => go(STEPS[stepIndex() - 1]!)}
                  >
                    {t("custodian.autoSetup.back")}
                  </button>
                </Show>
                <Show when={native()?.reviewPermissions}>
                  {(review) => (
                    <button class="btn btn--ghost" type="button" onClick={() => review()()}>
                      {t("custodian.autoSetup.reviewPermissions")}
                    </button>
                  )}
                </Show>
              </div>
              <ol
                class="custodian-setup__dots"
                aria-label={t("custodian.autoSetup.stepLabel", {
                  current: String(stepIndex() + 1),
                  total: String(STEPS.length),
                })}
              >
                <For each={STEPS}>
                  {(_step, index) => (
                    <li
                      class={{ "is-current": index() === stepIndex() }}
                      aria-current={index() === stepIndex() ? "step" : undefined}
                    />
                  )}
                </For>
              </ol>
              <div style={{ "justify-self": "end" }}>
                <Show when={stepIndex() < STEPS.length - 1}>
                  <button
                    class="btn primary"
                    type="button"
                    onClick={() => go(STEPS[stepIndex() + 1]!)}
                  >
                    {t("custodian.autoSetup.next")}
                  </button>
                </Show>
              </div>
            </footer>
          </Show>
        </section>
      </Show>
    </openclaw-custodian-setup-card>
  );
}
