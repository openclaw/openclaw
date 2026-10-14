import { render as renderSolid, type JSX } from "@solidjs/web";
import { createComponent } from "solid-js";
import type { InputDialogOptions } from "./input-dialog-types.ts";
import { InputDialogView } from "./input-dialog-view.tsx";
import { withPromiseModalHost } from "./promise-modal-host.ts";

export type { InputDialogOptions } from "./input-dialog-types.ts";

let inputActive = false;

function presentInputDialog(options: InputDialogOptions): Promise<string | null> {
  return withPromiseModalHost<string | null, JSX.Element>(
    { signal: options.signal, value: null },
    (modal) =>
      modal.render(() =>
        createComponent(InputDialogView, {
          options,
          finish: modal.finish,
          settled: () => modal.settled,
        }),
      ),
    (content, host) => renderSolid(content, host),
  );
}

/** Native prompts block reentrancy; reject a second request instead of stacking it. */
export function showInputDialog(options: InputDialogOptions): Promise<string | null> {
  if (inputActive) {
    return Promise.resolve(null);
  }
  inputActive = true;
  return presentInputDialog(options).finally(() => {
    inputActive = false;
  });
}
