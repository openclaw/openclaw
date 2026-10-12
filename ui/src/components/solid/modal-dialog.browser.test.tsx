import { cleanup, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { afterModalHidden } from "../../test-helpers/modal-dialog.ts";
import { ModalDialog, type OpenClawModalDialog } from "../modal-dialog.ts";

function modalDialog(host: OpenClawModalDialog): HTMLDialogElement {
  const dialog = host.querySelector<HTMLDialogElement>(":scope > .oc-modal-dialog");
  if (!dialog) {
    throw new Error("Expected native modal dialog");
  }
  return dialog;
}

afterEach(cleanup);

function mountModal(variant = "", container?: HTMLElement) {
  let handle!: OpenClawModalDialog;
  const view = render(
    () => (
      <ModalDialog
        class={variant}
        label="Edit details"
        ref={(value) => {
          handle = value;
        }}
      >
        <input aria-label="Name" autofocus value="Original name" />
        <textarea aria-label="Notes" />
      </ModalDialog>
    ),
    container ? { container } : undefined,
  );
  flush();
  return {
    view,
    get handle() {
      return handle;
    },
    name: view.getByRole("textbox", { name: "Name" }) as HTMLInputElement,
    notes: view.getByRole("textbox", { name: "Notes" }) as HTMLTextAreaElement,
  };
}

describe("native Solid modal focus and top layer", () => {
  it.each(["", "palette", "drawer"])(
    "preserves selected content and native identity on reopen (%s)",
    async (variant) => {
      const trigger = document.createElement("button");
      document.body.append(trigger);
      trigger.focus();
      const { handle, name, notes } = mountModal(variant);
      const dialog = modalDialog(handle);
      expect(dialog.matches(":modal")).toBe(true);
      expect(document.activeElement).toBe(name);
      notes.focus();
      dialog.focus();
      expect(document.activeElement).toBe(notes);
      await userEvent.keyboard("First draft");
      expect(notes.value).toBe("First draft");
      expect(name.value).toBe("Original name");

      const hidden = afterModalHidden(handle);
      await userEvent.keyboard("{Escape}");
      expect(handle.open).toBe(false);
      expect(dialog.inert).toBe(true);
      await hidden;
      expect(dialog.open).toBe(false);
      expect(document.activeElement).toBe(trigger);
      handle.show();
      expect(modalDialog(handle)).toBe(dialog);
      expect(document.activeElement).toBe(name);
      notes.focus();
      notes.setSelectionRange(notes.value.length, notes.value.length);
      dialog.focus();
      await userEvent.keyboard(" continued");
      expect(notes.value).toBe("First draft continued");
      trigger.remove();
    },
  );

  it("a vetoed Escape keeps native top-layer, focus, and draft ownership", async () => {
    const { handle, notes } = mountModal();
    notes.value = "Unsaved draft";
    notes.focus();
    const veto = (event: Event) => event.preventDefault();
    document.addEventListener("modal-cancel", veto);
    try {
      await userEvent.keyboard("{Escape}");
      expect(modalDialog(handle).matches(":modal")).toBe(true);
      expect(handle.open).toBe(true);
      expect(document.activeElement).toBe(notes);
      expect(notes.value).toBe("Unsaved draft");
    } finally {
      document.removeEventListener("modal-cancel", veto);
    }
    const hidden = afterModalHidden(handle);
    await userEvent.keyboard("{Escape}");
    expect(handle.open).toBe(false);
    expect(modalDialog(handle).inert).toBe(true);
    await hidden;
    expect(modalDialog(handle).open).toBe(false);
  });

  it("nested Escape closes only the newest modal and returns to its parent's field", async () => {
    const outer = mountModal();
    outer.notes.focus();
    const innerContainer = document.createElement("div");
    modalDialog(outer.handle).querySelector(".oc-modal-dialog__body")!.append(innerContainer);
    const inner = mountModal("", innerContainer);
    expect(document.activeElement).toBe(inner.name);
    inner.notes.focus();
    modalDialog(inner.handle).focus();
    await userEvent.keyboard("Nested draft");
    expect(inner.notes.value).toBe("Nested draft");
    expect(outer.notes.value).toBe("");
    const hidden = afterModalHidden(inner.handle);
    await userEvent.keyboard("{Escape}");
    expect(inner.handle.open).toBe(false);
    expect(modalDialog(inner.handle).inert).toBe(true);
    await hidden;
    expect(modalDialog(inner.handle).open).toBe(false);
    expect(modalDialog(outer.handle).matches(":modal")).toBe(true);
    expect(document.activeElement).toBe(outer.notes);
  });

  it("preserves focus when native chrome is focused inside a shadow root", async () => {
    const shadowHost = document.createElement("div");
    document.body.append(shadowHost);
    const shadow = shadowHost.attachShadow({ mode: "open" });
    const container = document.createElement("div");
    shadow.append(container);
    const { handle, name, notes } = mountModal("", container);
    expect(shadow.activeElement).toBe(name);
    notes.focus();
    modalDialog(handle).focus();
    expect(shadow.activeElement).toBe(notes);
    await userEvent.keyboard("Shadow draft");
    expect(notes.value).toBe("Shadow draft");
    shadowHost.remove();
  });

  it.each(["drawer", "viewport-edge-to-edge"])(
    "keeps bottom actions reachable in constrained scroll content (%s)",
    async (variant) => {
      let handle!: OpenClawModalDialog;
      let clicked = false;
      const view = render(() => (
        <ModalDialog
          class={variant}
          label="Scrollable details"
          ref={(value) => {
            handle = value;
          }}
        >
          <section style={{ display: "flex", height: "100%", width: "100%" }}>
            <div style={{ width: "100%", "min-height": "0", overflow: "auto" }}>
              <div style={{ height: "200dvh" }} />
              <button
                onClick={() => {
                  clicked = true;
                }}
              >
                Bottom action
              </button>
            </div>
          </section>
        </ModalDialog>
      ));
      flush();
      const action = view.getByRole("button", { name: "Bottom action" });
      await userEvent.click(action);
      expect(clicked).toBe(true);
      expect(action.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
      expect(modalDialog(handle).clientHeight).toBeLessThanOrEqual(window.innerHeight);
    },
  );
});
