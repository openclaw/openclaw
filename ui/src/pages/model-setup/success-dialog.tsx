import { Show } from "solid-js";
import {
  hasProviderBrandIcon,
  providerIdFromModelRef,
} from "../../components/provider-icon-data.ts";
import { Icon } from "../../components/solid/icon.tsx";
import "../../components/modal-dialog.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { ModelProviderIcon } from "../../lib/reactive/provider-presentation.tsx";
import type { ModelSetupActivationState } from "./state.ts";
import type { ModelSetupViewProps } from "./view-types.ts";

registerModelSetupEnglish();

type SuccessActivation = Extract<ModelSetupActivationState, { phase: "success" }>;

export function ModelSetupSuccessDialog(
  props: ModelSetupViewProps & { activation: SuccessActivation },
) {
  let openChatButton!: HTMLButtonElement;
  const providerId = () => providerIdFromModelRef(props.activation.modelRef);
  const providerIconId = () =>
    providerId() && hasProviderBrandIcon(providerId()!) ? providerId() : null;
  const utility = () => props.activation.modelTarget === "utility";
  const title = () => t(utility() ? "modelSetup.utility.ready" : "modelSetup.success.title");
  const description = () =>
    props.activation.warning ??
    t(utility() ? "modelSetup.utility.verified" : "modelSetup.success.body", {
      modelRef: props.activation.modelRef,
    });
  const actionLabel = () =>
    utility()
      ? t("modelSetup.utility.openAssistant")
      : props.embedded
        ? t("modelSetup.discovery.returnToModels")
        : props.firstRun
          ? t("modelSetup.success.continueSetup")
          : props.activation.warning
            ? t("tabs.chat")
            : t("modelSetup.success.openChat");
  return (
    <>
      <openclaw-modal-dialog
        prop:initialFocus={() => openChatButton}
        label={title()}
        description={description()}
        onModal-cancel={() => props.onSuccessClose()}
      >
        <section class="oc-dialog model-setup-success" role="status">
          <div class="oc-dialog__header">
            <h2 class="oc-dialog__title">
              <Show when={providerIconId()}>
                {(provider) => <ModelProviderIcon provider={provider()} />}
              </Show>
              {title()}
            </h2>
            <button
              type="button"
              class="oc-dialog__close"
              aria-label={t("common.close")}
              onClick={() => props.onSuccessClose()}
            >
              <Icon name="x" />
            </button>
            <Show when={!props.activation.warning}>
              <div class="oc-dialog__description">
                <p>{description()}</p>
              </div>
            </Show>
          </div>
          <div class="oc-dialog__body">
            <Show when={props.activation.warning}>
              {(warning) => (
                <InlineAlert tone="warning" class="model-setup-success__warning">
                  {warning()}
                </InlineAlert>
              )}
            </Show>
            <div class="oc-dialog__rows model-setup-success__summary">
              <div class="oc-dialog__row">
                <span class="oc-dialog__row-label">
                  {t(utility() ? "modelSetup.utility.model" : "modelSetup.success.activeModel")}
                </span>
                <span class="model-setup-success__model">
                  <span class="statusDot ok" aria-hidden="true" />
                  {props.activation.modelRef}
                </span>
              </div>
              <Show when={props.activation.latencyMs !== undefined}>
                <span class="oc-dialog__row-note">
                  {t("modelSetup.success.latency", {
                    latencyMs: String(props.activation.latencyMs),
                  })}
                </span>
              </Show>
            </div>
          </div>
          <openclaw-modal-actions class="oc-dialog__footer model-setup-success__actions">
            {props.embedded && !utility() ? undefined : (
              <button type="button" class="btn" onClick={() => props.onSuccessClose()}>
                {t("modelSetup.success.stayHere")}
              </button>
            )}
            <button
              ref={(element) => {
                openChatButton = element;
              }}
              type="button"
              class="btn primary"
              autofocus
              onClick={() =>
                (utility() ? (props.onOpenSetupAssistant ?? props.onOpenChat) : props.onOpenChat)()
              }
            >
              {props.embedded && !utility() ? undefined : <Icon name="messageSquare" />}{" "}
              {actionLabel()}
            </button>
          </openclaw-modal-actions>
        </section>
      </openclaw-modal-dialog>
    </>
  );
}
