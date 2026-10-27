import { render } from "@solidjs/testing-library";
import { createComponent, createRoot, flush, onSettled } from "solid-js";
import { onTestFinished } from "vitest";
import { ShellOwner } from "./app-host.tsx";
import type { ShellChromeOwner } from "./app-shell-chrome.ts";
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

export function connectShellEvents(shell: object): void {
  // SAFETY: ShellOwner fixtures retain the real private event owner, without its runtime subscriptions.
  const { shellChrome } = shell as { shellChrome: ShellChromeOwner };
  shellChrome.connect();
  onTestFinished(() => shellChrome.disconnect());
}

export function createConnectedShellOwner(): ShellOwner {
  const shell = createShellOwner();
  connectShellEvents(shell);
  return shell;
}

export function mountShellView(shell: ShellOwner) {
  const view = render(
    () => {
      onSettled(() => shell.mountPresentation());
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
