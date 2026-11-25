/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { installDialogPolyfill } from "../../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { restorePropertyDescriptor } from "../../../test-helpers/property-descriptor.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ContinueInTerminalDialog } from "./continue-in-terminal-dialog.tsx";

it.each(["button", "dismiss"] as const)("closes continuation from %s", (action) => {
  const restoreDialog = installDialogPolyfill();
  const onClose = vi.fn();
  const mounted = mountSolid(() => (
    <ContinueInTerminalDialog command="openclaw resume --handoff fixture" onClose={onClose} />
  ));
  flush();
  try {
    expect(mounted.container.querySelector(".login-gate__command code")?.textContent).toBe(
      "openclaw resume --handoff fixture",
    );
    if (action === "button") {
      mounted.container.querySelector<HTMLButtonElement>(".exec-approval-actions button")!.click();
    } else {
      mounted.container
        .querySelector("openclaw-modal-dialog")!
        .dispatchEvent(new CustomEvent("modal-cancel"));
    }
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    mounted.unmount();
    restoreDialog();
  }
});

it.each(["click", "Enter", " "] as const)(
  "copies the current continuation command using %s",
  async (action) => {
    const restoreDialog = installDialogPolyfill();
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const [command, setCommand] = createSignal("openclaw resume --handoff first");
    const mounted = mountSolid(() => (
      <ContinueInTerminalDialog command={command()} onClose={() => {}} />
    ));
    flush();
    try {
      setCommand("openclaw resume --handoff current");
      flush();
      const commandRow = mounted.container.querySelector<HTMLElement>(".login-gate__command")!;
      if (action === "click") {
        commandRow.click();
      } else {
        commandRow.dispatchEvent(
          new KeyboardEvent("keydown", { key: action, bubbles: true, cancelable: true }),
        );
      }
      await waitForSolid(() =>
        expect(writeText).toHaveBeenCalledExactlyOnceWith("openclaw resume --handoff current"),
      );
    } finally {
      mounted.unmount();
      restoreDialog();
      restorePropertyDescriptor(navigator, "clipboard", clipboard);
    }
  },
);
