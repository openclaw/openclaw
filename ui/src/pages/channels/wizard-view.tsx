import type { JSX } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import { renderChannelIcon } from "../../components/channel-icon.ts";
import {
  renderWizardBusyButton,
  renderWizardStepControls,
} from "../../components/wizard-step-controls.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import "../../components/modal-dialog.ts";
import { channelDocsUrl } from "./hub-meta.ts";
import type { ChannelWizardState } from "./wizard-controller.ts";

type ChannelWizardViewProps = {
  wizard: ChannelWizardState;
  channelLabel: (channelId: string) => string;
  channelIconUrl?: (channelId: string) => string | undefined;
  // Pending multiselect toggles live in page state so re-renders keep them.
  multiselectValues: readonly unknown[];
  onToggleMultiselect: (value: unknown) => void;
  textValue: string;
  secretVisible: boolean;
  onTextInput: (value: string) => void;
  onToggleSecretVisibility: () => void;
  onAnswer: (value: unknown) => void;
  onClose: () => void;
  whatsappQrDataUrl: string | null;
  whatsappMessage: string | null;
  whatsappConnected: boolean | null;
  whatsappBusy: boolean;
  onWhatsAppStart: (force: boolean) => void;
  onWhatsAppWait: () => void;
};

function renderCloseButton(props: ChannelWizardViewProps, labelKey: string, primary = false) {
  return (
    <button type="button" class={primary ? "btn primary" : "btn"} onClick={() => props.onClose()}>
      {t(labelKey)}
    </button>
  );
}

function WizardStepBody(props: {
  wizard: Extract<ChannelWizardState, { phase: "step" }>;
  controls: ChannelWizardViewProps;
}) {
  const informational = createMemo(() =>
    ["note", "progress", "action"].includes(props.wizard.step.type),
  );
  const message = createMemo(() => props.wizard.step.message?.trim() ?? "");
  const gatewayOwned = createMemo(() => props.wizard.step.executor === "gateway");
  const outputClass = createMemo(() =>
    gatewayOwned()
      ? "channels-wizard__message"
      : `channels-wizard__output${message().includes("{") || message().includes("  ") ? " channels-wizard__output--code" : ""}`,
  );
  return (
    <Show
      when={informational()}
      fallback={
        <LitContent
          render={() =>
            renderWizardStepControls({
              step: props.wizard.step,
              value:
                props.wizard.step.type === "multiselect"
                  ? props.controls.multiselectValues
                  : props.wizard.step.type === "text"
                    ? props.controls.textValue
                    : props.wizard.step.initialValue,
              busy: props.wizard.busy,
              inputId: "channel-wizard-text-input",
              validationErrorId: props.wizard.validationError
                ? "channel-wizard-validation-error"
                : undefined,
              presentation: "channels",
              channelSelect: props.wizard.channel === null,
              answerLabel: t("channels.setup.continue"),
              busyLabel: t("channels.setup.working"),
              sensitiveRevealed: props.controls.secretVisible,
              onValueChange:
                props.wizard.step.type === "text"
                  ? (value) => props.controls.onTextInput(typeof value === "string" ? value : "")
                  : props.controls.onToggleMultiselect,
              onAnswer: props.controls.onAnswer,
              onToggleSensitiveVisibility: props.controls.onToggleSecretVisibility,
            })
          }
        />
      }
    >
      {props.wizard.step.title ? (
        <div class="channels-wizard__message">{props.wizard.step.title}</div>
      ) : undefined}
      {message() ? <div class={outputClass()}>{message()}</div> : undefined}
      <div class="channels-wizard__footer">
        {gatewayOwned() ? renderCloseButton(props.controls, "common.cancel") : undefined}
        {gatewayOwned() || props.wizard.busy ? (
          <LitContent
            render={() =>
              renderWizardBusyButton((gatewayOwned() && message()) || t("channels.setup.working"))
            }
          />
        ) : (
          <button type="button" class="btn primary" onClick={() => props.controls.onAnswer(null)}>
            {t("channels.setup.continue")}
          </button>
        )}
      </div>
    </Show>
  );
}

function renderWhatsAppLinking(props: ChannelWizardViewProps) {
  const connected = createMemo(() => props.whatsappConnected === true);
  return (
    <>
      <div class="channels-wizard__message" role="status">
        {connected() ? t("channels.setup.whatsappLinked") : t("channels.setup.whatsappScanTitle")}
      </div>
      {props.whatsappMessage ? (
        <div class="channels-wizard__note" role="status">
          {props.whatsappMessage}
        </div>
      ) : undefined}
      {connected() ? undefined : (
        <>
          <div class="channels-wizard__qr">
            {props.whatsappQrDataUrl ? (
              <img src={props.whatsappQrDataUrl} alt={t("channels.setup.whatsappQrAlt")} />
            ) : props.whatsappBusy ? undefined : (
              <div class="channels-wizard__spinner">{t("channels.setup.whatsappQrHint")}</div>
            )}
          </div>
          <div class="channels-wizard__note">{t("channels.setup.whatsappScanHelp")}</div>
        </>
      )}
      <div class="channels-wizard__footer">
        {connected() ? (
          renderCloseButton(props, "channels.setup.finish", true)
        ) : (
          <>
            {props.whatsappBusy ? (
              <LitContent
                render={() => renderWizardBusyButton(t("channels.setup.whatsappQrLoading"))}
              />
            ) : (
              <>
                <button type="button" class="btn" onClick={() => props.onWhatsAppStart(true)}>
                  {props.whatsappQrDataUrl ? t("channels.setup.regenerateQr") : t("common.showQr")}
                </button>
                {props.whatsappQrDataUrl ? (
                  <button type="button" class="btn primary" onClick={() => props.onWhatsAppWait()}>
                    {t("common.waitForScan")}
                  </button>
                ) : undefined}
              </>
            )}
            {renderCloseButton(props, "channels.setup.linkLater")}
          </>
        )}
      </div>
    </>
  );
}

function renderDoneBody(channels: readonly string[], props: ChannelWizardViewProps) {
  if (channels.includes("whatsapp")) {
    return renderWhatsAppLinking(props);
  }
  const changed = channels.length > 0;
  return (
    <>
      <div class="channels-wizard__message" role="status">
        {t(changed ? "channels.setup.doneTitle" : "channels.setup.doneNoChangesTitle")}
      </div>
      <div class="channels-wizard__note">
        {t(changed ? "channels.setup.doneBody" : "channels.setup.doneNoChangesBody")}
      </div>
      <div class="channels-wizard__footer">
        {renderCloseButton(props, changed ? "channels.setup.finish" : "common.close", true)}
      </div>
    </>
  );
}

export function ChannelWizard(props: ChannelWizardViewProps): JSX.Element {
  const activeWizard = createMemo(() => (props.wizard.phase === "idle" ? undefined : props.wizard));
  return (
    <Show when={activeWizard()}>
      {(wizard) => <WizardDialog wizard={wizard()} controls={props} />}
    </Show>
  );
}

function WizardDialog(props: {
  wizard: Exclude<ChannelWizardState, { phase: "idle" }>;
  controls: ChannelWizardViewProps;
}) {
  const label = createMemo(() =>
    props.wizard.channel
      ? props.controls.channelLabel(props.wizard.channel)
      : t("channels.setup.genericTitle"),
  );
  const step = createMemo(() => (props.wizard.phase === "step" ? props.wizard : undefined));
  const error = createMemo(() => (props.wizard.phase === "error" ? props.wizard : undefined));
  const done = createMemo(() => (props.wizard.phase === "done" ? props.wizard : undefined));
  return (
    <openclaw-modal-dialog
      label={t("channels.setup.dialogLabel", { channel: label() })}
      onModal-cancel={() => props.controls.onClose()}
    >
      <div class="channels-wizard">
        <div class="channels-wizard__header">
          <Show when={props.wizard.channel}>
            {(channel) => (
              <LitContent
                render={() =>
                  renderChannelIcon(channel(), label(), "tile", {
                    pluginIconUrl: props.controls.channelIconUrl?.(channel()),
                  })
                }
              />
            )}
          </Show>
          <div class="channels-wizard__heading">
            <h2>{t("channels.setup.title", { channel: label() })}</h2>
            <div class="muted channels-wizard__subtitle">
              <span>{t("channels.setup.subtitle")}</span>{" "}
              {props.wizard.channel ? (
                <a
                  class="channels-wizard__link"
                  href={channelDocsUrl(props.wizard.channel)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {t("channels.setup.viewDocs")}
                </a>
              ) : undefined}
            </div>
          </div>
        </div>
        <div class="channels-wizard__body">
          <Show when={step()?.step.externalUrl}>
            {(url) => (
              <div class="channels-wizard__links">
                <a
                  class="channels-wizard__link"
                  href={url()}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {t("channels.setup.openLink")}
                </a>
              </div>
            )}
          </Show>
          <Show when={props.wizard.phase === "starting"}>
            <div class="channels-wizard__footer">
              <LitContent render={() => renderWizardBusyButton(t("channels.setup.starting"))} />
            </div>
          </Show>
          <Show when={error()}>
            {(failure) => (
              <>
                <div class="channels-wizard__error" role="alert">
                  {failure().message}
                </div>
                <div class="channels-wizard__footer">
                  {renderCloseButton(props.controls, "common.close")}
                </div>
              </>
            )}
          </Show>
          <Show when={done()}>
            {(completed) => <>{renderDoneBody(completed().channels, props.controls)}</>}
          </Show>
          <Show when={step()}>
            {(current) => (
              <>
                {current().validationError ? (
                  <div
                    id="channel-wizard-validation-error"
                    class="channels-wizard__error"
                    role="alert"
                  >
                    {current().validationError}
                  </div>
                ) : undefined}
                <WizardStepBody wizard={current()} controls={props.controls} />
              </>
            )}
          </Show>
        </div>
      </div>
    </openclaw-modal-dialog>
  );
}
