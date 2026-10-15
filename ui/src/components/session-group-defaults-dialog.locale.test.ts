/* @vitest-environment jsdom */
import { expect, it, onTestFinished, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { captureI18nStateForTesting } from "../i18n/lib/translate.test-support.ts";
import {
  createModalDialogTestFixture,
  getRenderedModalDialog,
} from "../test-helpers/modal-dialog.ts";
import { installPopoverPolyfill } from "../test-helpers/popover.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { showSessionGroupDefaultsDialog } from "./session-group-defaults-dialog.tsx";

it("refreshes an open defaults dialog without replacing its focused folder control", async () => {
  const restoreI18n = captureI18nStateForTesting();
  const restorePopover = installPopoverPolyfill();
  const fixture = createModalDialogTestFixture();
  onTestFinished(async () => {
    try {
      await fixture.cleanup();
    } finally {
      restorePopover();
      await restoreI18n();
    }
  });
  await i18n.setLocale("en");
  const submit = vi.fn(async () => null);
  const completed = fixture.track(
    showSessionGroupDefaultsDialog({
      group: "Example",
      defaults: { cwd: "/workspace/example", worktree: false },
      listDirectory: async () => ({ path: "/workspace", home: "/home/example", entries: [] }),
      inspectRepository: async () => "git",
      submit,
    }),
  );
  const { modal } = await getRenderedModalDialog(document.body);
  const folder = modal.querySelector<HTMLButtonElement>("#session-group-defaults-folder-trigger")!;
  const mode = () => modal.querySelector("#session-group-defaults-mode-trigger");
  await waitForSolid(() =>
    expect(mode()?.getAttribute("aria-label")).toBe("Environment: Current checkout"),
  );
  folder.focus();

  await i18n.setLocale("de");
  await waitForSolid(() => {
    expect(modal.querySelector(".exec-approval-title")?.textContent).toBe(
      'Standardeinstellungen für neue Sitzungen in "Example"',
    );
    expect(mode()?.getAttribute("aria-label")).toBe("Umgebung: Aktueller Checkout");
    expect(document.body.querySelector("openclaw-modal-dialog")).toBe(modal);
    expect(document.activeElement).toBe(folder);
  });
  modal
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await completed;
  expect(submit).toHaveBeenCalledExactlyOnceWith({ cwd: "/workspace/example", worktree: false });
});
