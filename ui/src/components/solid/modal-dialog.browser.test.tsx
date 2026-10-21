import { cleanup, render } from "@solidjs/testing-library";
import type { JSX } from "@solidjs/web";
import { flush } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../styles.css";
import { afterModalHidden } from "../../test-helpers/modal-dialog.ts";
import { ModalDialog, type OpenClawModalDialog } from "../modal-dialog.ts";
import { LazyViewError } from "./lazy-view-error.tsx";
import { keyFocus } from "./menu-contract.test-support.tsx";

const modalDialog = (host: OpenClawModalDialog) =>
  host.querySelector<HTMLDialogElement>(":scope > .oc-modal-dialog")!;

afterEach(cleanup);

function renderModal(
  label: string,
  content: () => JSX.Element,
  variant = "",
  options?: { container?: HTMLElement; initialFocus?: () => HTMLElement },
) {
  let handle!: OpenClawModalDialog;
  const view = render(
    () => (
      <ModalDialog
        label={label}
        class={variant}
        initialFocus={options?.initialFocus}
        ref={(value) => (handle = value)}
      >
        {content()}
      </ModalDialog>
    ),
    options?.container ? { container: options.container } : undefined,
  );
  flush();
  return { view, handle, dialog: modalDialog(handle) };
}
async function escapeModal(handle: OpenClawModalDialog) {
  const hidden = afterModalHidden(handle);
  await userEvent.keyboard("{Escape}");
  expect(handle.open).toBe(false);
  expect(modalDialog(handle).inert).toBe(true);
  await hidden;
  expect(modalDialog(handle).open).toBe(false);
}

function mountModal(variant = "", container?: HTMLElement) {
  let name!: HTMLInputElement;
  let notes!: HTMLTextAreaElement;
  const { handle } = renderModal(
    "Edit details",
    () => (
      <>
        <input
          aria-label="Name"
          autofocus
          value="Original name"
          ref={(element) => (name = element)}
        />
        <textarea aria-label="Notes" ref={(element) => (notes = element)} />
      </>
    ),
    variant,
    { container, initialFocus: () => name },
  );
  return { handle, name, notes };
}

it.each(["", "palette", "drawer", "shadow"])(
  "preserves drafts and native identity on reopen (%s)",
  async (variant) => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const host =
      variant === "shadow" ? document.body.appendChild(document.createElement("div")) : null;
    const shadow = host?.attachShadow({ mode: "open" });
    const container = shadow?.appendChild(document.createElement("div"));
    const active = () => shadow?.activeElement ?? document.activeElement;
    const { handle, name, notes } = mountModal(variant === "shadow" ? "" : variant, container);
    const dialog = modalDialog(handle);
    expect(dialog.matches(":modal")).toBe(true);
    expect(active()).toBe(name);
    notes.focus();
    dialog.focus();
    expect(active()).toBe(notes);
    await userEvent.keyboard("First draft");
    expect(notes.value).toBe("First draft");
    expect(name.value).toBe("Original name");

    await escapeModal(handle);
    expect(active()).toBe(trigger);
    handle.show();
    expect(modalDialog(handle)).toBe(dialog);
    await expect.poll(active).toBe(name);
    notes.focus();
    notes.setSelectionRange(notes.value.length, notes.value.length);
    dialog.focus();
    await userEvent.keyboard(" continued");
    expect(notes.value).toBe("First draft continued");
    trigger.remove();
    host?.remove();
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
    await keyFocus("{Tab}", name, active);
    await keyFocus("{Shift>}{Tab}{/Shift}", notes, active);
    name.focus();
    await keyFocus("{Tab}", notes, active);

    const preventTab = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        event.preventDefault();
      }
    };
    notes.addEventListener("keydown", preventTab);
    await keyFocus("{Tab}", notes, active);
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

it.each([false, true])("Tabs through descendant shadow roots (only=%s)", async (shadowOnly) => {
  let before!: HTMLInputElement;
  let shadow!: ShadowRoot;
  let first!: HTMLInputElement;
  let slotted!: HTMLInputElement;
  let last!: HTMLInputElement;
  renderModal("Shadow fields", () => (
    <>
      {!shadowOnly && <input aria-label="Before shadow" ref={(value) => (before = value)} />}
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
    </>
  ));
  const order = shadowOnly ? [first, slotted, last] : [before, first, slotted, last];
  const active = () => shadow.activeElement ?? document.activeElement;
  const start = shadowOnly ? first : before;
  start.focus();
  for (const next of [...order.slice(1), start]) {
    await keyFocus("{Tab}", next, active);
  }
  for (const next of [...order.slice(1).toReversed(), start]) {
    await keyFocus("{Shift>}{Tab}{/Shift}", next, active);
  }
});

it("keeps native input navigation inside a button-ended modal", async () => {
  const { handle, name, notes } = mountModal();
  const dialog = modalDialog(handle);
  const body = dialog.querySelector(".oc-modal-dialog__body")!;
  body.prepend(document.createElement("button"));
  body.append(document.createElement("button"));
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
    let target!: HTMLElement;
    const { handle } = renderModal("Native content", () =>
      kind === "summary" ? (
        <details>
          <summary ref={(value) => (target = value)}>Details</summary>
          Content
        </details>
      ) : (
        <div contenteditable="true" ref={(value) => (target = value)}>
          Draft
        </div>
      ),
    );
    target.focus();
    await keyFocus("{Tab}", target);
    await keyFocus("{Shift>}{Tab}{/Shift}", target);
    target.tabIndex = -1;
    modalDialog(handle).focus();
    await keyFocus("{Tab}", modalDialog(handle));
  },
);

it.each([-1, 0, 1])("wraps to the radio group's tab stop (checked: %s)", async (checked) => {
  let text!: HTMLInputElement;
  let first!: HTMLInputElement;
  let second!: HTMLInputElement;
  renderModal("Radio group", () => (
    <>
      <input aria-label="Text" ref={(value) => (text = value)} />
      <input type="radio" name="mode" checked={checked === 0} ref={(value) => (first = value)} />
      <input type="radio" name="mode" checked={checked === 1} ref={(value) => (second = value)} />
    </>
  ));
  const selected = checked === 1 ? second : first;
  text.focus();
  await keyFocus("{Shift>}{Tab}{/Shift}", selected);
  await keyFocus("{Tab}", text);
});

it("keeps an empty modal focused without cycling through its guards", async () => {
  const { dialog } = renderModal("Empty modal", () => null);
  expect(document.activeElement).toBe(dialog);
  await keyFocus("{Tab}", dialog);
  await keyFocus("{Shift>}{Tab}{/Shift}", dialog);
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
  await escapeModal(handle);
});

it("nested Escape closes only the newest modal and returns to its parent's field", async () => {
  const outer = mountModal();
  outer.notes.focus();
  const innerContainer = document.createElement("div");
  modalDialog(outer.handle).querySelector(".oc-modal-dialog__body")!.append(innerContainer);
  const inner = mountModal("", innerContainer);
  expect(document.activeElement).toBe(inner.name);
  inner.notes.focus();
  await keyFocus("{Tab}", inner.name);
  await keyFocus("{Shift>}{Tab}{/Shift}", inner.notes);
  modalDialog(inner.handle).focus();
  await userEvent.keyboard("Nested draft");
  expect(inner.notes.value).toBe("Nested draft");
  expect(outer.notes.value).toBe("");
  await escapeModal(inner.handle);
  expect(modalDialog(outer.handle).matches(":modal")).toBe(true);
  expect(document.activeElement).toBe(outer.notes);
});

it.each(["drawer", "viewport-edge-to-edge"])(
  "reaches bottom actions in constrained %s content",
  async (variant) => {
    let clicked = false;
    const { view, dialog } = renderModal(
      "Scrollable details",
      () => (
        <section style={{ display: "flex", height: "100%", width: "100%" }}>
          <div style={{ width: "100%", "min-height": "0", overflow: "auto" }}>
            <div style={{ height: "200dvh" }} />
            <button onClick={() => (clicked = true)}>Bottom action</button>
          </div>
        </section>
      ),
      variant,
    );
    const action = view.getByRole("button", { name: "Bottom action" });
    await userEvent.click(action);
    expect(clicked).toBe(true);
    expect(action.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(dialog.clientHeight).toBeLessThanOrEqual(window.innerHeight);
  },
);

it("stretches modal error-panel actions", async () => {
  const original = { width: window.innerWidth, height: window.innerHeight };
  let retried = 0;
  const { view, dialog } = renderModal("Load settings", () => (
    <LazyViewError
      error={new Error("Fixture module load failed")}
      subtitle="Settings"
      onRetry={() => retried++}
      onClose={() => {}}
    />
  ));
  await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
  try {
    for (const width of [1440, 320]) {
      await page.viewport(width, 1000);
      const panel = view.container.querySelector<HTMLElement>(".lazy-view-error")!;
      const actions = panel.querySelector<HTMLElement>(".lazy-view-error__actions")!;
      const bounds = panel.getBoundingClientRect();
      const style = getComputedStyle(panel);
      expect(actions.getBoundingClientRect()).toMatchObject({
        left: expect.closeTo(bounds.left + Number.parseFloat(style.paddingLeft), 0),
        right: expect.closeTo(bounds.right - Number.parseFloat(style.paddingRight), 0),
      });
    }
    await userEvent.click(view.getByRole("button", { name: /^Retry$/ }));
    expect(retried).toBe(1);
  } finally {
    await page.viewport(original.width, original.height);
  }
});
