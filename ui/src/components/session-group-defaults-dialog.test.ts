/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FsListDirResult } from "../../../packages/gateway-protocol/src/index.js";
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
  const trigger = modal.querySelector<HTMLButtonElement>("#session-group-defaults-folder-trigger")!;
  trigger.click();
  await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  modal.querySelector<HTMLButtonElement>('[data-value="browse"]')!.click();
  await waitForSolid(() => expect(modal.querySelectorAll('[role="option"]')).toHaveLength(2));
  const input = modal.querySelector<HTMLInputElement>(".new-session-page__browser-path")!;
  expect(document.activeElement).toBe(input);
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
  const trigger = modal.querySelector<HTMLButtonElement>("#session-group-defaults-folder-trigger")!;
  trigger.click();
  await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
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
  await waitForSolid(() =>
    expect(modal.querySelector(".new-session-page__browser-path")).not.toBeNull(),
  );
  const input = modal.querySelector<HTMLInputElement>(".new-session-page__browser-path")!;
  expect(document.activeElement).toBe(input);
  const back = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  input.dispatchEvent(back);
  expect(back.defaultPrevented).toBe(true);
  await waitForSolid(() => {
    expect(modal.querySelector(".new-session-page__browser-path")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(modal.querySelector('[data-value="agent-workspace"]'));
  });
  const close = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  document.activeElement!.dispatchEvent(close);
  expect(close.defaultPrevented).toBe(true);
  await waitForSolid(() => {
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(document.body.querySelector("openclaw-modal-dialog")).toBe(modal);
  });
  modal
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await completed;
  expect(submit).toHaveBeenCalledExactlyOnceWith({ cwd: "", worktree: false });
});

it("retires a pending save without letting its late completion release a reopened dialog", async () => {
  const owner = new AbortController();
  let resolveSave!: (value: string | null) => void;
  const save = new Promise<string | null>((resolve) => {
    resolveSave = resolve;
  });
  const options = {
    defaults: { cwd: "/workspace/a", worktree: false },
    listDirectory: async () => ({ path: "/workspace", home: "/home/test", entries: [] }),
    inspectRepository: async () => "not_git" as const,
  };
  const submit = fixture.mockRequest(async () => save);
  const retired = fixture.track(
    showSessionGroupDefaultsDialog({ ...options, group: "Earlier", signal: owner.signal, submit }),
  );
  try {
    const { modal } = await getRenderedModalDialog(document.body);
    await waitForSolid(() =>
      expect(modal.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false),
    );
    modal
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(submit).toHaveBeenCalledOnce();
    owner.abort();
    await retired;
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    const freshSubmit = vi.fn(async () => null);
    const fresh = fixture.track(
      showSessionGroupDefaultsDialog({ ...options, group: "Current", submit: freshSubmit }),
    );
    const { modal: current } = await getRenderedModalDialog(document.body);
    resolveSave(null);
    await save;
    await waitForSolid(() =>
      expect(current.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
        false,
      ),
    );
    void fixture.track(
      showSessionGroupDefaultsDialog({ ...options, group: "Unexpected", submit: freshSubmit }),
    );
    expect(document.body.querySelectorAll("openclaw-modal-dialog")).toHaveLength(1);
    expect(current.getAttribute("label")).toContain("Current");
    current
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await fresh;
    expect(freshSubmit).toHaveBeenCalledExactlyOnceWith(options.defaults);
  } finally {
    resolveSave(null);
  }
});

it("gates saving synchronously and lets a failed save retry the restored worktree choice", async () => {
  let resolveRepository!: (value: "git") => void;
  let resolveSave!: (value: string | null) => void;
  const repository = new Promise<"git">((resolve) => {
    resolveRepository = resolve;
  });
  const pendingSave = new Promise<string | null>((resolve) => {
    resolveSave = resolve;
  });
  const submit = fixture.mockRequest(
    vi
      .fn<(defaults: SessionGroupDefaults) => Promise<string | null>>()
      .mockReturnValueOnce(pendingSave)
      .mockResolvedValue(null),
  );
  const completed = fixture.track(
    showSessionGroupDefaultsDialog({
      group: "Project",
      defaults: { cwd: "/workspace/project", worktree: true },
      listDirectory: async () => ({ path: "/workspace", home: "/home/test", entries: [] }),
      inspectRepository: async () => repository,
      submit,
    }),
  );
  try {
    const { modal } = await getRenderedModalDialog(document.body);
    const form = modal.querySelector("form")!;
    const save = modal.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(submit).not.toHaveBeenCalled();
    expect(save.disabled).toBe(true);
    resolveRepository("git");
    await waitForSolid(() => {
      expect(save.disabled).toBe(false);
      expect(
        modal.querySelector("#session-group-defaults-mode-trigger")?.getAttribute("data-value"),
      ).toBe("worktree");
    });
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const cancel = new Event("modal-cancel", { bubbles: true, cancelable: true });
    modal.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(submit).toHaveBeenCalledExactlyOnceWith({ cwd: "/workspace/project", worktree: true });
    resolveSave("Try saving again");
    await waitForSolid(() => {
      expect(save.disabled).toBe(false);
      expect(modal.querySelector('[role="alert"]')?.textContent).toBe("Try saving again");
    });
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await completed;
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenLastCalledWith({ cwd: "/workspace/project", worktree: true });
  } finally {
    resolveRepository("git");
    resolveSave(null);
  }
});
