import { cleanup, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../styles.css";
import { afterModalHidden } from "../../test-helpers/modal-dialog.ts";
import { ModalDialog, type OpenClawModalDialog } from "../modal-dialog.ts";
import { LazyViewError } from "./lazy-view-error.tsx";

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
      await expect.element(name).toHaveFocus();
      notes.focus();
      notes.setSelectionRange(notes.value.length, notes.value.length);
      dialog.focus();
      await userEvent.keyboard(" continued");
      expect(notes.value).toBe("First draft continued");
      trigger.remove();
    },
  );

  it.each([false, true])("wraps native Tab at modal boundaries (shadow: %s)", async (inShadow) => {
    const trigger = document.createElement("button");
    const container = document.createElement("div");
    document.body.append(trigger, container);
    const mount = inShadow ? document.createElement("div") : container;
    if (inShadow) {
      container.attachShadow({ mode: "open" }).append(mount);
    }
    trigger.focus();
    const { handle, name, notes } = mountModal("", mount);
    const active = () => (inShadow ? container.shadowRoot!.activeElement : document.activeElement);
    try {
      notes.focus();
      await userEvent.keyboard("{Tab}");
      expect(active()).toBe(name);
      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
      expect(active()).toBe(notes);
      name.focus();
      await userEvent.keyboard("{Tab}");
      expect(active()).toBe(notes);

      const preventTab = (event: KeyboardEvent) => {
        if (event.key === "Tab") {
          event.preventDefault();
        }
      };
      notes.addEventListener("keydown", preventTab);
      await userEvent.keyboard("{Tab}");
      expect(active()).toBe(notes);
      notes.removeEventListener("keydown", preventTab);

      const hidden = afterModalHidden(handle);
      handle.hide();
      await hidden;
      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
      container.remove();
    }
  });

  it.each([false, true])(
    "keeps native Tab order through descendant shadow roots (only: %s)",
    async (shadowOnly) => {
      let before!: HTMLInputElement;
      let shadow!: ShadowRoot;
      let first!: HTMLInputElement;
      let slotted!: HTMLInputElement;
      let last!: HTMLInputElement;
      render(() => (
        <ModalDialog label="Shadow fields">
          {!shadowOnly && (
            <input
              aria-label="Before shadow"
              ref={(value) => {
                before = value;
              }}
            />
          )}
          <div
            ref={(host) => {
              shadow = host.attachShadow({ mode: "open" });
              first = document.createElement("input");
              last = document.createElement("input");
              slotted = document.createElement("input");
              host.append(slotted);
              shadow.append(first, document.createElement("slot"), last);
            }}
          />
        </ModalDialog>
      ));
      flush();
      const order = shadowOnly ? [first, slotted, last] : [before, first, slotted, last];
      const active = () => shadow.activeElement ?? document.activeElement;
      const start = shadowOnly ? first : before;
      start.focus();
      for (const next of [...order.slice(1), start]) {
        await userEvent.keyboard("{Tab}");
        expect(active()).toBe(next);
      }
      for (const next of [...order.slice(1).toReversed(), start]) {
        await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
        expect(active()).toBe(next);
      }
    },
  );

  it("keeps native input navigation inside a button-ended modal", async () => {
    const { handle, name, notes } = mountModal();
    const dialog = modalDialog(handle);
    const body = dialog.querySelector(".oc-modal-dialog__body")!;
    const first = document.createElement("button");
    first.textContent = "First action";
    const last = document.createElement("button");
    last.textContent = "Last action";
    body.prepend(first);
    body.append(last);
    notes.focus();
    await userEvent.keyboard("{Tab}");
    expect(dialog.contains(document.activeElement)).toBe(true);
    name.focus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it.each(["summary", "editable"])(
    "wraps native %s content without an explicit tabindex",
    async (kind) => {
      let handle!: OpenClawModalDialog;
      let target!: HTMLElement;
      render(() => (
        <ModalDialog
          label="Native content"
          ref={(value) => {
            handle = value;
          }}
        >
          {kind === "summary" ? (
            <details>
              <summary
                ref={(value) => {
                  target = value;
                }}
              >
                Details
              </summary>
              Content
            </details>
          ) : (
            <div
              contenteditable="true"
              ref={(value) => {
                target = value;
              }}
            >
              Draft
            </div>
          )}
        </ModalDialog>
      ));
      flush();
      target.focus();
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(target);
      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
      expect(document.activeElement).toBe(target);
      target.tabIndex = -1;
      modalDialog(handle).focus();
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(modalDialog(handle));
    },
  );

  it.each([-1, 0, 1])("wraps to the radio group's tab stop (checked: %s)", async (checked) => {
    let text!: HTMLInputElement;
    let first!: HTMLInputElement;
    let second!: HTMLInputElement;
    render(() => (
      <ModalDialog label="Radio group">
        <input
          aria-label="Text"
          ref={(value) => {
            text = value;
          }}
        />
        <input
          type="radio"
          name="mode"
          checked={checked === 0}
          ref={(value) => {
            first = value;
          }}
        />
        <input
          type="radio"
          name="mode"
          checked={checked === 1}
          ref={(value) => {
            second = value;
          }}
        />
      </ModalDialog>
    ));
    flush();
    const selected = checked === 1 ? second : first;
    text.focus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(selected);
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(text);
  });

  it("keeps an empty modal focused without cycling through its guards", async () => {
    let handle!: OpenClawModalDialog;
    render(() => (
      <ModalDialog
        label="Empty modal"
        ref={(value) => {
          handle = value;
        }}
      />
    ));
    flush();
    const dialog = modalDialog(handle);
    expect(document.activeElement).toBe(dialog);
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(dialog);
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(dialog);
  });

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
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(inner.name);
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(inner.notes);
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

it("stretches centered error-panel completion actions inside native modals", async () => {
  const original = { width: window.innerWidth, height: window.innerHeight };
  let retried = 0;
  let handle!: OpenClawModalDialog;
  const view = render(() => (
    <ModalDialog
      label="Load settings"
      ref={(value) => {
        handle = value;
      }}
    >
      <LazyViewError
        error={new Error("Fixture module load failed")}
        subtitle="Settings"
        onRetry={() => {
          retried++;
        }}
        onClose={() => {}}
      />
    </ModalDialog>
  ));
  flush();
  const dialog = modalDialog(handle);
  await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
  try {
    for (const width of [1440, 320]) {
      await page.viewport(width, 1000);
      const panel = view.container.querySelector<HTMLElement>(".lazy-view-error")!;
      const actions = panel.querySelector<HTMLElement>(".lazy-view-error__actions")!;
      const bounds = panel.getBoundingClientRect();
      const style = getComputedStyle(panel);
      expect(actions.getBoundingClientRect().left).toBeCloseTo(
        bounds.left + Number.parseFloat(style.paddingLeft),
        0,
      );
      expect(actions.getBoundingClientRect().right).toBeCloseTo(
        bounds.right - Number.parseFloat(style.paddingRight),
        0,
      );
    }
    await userEvent.click(view.getByRole("button", { name: /^Retry$/ }));
    expect(retried).toBe(1);
  } finally {
    await page.viewport(original.width, original.height);
  }
});
