/* @vitest-environment jsdom */
import { createMemo, createSignal, onSettled } from "solid-js";
import { expect, it, vi } from "vitest";
import type { FsListDirResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { PlaceBrowserState } from "./place-browser-state.ts";
import { PlaceBrowser } from "./place-browser.tsx";

it("keeps the focused folder input and retained rows through a failed refresh and recovery", async () => {
  const workspace: FsListDirResult = {
    path: "/workspace",
    parent: "/",
    home: "/home/test",
    entries: [{ name: "packages", path: "/workspace/packages" }],
  };
  const listDirectory = vi
    .fn<(path?: string) => Promise<FsListDirResult>>()
    .mockResolvedValue(workspace);
  let browser!: PlaceBrowserState;
  let registerProject!: (pending: boolean, error?: string) => void;
  const mounted = mountSolid(() => {
    const [revision, setRevision] = createSignal(0);
    const [registeringProject, setRegisteringProject] = createSignal(false);
    browser = new PlaceBrowserState(listDirectory, () => setRevision((value) => value + 1));
    registerProject = (pending, error) => {
      browser.error = error ?? null;
      if (pending) {
        browser.readCompletion = null;
      }
      setRevision((value) => value + 1);
      setRegisteringProject(pending);
    };
    onSettled(() => () => browser.reset());
    const params = createMemo(() => {
      revision();
      return {
        browser,
        id: "folder-browser-test",
        label: "Folder",
        registerProjectPath: null,
        onBack: vi.fn(),
        onRegisterProject: vi.fn(),
        onClose: vi.fn(),
        onApplyFolder: vi.fn(),
      };
    });
    return <PlaceBrowser params={params()} registeringProject={registeringProject()} />;
  });
  await browser.navigate(workspace.path);
  await waitForSolid(() => expect(mounted.getByRole("option").textContent).toContain("packages"));
  const input = mounted.getByRole("combobox");
  input.focus();
  Object.defineProperty(mounted.getByRole("option"), "scrollIntoView", { value: vi.fn() });

  const refresh = createDeferred<FsListDirResult>();
  listDirectory.mockReturnValueOnce(refresh.promise);
  const navigating = browser.navigate(workspace.path);
  await waitForSolid(() => expect(mounted.getByRole("status").textContent).toContain("Loading"));
  expect(mounted.getByRole("option").textContent).toContain("packages");
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await waitForSolid(() =>
    expect(mounted.getByRole("option").getAttribute("aria-selected")).toBe("true"),
  );
  expect(mounted.getByRole("combobox")).toBe(input);
  expect(document.activeElement).toBe(input);

  refresh.reject(new Error("Unavailable"));
  await navigating;
  await waitForSolid(() =>
    expect(mounted.getByRole("alert").textContent).toContain("Couldn't list that folder."),
  );
  expect(mounted.queryByRole("status")).toBeNull();
  expect(document.activeElement).toBe(input);

  registerProject(true);
  await waitForSolid(() => expect(mounted.queryByRole("alert")).toBeNull());
  expect(mounted.queryByRole("status")).toBeNull();
  expect(document.activeElement).toBe(input);
  const concurrentRead = createDeferred<FsListDirResult>();
  listDirectory.mockReturnValueOnce(concurrentRead.promise);
  const browsingWhileRegistering = browser.navigate(workspace.path);
  await waitForSolid(() => expect(mounted.getByRole("status").textContent).toContain("Loading"));
  concurrentRead.reject(new Error("Unavailable"));
  await browsingWhileRegistering;
  await waitForSolid(() =>
    expect(mounted.getByRole("alert").textContent).toContain("Couldn't list that folder."),
  );
  expect(mounted.queryByRole("status")).toBeNull();
  expect(document.activeElement).toBe(input);
  registerProject(false, "Couldn't register project.");
  await waitForSolid(() =>
    expect(mounted.getByRole("alert").textContent).toBe("Couldn't register project."),
  );

  await browser.navigate(workspace.path);
  await waitForSolid(() => expect(mounted.queryByRole("alert")).toBeNull());
  expect(mounted.queryByRole("status")).toBeNull();
  expect(mounted.getByRole("combobox")).toBe(input);
  expect(document.activeElement).toBe(input);
});
