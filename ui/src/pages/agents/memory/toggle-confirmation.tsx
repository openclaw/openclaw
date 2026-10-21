import { action, createMemo, createOptimistic, Errored, Loading, onSettled, Show } from "solid-js";
import { registerDreamingEnglish } from "../../../i18n/locales/en-dreaming.ts";
import "../../../components/modal-dialog.ts";
import { t } from "../../../lib/reactive/i18n.ts";

registerDreamingEnglish();

export type DreamingToggleConfirmationProps = {
  open: boolean;
  // Direction of the pending write. Copy differs because turning dreaming off
  // stops the sweep for every agent, not just the one this panel is showing.
  enabling: boolean;
  disabled: boolean;
  onConfirm: () => Promise<void> | undefined;
  onCancel: () => void;
  completion?: Promise<void>;
};

export function renderDreamingToggleConfirmation(props: DreamingToggleConfirmationProps) {
  const titleId = "dreaming-toggle-confirmation-title";
  const descriptionId = "dreaming-toggle-confirmation-description";
  const [saving, setSaving] = createOptimistic(false, { equals: false });
  const result = createMemo(() => props.completion?.then(() => null));
  const present = action(function* (completion: Promise<void>) {
    setSaving(true);
    yield completion;
  });
  function confirm() {
    const completion = props.onConfirm();
    if (completion) {
      // Publish synchronous owner admission before starting the action's held frame.
      onSettled(() => {
        // The terminal receipt also supplies the inline error boundary.
        void present(completion).catch(() => undefined);
      });
    }
  }
  const direction = () => (props.enabling ? "enable" : "disable");
  const title = () => t(`dreaming.toggleConfirmation.${direction()}Title`);
  const description = () => t("dreaming.toggleConfirmation.subtitle");
  const detail = () => t(`dreaming.toggleConfirmation.${direction()}Detail`);
  const confirmLabel = () => t(`dreaming.toggleConfirmation.${direction()}Confirm`);
  const handleCancel = () => {
    if (!saving()) {
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
          <Errored
            fallback={() => (
              <div class="exec-approval-error">{t("dreaming.toggleConfirmation.failed")}</div>
            )}
          >
            <Loading>{result()}</Loading>
          </Errored>
          <openclaw-modal-actions class="exec-approval-actions">
            <button
              class={["btn", { primary: props.enabling, danger: !props.enabling }]}
              disabled={props.disabled || saving()}
              onClick={confirm}
            >
              {saving() ? t("dreaming.toggleConfirmation.saving") : confirmLabel()}
            </button>
            <button class="btn" disabled={saving()} onClick={handleCancel}>
              {t("common.cancel")}
            </button>
          </openclaw-modal-actions>
        </div>
      </openclaw-modal-dialog>
    </Show>
  );
}
