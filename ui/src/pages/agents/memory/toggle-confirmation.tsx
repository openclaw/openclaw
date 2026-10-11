import { createMemo, Show } from "solid-js";
import { registerDreamingEnglish } from "../../../i18n/locales/en-dreaming.ts";
import "../../../components/modal-dialog.ts";
import { t } from "../../../lib/reactive/i18n.ts";

registerDreamingEnglish();

export type DreamingToggleConfirmationProps = {
  open: boolean;
  // Direction of the pending write. Copy differs because turning dreaming off
  // stops the sweep for every agent, not just the one this panel is showing.
  enabling: boolean;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  hasError: boolean;
};

export function renderDreamingToggleConfirmation(props: DreamingToggleConfirmationProps) {
  const titleId = "dreaming-toggle-confirmation-title";
  const descriptionId = "dreaming-toggle-confirmation-description";
  const action = createMemo(() => (props.enabling ? "enable" : "disable"));
  const title = () => t(`dreaming.toggleConfirmation.${action()}Title`);
  const description = () => t("dreaming.toggleConfirmation.subtitle");
  const detail = () => t(`dreaming.toggleConfirmation.${action()}Detail`);
  const confirmLabel = () => t(`dreaming.toggleConfirmation.${action()}Confirm`);
  const handleCancel = () => {
    if (!props.loading) {
      props.onCancel();
    }
  };

  return (
    <Show when={props.open}>
      <openclaw-modal-dialog
        label={title()}
        description={description()}
        onModal-cancel={handleCancel}
      >
        <div class="exec-approval-card">
          <div class="exec-approval-header">
            <div>
              <div id={titleId} class="exec-approval-title">
                {title()}
              </div>
              <div id={descriptionId} class="exec-approval-sub">
                {description()}
              </div>
            </div>
          </div>
          <div
            class={["callout", { info: props.enabling, warn: !props.enabling }]}
            style={{ "margin-top": "12px" }}
          >
            {detail()}
          </div>
          {props.hasError ? (
            <div class="exec-approval-error">{t("dreaming.toggleConfirmation.failed")}</div>
          ) : undefined}
          <div class="exec-approval-actions">
            <button
              class={["btn", { primary: props.enabling, danger: !props.enabling }]}
              disabled={props.loading}
              onClick={() => props.onConfirm()}
            >
              {props.loading ? t("dreaming.toggleConfirmation.saving") : confirmLabel()}
            </button>
            <button class="btn" disabled={props.loading} onClick={() => props.onCancel()}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      </openclaw-modal-dialog>
    </Show>
  );
}
