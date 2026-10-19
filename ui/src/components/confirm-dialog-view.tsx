import { createSignal, untrack } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import type { ConfirmDialogChoice, ConfirmDialogOptions } from "./confirm-dialog-types.ts";

export function ConfirmDialogView(props: {
  options: ConfirmDialogOptions & { alternativeLabel?: string };
  finish(value: ConfirmDialogChoice): void;
}) {
  // A confirmation keeps the request it opened for until it settles.
  const initialOptions = untrack(() => props.options);
  const title = () => initialOptions.title ?? t("common.confirm");
  let skipRequested = false;
  let cancelButton!: HTMLButtonElement;
  const [acknowledged, setAcknowledged] = createSignal(!initialOptions.requiredAcknowledgement);
  return (
    <openclaw-modal-dialog
      prop:initialFocus={() => cancelButton}
      label={title()}
      description={initialOptions.message}
      onModal-cancel={() => props.finish(null)}
    >
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">{title()}</div>
            <div class="exec-approval-sub" style={{ "white-space": "pre-line" }}>
              {initialOptions.message}
            </div>
          </div>
        </div>
        {initialOptions.details ? (
          <div class="exec-approval-command mono">{initialOptions.details}</div>
        ) : undefined}
        {initialOptions.requiredAcknowledgement ? (
          <label class="field checkbox">
            <input
              type="checkbox"
              checked={acknowledged()}
              onChange={(event) => setAcknowledged(event.currentTarget.checked)}
            />
            <span>{initialOptions.requiredAcknowledgement}</span>
          </label>
        ) : undefined}
        {initialOptions.skipPreference && !initialOptions.requiredAcknowledgement ? (
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
            class={["btn", initialOptions.danger ? "danger" : "primary"]}
            disabled={!acknowledged() || initialOptions.canConfirm?.() === false}
            onClick={() => {
              if (!acknowledged() || initialOptions.canConfirm?.() === false) {
                return;
              }
              if (skipRequested) {
                initialOptions.skipPreference?.remember();
              }
              props.finish("confirm");
            }}
          >
            {initialOptions.confirmLabel ?? t("common.confirm")}
          </button>
          {initialOptions.alternativeLabel ? (
            <button
              type="button"
              class="btn"
              disabled={!acknowledged() || initialOptions.canConfirm?.() === false}
              onClick={() => {
                if (acknowledged() && initialOptions.canConfirm?.() !== false) {
                  props.finish("alternative");
                }
              }}
            >
              {initialOptions.alternativeLabel}
            </button>
          ) : undefined}
          <button
            ref={(element) => {
              cancelButton = element;
            }}
            type="button"
            class="btn"
            autofocus
            onClick={() => props.finish(null)}
          >
            {initialOptions.cancelLabel ?? t("common.cancel")}
          </button>
        </openclaw-modal-actions>
      </div>
    </openclaw-modal-dialog>
  );
}
