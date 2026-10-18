/* @vitest-environment jsdom */
import { html } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitForRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { withPromiseModalHost } from "./promise-modal-host.ts";

const view = vi.hoisted(() => {
  let resolve!: () => void;
  const ready = new Promise<void>((done) => {
    resolve = done;
  });
  return { ready, resolve, started: vi.fn() };
});

vi.mock("./modal-dialog.ts", async (importOriginal) => {
  view.started();
  await view.ready;
  return { ...(await importOriginal<typeof import("./modal-dialog.ts")>()) };
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
  const content = vi.fn(() => html`<openclaw-modal-dialog label="Aborted modal" />`);
  const cancelled = withPromiseModalHost({ signal: abort.signal, value: "aborted" }, (modal) => {
    modal.render(content);
  });
  expect(content).not.toHaveBeenCalled();
  expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  abort.abort();
  await expect(cancelled).resolves.toBe("aborted");
  expect(document.body.childElementCount).toBe(0);

  const finished = withPromiseModalHost<string>(undefined, ({ render, finish }) => {
    render(
      () => html`<openclaw-modal-dialog label="Current modal">
        <button @click=${() => finish("done")}>Finish</button>
      </openclaw-modal-dialog>`,
    );
  });
  view.resolve();
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
