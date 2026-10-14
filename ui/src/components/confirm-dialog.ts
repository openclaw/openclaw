import { createComponent } from "solid-js";
import type { ConfirmDialogOptions } from "./confirm-dialog-types.ts";
import { ConfirmDialogView } from "./confirm-dialog-view.tsx";
import { withPromiseModalHost } from "./promise-modal-host.ts";

export type { ConfirmDialogOptions, ConfirmDialogSkipPreference } from "./confirm-dialog-types.ts";

let confirmationActive = false;

function presentConfirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return withPromiseModalHost<boolean>(
    { signal: options.signal, value: false },
    ({ render, finish }) => render(() => createComponent(ConfirmDialogView, { options, finish })),
  );
}

/** Native confirms block reentrancy; reject a second request instead of replaying it later. */
export function showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  // An operator who opted out gets the action itself, not a modal they already
  // answered. Only callers that opted into a skip preference can reach this.
  if (options.skipPreference?.skipped && !options.requiredAcknowledgement) {
    return Promise.resolve(true);
  }
  if (confirmationActive) {
    return Promise.resolve(false);
  }
  confirmationActive = true;
  return presentConfirmDialog(options).finally(() => {
    confirmationActive = false;
  });
}
