/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FsListDirResult } from "../../../packages/gateway-protocol/src/index.js";
import {
  createModalDialogTestFixture,
  getRenderedModalDialog,
} from "../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { showSessionGroupDefaultsDialog } from "./session-group-defaults-dialog.ts";

let fixture: ReturnType<typeof createModalDialogTestFixture>;
beforeEach(() => {
  fixture = createModalDialogTestFixture();
});
afterEach(() => fixture.cleanup());

it("keeps folder input focus while filtering and saves the keyboard-completed folder", async () => {
  const listing: FsListDirResult = {
    path: "/workspace",
    parent: "/",
    home: "/home/test",
    entries: [
      { name: "packages", path: "/workspace/packages" },
      { name: "tools", path: "/workspace/tools" },
    ],
  };
  const listDirectory = vi
    .fn<(path?: string) => Promise<FsListDirResult>>()
    .mockResolvedValue(listing);
  const inspectRepository = vi.fn(async () => "not_git" as const);
  const submit = vi.fn(async () => null);
  const completed = fixture.track(
    showSessionGroupDefaultsDialog({
      group: "Project",
      defaults: { cwd: "/workspace", worktree: false },
      listDirectory,
      inspectRepository,
      submit,
    }),
  );
  const { modal } = await getRenderedModalDialog(document.body);
  modal.querySelector<HTMLButtonElement>('[data-value="browse"]')!.click();
  await waitForSolid(() => expect(modal.querySelectorAll('[role="option"]')).toHaveLength(2));
  const input = modal.querySelector<HTMLInputElement>(".new-session-page__browser-path")!;
  input.focus();
  input.value = "/workspace/to";
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await waitForSolid(() => {
    expect(modal.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(modal.querySelector('[role="option"]')?.textContent).toContain("tools");
    expect(document.activeElement).toBe(input);
  });
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  input.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(true);
  await waitForSolid(() => expect(input.value).toBe("/workspace/tools"));
  modal.querySelector<HTMLButtonElement>(".new-session-page__browser-use")!.click();
  await waitForSolid(() => {
    expect(inspectRepository).toHaveBeenLastCalledWith("/workspace/tools");
    expect(modal.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  });
  modal
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await completed;
  expect(submit).toHaveBeenCalledExactlyOnceWith({ cwd: "/workspace/tools", worktree: false });
  expect(listDirectory).toHaveBeenCalledExactlyOnceWith("/workspace");
  expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
});

it("clears a saved directory when the agent workspace choice closes the popover", async () => {
  const submit = vi.fn(async () => null);
  const completed = fixture.track(
    showSessionGroupDefaultsDialog({
      group: "Project",
      defaults: { cwd: "/workspace/project", worktree: false },
      listDirectory: async () => ({
        path: "/workspace",
        parent: "/",
        home: "/home/test",
        entries: [],
      }),
      inspectRepository: async () => "not_git",
      submit,
    }),
  );
  const { modal } = await getRenderedModalDialog(document.body);
  modal.querySelector<HTMLButtonElement>("#session-group-defaults-folder-trigger")!.click();
  const reset = modal.querySelector<HTMLButtonElement>('[data-value="agent-workspace"]')!;
  reset.click();
  await waitForSolid(() => expect(reset.getAttribute("aria-pressed")).toBe("true"));
  modal
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await completed;
  expect(submit).toHaveBeenCalledExactlyOnceWith({ cwd: "", worktree: false });
});
