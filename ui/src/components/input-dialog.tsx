import type { InputDialogOptions } from "./input-dialog-types.ts";
import { renderInputDialog } from "./input-dialog-view.tsx";
import { withPromiseModalHost } from "./promise-modal-host.ts";

export type { InputDialogOptions } from "./input-dialog-types.ts";

let inputActive = false;

/** Native prompts block reentrancy; reject a second request instead of stacking it. */
export function showInputDialog(options: InputDialogOptions): Promise<string | null> {
  if (inputActive) {
    return Promise.resolve(null);
  }
  inputActive = true;
  return withPromiseModalHost<string | null>({ signal: options.signal, value: null }, (modal) =>
    modal.render(() => renderInputDialog(options, modal.finish, () => modal.settled)),
  ).finally(() => {
    inputActive = false;
  });
}
