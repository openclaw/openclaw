import { render } from "@solidjs/testing-library";
import { createEffect, flush, onSettled } from "solid-js";
import { onTestFinished } from "vitest";
import { ShellOwner } from "./app-host.tsx";
import { renderApplicationShell } from "./app-shell-view.tsx";

export function createShellOwner(): ShellOwner {
  const shell = new ShellOwner(document.createElement("openclaw-app-shell"));
  onTestFinished(() => shell.disconnect());
  return shell;
}

export function mountShellView(shell: ShellOwner) {
  const view = render(
    () => {
      createEffect(
        () => shell.shellRevision(),
        () => shell.afterCommit(),
      );
      return renderApplicationShell(shell);
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
