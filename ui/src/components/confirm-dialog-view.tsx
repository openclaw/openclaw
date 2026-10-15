import { createSignal, untrack } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import type { ConfirmDialogOptions } from "./confirm-dialog-types.ts";

export function ConfirmDialogView(props: {
  options: ConfirmDialogOptions;
  finish(value: boolean): void;
}) {
  const options = untrack(() => props.options);
  const title = () => options.title ?? t("common.confirm");
  let skipRequested = false;
  const [acknowledged, setAcknowledged] = createSignal(!options.requiredAcknowledgement);
  return (
    <openclaw-modal-dialog
      label={title()}
      description={options.message}
      onModal-cancel={() => props.finish(false)}
    >
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">{title()}</div>
            <div class="exec-approval-sub" style={{ "white-space": "pre-line" }}>
              {options.message}
            </div>
          </div>
        </div>
        {options.details ? (
          <div class="exec-approval-command mono">{options.details}</div>
        ) : undefined}
        {options.requiredAcknowledgement ? (
          <label class="field checkbox">
            <input
              type="checkbox"
              checked={acknowledged()}
              onChange={(event) => setAcknowledged(event.currentTarget.checked)}
            />
            <span>{options.requiredAcknowledgement}</span>
          </label>
        ) : undefined}
        {options.skipPreference && !options.requiredAcknowledgement ? (
          <label class="field checkbox exec-approval-skip">
            <input
              type="checkbox"
              onChange={(event) => {
                skipRequested = event.currentTarget.checked;
              }}
            />
            <span>{t("common.dontAskAgain")}</span>
          </label>
        ) : undefined}
        <openclaw-modal-actions class="exec-approval-actions">
          <button
            type="button"
            class={["btn", options.danger ? "danger" : "primary"]}
            disabled={!acknowledged()}
            onClick={() => {
              if (!acknowledged()) {
                return;
              }
              if (skipRequested) {
                options.skipPreference?.remember();
              }
              props.finish(true);
            }}
          >
            {options.confirmLabel ?? t("common.confirm")}
          </button>
          <button type="button" class="btn" autofocus onClick={() => props.finish(false)}>
            {options.cancelLabel ?? t("common.cancel")}
          </button>
        </openclaw-modal-actions>
      </div>
    </openclaw-modal-dialog>
  );
}
