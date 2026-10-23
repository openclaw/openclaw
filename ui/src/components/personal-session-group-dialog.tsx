import { lazy } from "solid-js";
import type { PersonalSessionGroupDialogOptions } from "./personal-session-group-dialog-view.tsx";
import { withPromiseModalHost } from "./promise-modal-host.ts";

const PersonalSessionGroupDialogView = lazy(
  () => import("./personal-session-group-dialog-view.tsx"),
  {
    export: "PersonalSessionGroupDialogView",
  },
);
let active = false;

export function showPersonalSessionGroupDialog(
  options: PersonalSessionGroupDialogOptions,
): Promise<void> {
  if (active) {
    return Promise.resolve();
  }
  active = true;
  return withPromiseModalHost<void>(
    { signal: options.signal, value: undefined },
    async ({ render, finish }) => {
      await PersonalSessionGroupDialogView.preload();
      render(() => <PersonalSessionGroupDialogView options={options} finish={finish} />);
    },
  ).finally(() => {
    active = false;
  });
}
