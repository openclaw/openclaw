import { createEffect } from "solid-js";
import type { ApplicationRuntime } from "./bootstrap.ts";
import {
  ControlUiReadiness,
  type ControlUiCommittedPresentation,
  type ControlUiReadinessOutlet,
} from "./control-ui-readiness.ts";
import { APP_SIDEBAR_ELEMENT } from "./lazy-custom-element.ts";

type CommittedElement = HTMLElement & { readonly updateComplete?: Promise<unknown> };
type SolidReadinessShell = CommittedElement & {
  readiness: ControlUiReadiness | undefined;
  readonly activeSessionKey: string;
  readonly navigationSidebar: CommittedElement & { readonly navigationVisible?: boolean };
};

async function settleShellReadiness(
  shell: SolidReadinessShell,
  readiness: ControlUiReadiness,
): Promise<ControlUiCommittedPresentation> {
  shell.readiness = readiness;
  await shell.updateComplete;
  if (!shell.querySelector(".shell")) {
    return { kind: "loading", navigationVisible: false };
  }
  const sidebar = shell.navigationSidebar;
  const navigationVisible = sidebar.isConnected && sidebar.navigationVisible !== false;
  if (navigationVisible) {
    if (!customElements.get(APP_SIDEBAR_ELEMENT.tagName)) {
      return { kind: "loading", navigationVisible: true };
    }
    await sidebar.updateComplete;
  }
  const outlet = shell.querySelector<ControlUiReadinessOutlet>("openclaw-router-outlet");
  if (!outlet || !(await outlet.settlePresentation())) {
    return { kind: "loading", navigationVisible };
  }
  await shell.querySelector<CommittedElement>("openclaw-chat-page")?.updateComplete;
  return { kind: "shell", navigationVisible, sessionKey: shell.activeSessionKey };
}

/** Loaded on automation's first read; effects observe current facts and commit without a redraw. */
export function createSolidControlUiReadiness(
  root: HTMLElement,
  runtime: ApplicationRuntime,
  trackRoot: () => void,
): ControlUiReadiness {
  const readiness = new ControlUiReadiness(root);
  readiness.connect(runtime, async () => {
    await Promise.resolve();
    let presentation: ControlUiCommittedPresentation;
    if (runtime.documentMode || runtime.focusLocation) {
      presentation = { kind: "standalone", navigationVisible: false };
    } else if (root.querySelector("openclaw-login-gate")) {
      presentation = { kind: "login", navigationVisible: false };
    } else {
      const shell = root.querySelector<SolidReadinessShell>("openclaw-app-shell");
      presentation = shell
        ? await settleShellReadiness(shell, readiness)
        : { kind: "loading", navigationVisible: false };
    }
    const terminal = root.querySelector<CommittedElement & { available?: boolean }>(
      "openclaw-terminal-panel",
    );
    await terminal?.updateComplete;
    return { ...presentation, terminalActivationReady: terminal?.available === true };
  });
  createEffect(
    () => {
      trackRoot();
      readiness.invalidateRoot();
      return {};
    },
    () => readiness.commitRoot(),
  );
  return readiness;
}
