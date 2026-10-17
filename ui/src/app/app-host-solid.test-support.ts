import { render } from "@solidjs/testing-library";
import { createComponent, createEffect, createRoot, flush, onSettled } from "solid-js";
import { onTestFinished } from "vitest";
import { ShellOwner } from "./app-host.tsx";
import { ApplicationShell } from "./app-shell-view.tsx";

export function createShellOwner(): ShellOwner {
  const { shell, dispose } = createRoot((disposeRoot) => ({
    shell: new ShellOwner(document.createElement("openclaw-app-shell")),
    dispose: disposeRoot,
  }));
  onTestFinished(() => {
    shell.disconnect();
    dispose();
  });
  return shell;
}

export function mountShellView(shell: ShellOwner) {
  const view = render(
    () => {
      createEffect(
        () => shell.shellRevision(),
        () => shell.afterCommit(),
      );
      return createComponent(ApplicationShell, { host: shell });
    },
    { container: shell.element },
  );
  onTestFinished(() => view.unmount());
  return view;
}

export function refreshShellView(shell: ShellOwner): void {
  shell.invalidate();
  flush();
}

export async function settleShell(shell: ShellOwner): Promise<void> {
  flush();
  await new Promise<void>((resolve) => {
    onSettled(resolve);
  });
  await shell.updateComplete;
}
