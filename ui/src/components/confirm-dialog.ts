import { presentConfirmDialog } from "./confirm-dialog-loading.tsx";
import type {
  ConfirmDialogChoice,
  ConfirmDialogChoiceOptions,
  ConfirmDialogOptions,
} from "./confirm-dialog-types.ts";

export type {
  ConfirmDialogChoice,
  ConfirmDialogChoiceOptions,
  ConfirmDialogOptions,
  ConfirmDialogSkipPreference,
} from "./confirm-dialog-types.ts";

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
