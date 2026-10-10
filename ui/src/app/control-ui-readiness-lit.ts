import type { LitElement } from "lit";
import type { ApplicationRuntime } from "./bootstrap.ts";
import {
  ControlUiReadiness,
  type ControlUiCommittedPresentation,
  type ControlUiReadinessShell,
} from "./control-ui-readiness.ts";

export function createLitControlUiReadiness(root: LitElement, runtime: ApplicationRuntime) {
  const readiness = new ControlUiReadiness(root);
  readiness.connect(runtime, async () => {
    await root.updateComplete;
    let presentation: ControlUiCommittedPresentation;
    if (runtime.documentMode || runtime.focusLocation) {
      presentation = { kind: "standalone", navigationVisible: false };
    } else if (root.querySelector("openclaw-login-gate")) {
      presentation = { kind: "login", navigationVisible: false };
    } else {
      const shell = root.querySelector<ControlUiReadinessShell>("openclaw-app-shell");
      presentation = shell
        ? await shell.settleReadiness()
        : { kind: "loading", navigationVisible: false };
    }
    const terminal = root.querySelector<LitElement & { available?: boolean }>(
      "openclaw-terminal-panel",
    );
    await terminal?.updateComplete;
    return {
      ...presentation,
      // The activation shortcut owns lazy registration; waiting for it here would deadlock.
      terminalActivationReady: terminal?.available === true,
    };
  });
  return readiness;
}
