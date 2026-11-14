/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitForRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { withPromiseModalHost } from "./promise-modal-host.ts";

const view = vi.hoisted(() => {
  const { promise: ready, resolve } = Promise.withResolvers<void>();
  return { ready, resolve, started: vi.fn() };
});

vi.mock("./modal-dialog.tsx", async (importOriginal) => {
  view.started();
  await view.ready;
  return { ...(await importOriginal<typeof import("./modal-dialog.tsx")>()) };
});

let restoreDialog: () => void;
beforeEach(() => {
  restoreDialog = installDialogPolyfill();
});
afterEach(async () => {
  view.resolve();
  await vi.dynamicImportSettled();
  document.body.replaceChildren();
  restoreDialog();
});

it("keeps modal code cold until requested and settles an abort before that code arrives", async () => {
  expect(view.started).not.toHaveBeenCalled();
  const abort = new AbortController();
  const content = vi.fn(() => <openclaw-modal-dialog label="Aborted modal" />);
  const cancelled = withPromiseModalHost({ signal: abort.signal, value: "aborted" }, (modal) => {
    modal.render(content);
  });
  expect(content).not.toHaveBeenCalled();
  expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  abort.abort();
  await expect(cancelled).resolves.toBe("aborted");
  expect(document.body.childElementCount).toBe(0);

  const finished = withPromiseModalHost<string>(undefined, ({ render, finish }) => {
    render(() => (
      <openclaw-modal-dialog label="Current modal">
        <button onClick={() => finish("done")}>Finish</button>
      </openclaw-modal-dialog>
    ));
  });
  const failed = vi.fn();
  void finished.catch(failed);
  view.resolve();
  await vi.dynamicImportSettled();
  expect(failed.mock.calls).toEqual([]);
  const { modal, dialog } = await waitForRenderedModalDialog(document.body);
  expect(view.started).toHaveBeenCalledOnce();
  expect(dialog.getAttribute("aria-label")).toBe("Current modal");
  expect(content).not.toHaveBeenCalled();
  expect(document.querySelectorAll("openclaw-modal-dialog")).toHaveLength(1);
  modal.querySelector("button")?.click();
  await expect(finished).resolves.toBe("done");
  expect(document.body.childElementCount).toBe(0);
});

it("rejects initialization failures and releases the empty host", async () => {
  const result = withPromiseModalHost(undefined, () => {
    throw new Error("Unable to prepare modal");
  });
  await expect(result).rejects.toThrow("Unable to prepare modal");
  expect(document.body.childElementCount).toBe(0);
});

it("retires an aborted preparation before its renderer arrives", async () => {
  const preparation = Promise.withResolvers<void>();
  const controller = new AbortController();
  const content = vi.fn(() => <openclaw-modal-dialog label="Retired preparation" />);
  const result = withPromiseModalHost(
    { signal: controller.signal, value: false },
    async (modal) => {
      await preparation.promise;
      modal.render(content);
    },
  );
  controller.abort();
  await expect(result).resolves.toBe(false);
  expect(document.body.childElementCount).toBe(0);
  preparation.resolve();
  await preparation.promise;
  expect(content).not.toHaveBeenCalled();
});

it("rejects asynchronous preparation failures and releases the empty host", async () => {
  const preparation = Promise.withResolvers<void>();
  const result = withPromiseModalHost(undefined, async () => {
    await preparation.promise;
    throw new Error("Renderer could not load");
  });
  preparation.resolve();
  await expect(result).rejects.toThrow("Renderer could not load");
  expect(document.body.childElementCount).toBe(0);
});
