/* @vitest-environment jsdom */
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  waitForRenderedModalDialog,
  installDialogPolyfill,
} from "../../test-helpers/modal-dialog.ts";
import { LazyElementModal, type LazyElementState } from "./lazy-view-error.tsx";

const view = vi.hoisted(() => {
  let resolve!: () => void;
  const ready = new Promise<void>((done) => {
    resolve = done;
  });
  return { ready, resolve, started: vi.fn() };
});

vi.mock("../modal-dialog.ts", async (importOriginal) => {
  view.started();
  await view.ready;
  return { ...(await importOriginal<typeof import("../modal-dialog.ts")>()) };
});

let restoreDialog: () => void;
beforeEach(() => {
  restoreDialog = installDialogPolyfill();
});
afterEach(async () => {
  view.resolve();
  await vi.dynamicImportSettled();
  cleanup();
  restoreDialog();
});

it("loads only for visible state, permits cancellation while loading, and reopens with current actions", async () => {
  const [state, setState] = createSignal<LazyElementState>();
  const retry = vi.fn();
  const close = vi.fn(() => setState(undefined));
  const screen = render(() => (
    <LazyElementModal
      controller={{
        get visibleState() {
          return state();
        },
        retry,
        close,
      }}
    />
  ));
  flush();
  expect(view.started).not.toHaveBeenCalled();
  expect(screen.container.textContent).toBe("");
  setState({ status: "loading", element: { label: "Workspace panel" } });
  flush();
  expect(screen.getByRole("status")).toBeTruthy();
  expect(screen.container.querySelector("openclaw-modal-dialog")).toBeNull();
  screen.getByRole<HTMLButtonElement>("button", { name: "Close" }).click();
  flush();
  view.resolve();
  await vi.dynamicImportSettled();
  flush();
  expect(screen.container.querySelector("openclaw-modal-dialog")).toBeNull();
  expect(close).toHaveBeenCalledOnce();

  setState({
    status: "error",
    element: { label: "Workspace panel" },
    error: new Error("Network unavailable"),
    stale: false,
  });
  flush();
  const { dialog } = await waitForRenderedModalDialog(screen.container);
  expect(dialog.getAttribute("aria-label")).toBe("Workspace panel");
  expect(screen.getByRole("alert").textContent).toContain("Network unavailable");
  screen.getByRole<HTMLButtonElement>("button", { name: "Retry" }).click();
  expect(retry).toHaveBeenCalledOnce();
  screen.getByRole<HTMLButtonElement>("button", { name: "Close" }).click();
  flush();
  expect(screen.container.querySelector("openclaw-modal-dialog")).toBeNull();
});
