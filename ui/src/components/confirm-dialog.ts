import { createComponent } from "solid-js";
import type {
  ConfirmDialogChoice,
  ConfirmDialogChoiceOptions,
  ConfirmDialogOptions,
} from "./confirm-dialog-types.ts";
import { ConfirmDialogView } from "./confirm-dialog-view.tsx";
import { withPromiseModalHost } from "./promise-modal-host.ts";

export type {
  ConfirmDialogChoice,
  ConfirmDialogChoiceOptions,
  ConfirmDialogOptions,
  ConfirmDialogSkipPreference,
} from "./confirm-dialog-types.ts";

let confirmationActive = false;

function presentConfirmDialog(
  options: ConfirmDialogOptions & { alternativeLabel?: string },
): Promise<ConfirmDialogChoice> {
  if (confirmationActive) {
    return Promise.resolve(null);
  }
  confirmationActive = true;
  return withPromiseModalHost<ConfirmDialogChoice>(
    { signal: options.signal, value: null },
    ({ render, finish }) => render(() => createComponent(ConfirmDialogView, { options, finish })),
  ).finally(() => {
    confirmationActive = false;
  });
}

export function showConfirmChoiceDialog(
  options: ConfirmDialogChoiceOptions,
): Promise<ConfirmDialogChoice> {
  return presentConfirmDialog(options);
}

/** Native confirms block reentrancy; reject a second request instead of replaying it later. */
export function showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  // An operator who opted out gets the action itself, not a modal they already
  // answered. Only callers that opted into a skip preference can reach this.
  if (
    options.skipPreference?.skipped &&
    !options.requiredAcknowledgement &&
    options.canConfirm?.() !== false
  ) {
    return Promise.resolve(true);
  }
  return presentConfirmDialog(options).then((result) => result === "confirm");
}
