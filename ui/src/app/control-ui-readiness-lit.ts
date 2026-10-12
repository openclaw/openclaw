import type { ApplicationRuntime } from "./bootstrap.ts";
import {
  ControlUiReadiness,
  type ControlUiCommittedPresentation,
  type ControlUiReadinessOutlet,
} from "./control-ui-readiness.ts";
import { APP_SIDEBAR_ELEMENT } from "./lazy-custom-element.ts";

type CommittedElement = HTMLElement & {
  readonly updateComplete: Promise<unknown>;
};

type LitReadinessShell = CommittedElement & {
  readiness: ControlUiReadiness | undefined;
  readonly activeSessionKey: string;
  readonly navigationSidebar: HTMLElement & {
    readonly navigationVisible?: boolean;
    readonly updateComplete?: Promise<unknown>;
  };
};

async function settleLitShellReadiness(
  shell: LitReadinessShell,
): Promise<ControlUiCommittedPresentation> {
  await shell.updateComplete;
  if (!shell.querySelector(".shell")) {
    return { kind: "loading", navigationVisible: false };
  }
  // The optional sidebar is not a Lit element until its registration has loaded.
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
  await shell.querySelector<CommittedElement>("openclaw-route-presentation")?.updateComplete;
  await shell.querySelector<CommittedElement>("openclaw-chat-page")?.updateComplete;
  return { kind: "shell", navigationVisible, sessionKey: shell.activeSessionKey };
}

export function createLitControlUiReadiness(
  root: CommittedElement & { readonly hasUpdated: boolean; readonly isUpdatePending: boolean },
  runtime: ApplicationRuntime,
) {
  const readiness = new ControlUiReadiness(root);
  readiness.connect(runtime, async () => {
    await root.updateComplete;
    let presentation: ControlUiCommittedPresentation;
    if (runtime.documentMode || runtime.focusLocation) {
      presentation = { kind: "standalone", navigationVisible: false };
    } else if (root.querySelector("openclaw-login-gate")) {
      presentation = { kind: "login", navigationVisible: false };
    } else {
      const shell = root.querySelector<LitReadinessShell>("openclaw-app-shell");
      presentation = shell
        ? await settleLitShellReadiness(shell)
        : { kind: "loading", navigationVisible: false };
    }
    const terminal = root.querySelector<CommittedElement & { available?: boolean }>(
      "openclaw-terminal-panel",
    );
    await terminal?.updateComplete;
    return {
      ...presentation,
      // The activation shortcut owns lazy registration; waiting for it here would deadlock.
      terminalActivationReady: terminal?.available === true,
    };
  });
  const shell = root.querySelector<LitReadinessShell>("openclaw-app-shell");
  if (shell) {
    shell.readiness = readiness;
  }
  if (root.hasUpdated && !root.isUpdatePending) {
    readiness.commitRoot();
  }
  return readiness;
}
