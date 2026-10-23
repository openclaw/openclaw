import { createSignal, For, untrack } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { createPendingFocus } from "../lib/reactive/pending-focus.ts";
import { createMediaQuery } from "../lib/reactive/platform.ts";
import type {
  ConfirmDialogChoice,
  ConfirmDialogChoiceOptions,
  ConfirmDialogOptions,
} from "./confirm-dialog-types.ts";

export type ConfirmDialogViewOptions = ConfirmDialogOptions & Partial<ConfirmDialogChoiceOptions>;

export function ConfirmDialogView(props: {
  options: ConfirmDialogViewOptions;
  finish(value: ConfirmDialogChoice): void;
}) {
  // A confirmation keeps the request it opened for until it settles.
  const initialOptions = untrack(() => props.options);
  const title = () => initialOptions.title ?? t("common.confirm");
  let skipRequested = false;
  let cancelButton!: HTMLButtonElement;
  let actions!: HTMLElement;
  const [acknowledged, setAcknowledged] = createSignal(!initialOptions.requiredAcknowledgement);
  const mobileChoices = initialOptions.groupChoicesOnMobile
    ? createMediaQuery("(max-width: 640px)")
    : () => false;
  if (initialOptions.groupChoicesOnMobile) {
    createPendingFocus(
      () => ({ mobile: mobileChoices(), focused: actions?.ownerDocument.activeElement }),
      {
        requested: (next, previous) => previous !== undefined && next.mobile !== previous.mobile,
        focus: ({ focused }) => {
          if (!(focused instanceof HTMLElement) || !actions.contains(focused)) {
            return;
          }
          // Keyed DOM moves can blur the retained control; never replace newer user focus.
          queueMicrotask(() => {
            const doc = focused.ownerDocument;
            if (
              focused.isConnected &&
              (doc.activeElement === doc.body || doc.activeElement === doc.documentElement)
            ) {
              focused.focus({ preventScroll: true });
            }
          });
        },
      },
    );
  }
  const cancelAction = (
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
  );
  const choiceActions = (
    <>
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
    </>
  );

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
        <openclaw-modal-actions
          ref={(element) => {
            actions = element;
          }}
          class={["exec-approval-actions", { "confirm-dialog-actions--stacked": mobileChoices() }]}
        >
          {initialOptions.groupChoicesOnMobile ? (
            <For each={mobileChoices() ? ["choices", "cancel"] : ["cancel", "choices"]}>
              {(kind) =>
                kind === "cancel" ? (
                  cancelAction
                ) : (
                  <div class="confirm-dialog-choice-actions">{choiceActions}</div>
                )
              }
            </For>
          ) : (
            <>
              {cancelAction}
              {choiceActions}
            </>
          )}
        </openclaw-modal-actions>
      </div>
    </openclaw-modal-dialog>
  );
}
