import { createEffect } from "solid-js";
import type { ApplicationRuntime } from "./bootstrap.ts";
import {
  ControlUiReadiness,
  type ControlUiCommittedPresentation,
  type ControlUiReadinessOutlet,
} from "./control-ui-readiness.ts";
import { APP_SIDEBAR_ELEMENT } from "./lazy-custom-element.ts";

type CommittedElement = HTMLElement & { readonly updateComplete?: Promise<unknown> };
export type SolidReadinessShell = {
  readonly element: CommittedElement;
  readonly updateComplete?: Promise<unknown>;
  readiness: ControlUiReadiness | undefined;
  readonly activeSessionKey: string;
  readonly navigationSidebar: CommittedElement & { readonly navigationVisible?: boolean };
  readonly shellElement?: HTMLElement;
  readonly routeOutlet?: ControlUiReadinessOutlet;
  readonly terminalPanel?: CommittedElement & { readonly available?: boolean };
};

async function settleShellReadiness(
  shell: SolidReadinessShell,
  readiness: ControlUiReadiness,
): Promise<ControlUiCommittedPresentation> {
  shell.readiness = readiness;
  await shell.updateComplete;
  if (!shell.shellElement?.isConnected) {
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
  const outlet = shell.routeOutlet;
  if (!outlet || !(await outlet.settlePresentation())) {
    return { kind: "loading", navigationVisible };
  }
  await outlet.renderedElement?.("openclaw-chat-page")?.updateComplete;
  return { kind: "shell", navigationVisible, sessionKey: shell.activeSessionKey };
}

/** Loaded on automation's first read; effects observe current facts and commit without a redraw. */
export function createSolidControlUiReadiness(
  root: HTMLElement,
  runtime: ApplicationRuntime,
  trackRoot: () => void,
  elements: () => {
    login?: HTMLElement;
    shell?: SolidReadinessShell;
    terminal?: CommittedElement & { readonly available?: boolean };
  },
): ControlUiReadiness {
  const readiness = new ControlUiReadiness(root);
  readiness.connect(runtime, async () => {
    await Promise.resolve();
    const { login, shell, terminal } = elements();
    let presentation: ControlUiCommittedPresentation;
    if (runtime.documentMode || runtime.focusLocation) {
      presentation = { kind: "standalone", navigationVisible: false };
    } else if (login?.isConnected) {
      presentation = { kind: "login", navigationVisible: false };
    } else {
      presentation = shell?.element.isConnected
        ? await settleShellReadiness(shell, readiness)
        : { kind: "loading", navigationVisible: false };
    }
    await terminal?.updateComplete;
    return {
      ...presentation,
      terminalActivationReady: terminal?.isConnected === true && terminal.available === true,
    };
  });
  // Publish committed DOM readiness to the external automation hook.
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
