import { createMemo } from "solid-js";
import {
  hasProviderBrandIcon,
  providerIdFromModelRef,
} from "../../components/provider-icon-data.ts";
import "../../components/modal-dialog.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { ProviderBrandIcon } from "../../components/solid/provider-icon.tsx";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ModelSetupActivationState } from "./state.ts";

registerModelSetupEnglish();

type SuccessActivation = Extract<ModelSetupActivationState, { phase: "success" }>;

export function ModelSetupSuccessDialog(props: {
  activation: SuccessActivation;
  onOpenChat: () => void;
  onClose: () => void;
  firstRun: boolean;
  returnToModels?: boolean;
}) {
  const providerId = createMemo(() => providerIdFromModelRef(props.activation.modelRef));
  const providerIconId = createMemo(() =>
    providerId() && hasProviderBrandIcon(providerId()!) ? providerId() : null,
  );
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
      : props.returnToModels
        ? t("modelSetup.discovery.returnToModels")
        : props.firstRun
          ? t("modelSetup.success.continueSetup")
          : props.activation.warning
            ? t("tabs.chat")
            : t("modelSetup.success.openChat");
  return (
    <>
      <openclaw-modal-dialog
        label={title()}
        description={description()}
        onModal-cancel={() => props.onClose()}
      >
        <section class="model-setup-success" role="status">
          <div
            class={[
              "model-setup-success__icon",
              { "model-setup-success__icon--provider": Boolean(providerIconId()) },
            ]}
            aria-hidden="true"
          >
            {providerIconId() ? (
              <>
                <ProviderBrandIcon
                  provider={providerIconId()!}
                  class="model-setup-success__provider-icon"
                />
                <span class="model-setup-success__status-badge">
                  <Icon name="check" />
                </span>
              </>
            ) : (
              <Icon name="shieldCheck" />
            )}
          </div>
          <div class="model-setup-success__copy">
            <h2>{title()}</h2>
            {props.activation.warning ? undefined : (
              <>
                {" "}
                <p>{description()}</p>{" "}
              </>
            )}
          </div>
          {props.activation.warning ? (
            <div class="model-setup-success__warning">{props.activation.warning}</div>
          ) : undefined}
          <div class="model-setup-success__summary">
            <span>
              {t(utility() ? "modelSetup.utility.model" : "modelSetup.success.activeModel")}
            </span>
            <strong>{props.activation.modelRef}</strong>
            {props.activation.latencyMs === undefined ? undefined : (
              <>
                {" "}
                <span>
                  {t("modelSetup.success.latency", {
                    latencyMs: String(props.activation.latencyMs),
                  })}
                </span>{" "}
              </>
            )}
          </div>
          <footer class="model-setup-success__actions">
            {props.returnToModels && !utility() ? undefined : (
              <>
                {" "}
                <button type="button" class="btn" onClick={() => props.onClose()}>
                  {t("modelSetup.success.stayHere")}
                </button>{" "}
              </>
            )}
            <button type="button" class="btn primary" autofocus onClick={() => props.onOpenChat()}>
              {props.returnToModels && !utility() ? undefined : <Icon name="messageSquare" />}{" "}
              {actionLabel()}
            </button>
          </footer>
        </section>
      </openclaw-modal-dialog>
    </>
  );
}
