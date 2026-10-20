/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FsListDirResult } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createModalDialogTestFixture,
  getRenderedModalDialog,
} from "../test-helpers/modal-dialog.ts";
import { installPopoverPolyfill } from "../test-helpers/popover.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import {
  type SessionGroupDefaults,
  showSessionGroupDefaultsDialog,
} from "./session-group-defaults-dialog.tsx";

let fixture: ReturnType<typeof createModalDialogTestFixture>;
let restorePopover: () => void;
const defaults = { cwd: "/workspace/project", worktree: false };
const options = {
  group: "Project",
  defaults,
  listDirectory: async () => ({ path: "/workspace", parent: "/", home: "/home/test", entries: [] }),
  inspectRepository: async () => "not_git" as const,
};
function showDialog(
  overrides: Partial<Parameters<typeof showSessionGroupDefaultsDialog>[0]> & {
    submit: Parameters<typeof showSessionGroupDefaultsDialog>[0]["submit"];
  },
) {
  return fixture.track(showSessionGroupDefaultsDialog({ ...options, ...overrides }));
}
function submitForm(modal: ParentNode) {
  modal
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}
function key(target: EventTarget, value: string) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}
const saveButton = (modal: ParentNode) =>
  modal.querySelector<HTMLButtonElement>('button[type="submit"]');
const browserInput = (modal: ParentNode) =>
  modal.querySelector<HTMLInputElement>(".new-session-page__browser-path");
const waitForSave = (modal: ParentNode) =>
  waitForSolid(() => expect(saveButton(modal)?.disabled).toBe(false));
async function openFolderPicker(modal: ParentNode) {
  const trigger = modal.querySelector<HTMLButtonElement>("#session-group-defaults-folder-trigger")!;
  trigger.click();
  await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  return trigger;
}
beforeEach(() => {
  restorePopover = installPopoverPolyfill();
  fixture = createModalDialogTestFixture();
});
afterEach(async () => {
  try {
    await fixture.cleanup();
  } finally {
    restorePopover();
  }
});

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
  const completed = showDialog({
    defaults: { cwd: "/workspace", worktree: false },
    listDirectory,
    inspectRepository,
    submit,
  });
  const { modal } = await getRenderedModalDialog(document.body);
  await openFolderPicker(modal);
  modal.querySelector<HTMLButtonElement>('[data-value="browse"]')!.click();
  await waitForSolid(() => expect(modal.querySelectorAll('[role="option"]')).toHaveLength(2));
  const input = browserInput(modal)!;
  expect(document.activeElement).toBe(input);
  input.value = "/workspace/to";
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await waitForSolid(() => {
    expect(modal.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(modal.querySelector('[role="option"]')?.textContent).toContain("tools");
    expect(document.activeElement).toBe(input);
  });
  key(input, "Tab");
  await waitForSolid(() => expect(input.value).toBe("/workspace/tools"));
  modal.querySelector<HTMLButtonElement>(".new-session-page__browser-use")!.click();
  await waitForSolid(() => {
    expect(inspectRepository).toHaveBeenLastCalledWith("/workspace/tools");
    expect(saveButton(modal)?.disabled).toBe(false);
  });
  submitForm(modal);
  await completed;
  expect(submit).toHaveBeenCalledExactlyOnceWith({ cwd: "/workspace/tools", worktree: false });
  expect(listDirectory).toHaveBeenCalledExactlyOnceWith("/workspace");
  expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
});

it("clears a saved directory when the agent workspace choice closes the popover", async () => {
  const submit = vi.fn(async () => null);
  const completed = showDialog({ submit });
  const { modal } = await getRenderedModalDialog(document.body);
  const trigger = await openFolderPicker(modal);
  const reset = modal.querySelector<HTMLButtonElement>('[data-value="agent-workspace"]')!;
  expect(document.activeElement).toBe(reset);
  reset.click();
  await waitForSolid(() => {
    expect(reset.getAttribute("aria-pressed")).toBe("true");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });
  trigger.click();
  await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  modal.querySelector<HTMLButtonElement>('[data-value="browse"]')!.click();
  await waitForSolid(() => expect(browserInput(modal)).not.toBeNull());
  const input = browserInput(modal)!;
  expect(document.activeElement).toBe(input);
  key(input, "Escape");
  await waitForSolid(() => {
    expect(browserInput(modal)).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(modal.querySelector('[data-value="agent-workspace"]'));
  });
  key(document.activeElement!, "Escape");
  await waitForSolid(() => {
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(document.body.querySelector("openclaw-modal-dialog")).toBe(modal);
  });
  submitForm(modal);
  await completed;
  expect(submit).toHaveBeenCalledExactlyOnceWith({ cwd: "", worktree: false });
});

it("retires a pending save without letting its late completion release a reopened dialog", async () => {
  const owner = new AbortController();
  const { promise: save, resolve: resolveSave } = createDeferred<string | null>();
  const submit = fixture.mockRequest(async () => save);
  const retired = showDialog({ group: "Earlier", signal: owner.signal, submit });
  try {
    const { modal } = await getRenderedModalDialog(document.body);
    await waitForSave(modal);
    submitForm(modal);
    expect(submit).toHaveBeenCalledOnce();
    owner.abort();
    await retired;
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    const freshSubmit = vi.fn(async () => null);
    const fresh = showDialog({ group: "Current", submit: freshSubmit });
    const { modal: current } = await getRenderedModalDialog(document.body);
    resolveSave(null);
    await save;
    await waitForSave(current);
    void showDialog({ group: "Unexpected", submit: freshSubmit });
    expect(document.body.querySelectorAll("openclaw-modal-dialog")).toHaveLength(1);
    expect(current.getAttribute("label")).toContain("Current");
    submitForm(current);
    await fresh;
    expect(freshSubmit).toHaveBeenCalledExactlyOnceWith(options.defaults);
  } finally {
    resolveSave(null);
  }
});

it("gates saving synchronously and lets a failed save retry the restored worktree choice", async () => {
  const { promise: repository, resolve: resolveRepository } = createDeferred<"git">();
  const { promise: pendingSave, resolve: resolveSave } = createDeferred<string | null>();
  const submit = fixture.mockRequest(
    vi
      .fn<(defaults: SessionGroupDefaults) => Promise<string | null>>()
      .mockReturnValueOnce(pendingSave)
      .mockResolvedValue(null),
  );
  const completed = showDialog({
    defaults: { ...defaults, worktree: true },
    inspectRepository: async () => repository,
    submit,
  });
  try {
    const { modal } = await getRenderedModalDialog(document.body);
    const save = saveButton(modal)!;
    submitForm(modal);
    expect(submit).not.toHaveBeenCalled();
    expect(save.disabled).toBe(true);
    resolveRepository("git");
    await waitForSolid(() => {
      expect(save.disabled).toBe(false);
      expect(
        modal.querySelector("#session-group-defaults-mode-trigger")?.getAttribute("data-value"),
      ).toBe("worktree");
    });
    submitForm(modal);
    submitForm(modal);
    const cancel = new Event("modal-cancel", { bubbles: true, cancelable: true });
    modal.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(submit).toHaveBeenCalledExactlyOnceWith({ cwd: "/workspace/project", worktree: true });
    resolveSave("Try saving again");
    await waitForSolid(() => {
      expect(save.disabled).toBe(false);
      expect(modal.querySelector('[role="alert"]')?.textContent).toBe("Try saving again");
    });
    submitForm(modal);
    await completed;
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenLastCalledWith({ cwd: "/workspace/project", worktree: true });
  } finally {
    resolveRepository("git");
    resolveSave(null);
  }
});
