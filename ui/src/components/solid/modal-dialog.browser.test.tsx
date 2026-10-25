import { cleanup, render } from "@solidjs/testing-library";
import type { JSX } from "@solidjs/web";
import { flush } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../styles.css";
import { afterModalHidden } from "../../test-helpers/modal-dialog.ts";
import { ModalDialog, type OpenClawModalDialog } from "../modal-dialog.tsx";
import { LazyViewError } from "./lazy-view-error.tsx";
import { keyFocus } from "./menu-contract.test-support.tsx";

const modalDialog = (host: OpenClawModalDialog) =>
  host.querySelector<HTMLDialogElement>(":scope > .oc-modal-dialog")!;
const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
) => Object.assign(document.createElement(tag), props);

const extraNodes: Element[] = [];
afterEach(() => {
  cleanup();
  extraNodes.splice(0).forEach((node) => node.remove());
});

async function tabCycle(order: HTMLElement[], active?: () => Element | null) {
  order[0]!.focus();
  for (const next of [...order.slice(1), order[0]!]) {
    await keyFocus("{Tab}", next, active);
  }
  for (const next of [...order.slice(1).toReversed(), order[0]!]) {
    await keyFocus("{Shift>}{Tab}{/Shift}", next, active);
  }
}

function renderModal(
  label: string,
  content: () => JSX.Element,
  options?: { container?: HTMLElement; initialFocus?: () => HTMLElement },
) {
  let handle!: OpenClawModalDialog;
  const view = render(
    () => (
      <ModalDialog
        label={label}
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

function mountModal(container?: HTMLElement) {
  const name = element("input", { ariaLabel: "Name", autofocus: true, value: "Original name" });
  const notes = element("textarea", { ariaLabel: "Notes" });
  const { handle } = renderModal("Edit details", () => [name, notes], {
    container,
    initialFocus: () => name,
  });
  return { handle, name, notes };
}

it.each([false, true])("wraps native Tab at modal boundaries (shadow: %s)", async (inShadow) => {
  const trigger = document.createElement("button");
  const container = document.createElement("div");
  document.body.append(trigger, container);
  extraNodes.push(trigger, container);
  const mount = inShadow ? document.createElement("div") : container;
  if (inShadow) {
    container.attachShadow({ mode: "open" }).append(mount);
  }
  trigger.focus();
  const { handle, name, notes } = mountModal(mount);
  const active = () => (inShadow ? container.shadowRoot!.activeElement : document.activeElement);
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
});

it.each([false, true])("Tabs through descendant shadow roots (only=%s)", async (shadowOnly) => {
  const before = element("input", { ariaLabel: "Before shadow" });
  const host = element("div");
  const shadow = host.attachShadow({ mode: "open" });
  const [first, slotted, last] = [element("input"), element("input"), element("input")];
  host.append(slotted);
  shadow.append(first, element("slot"), last);
  renderModal("Shadow fields", () => [!shadowOnly && before, host]);
  const order = shadowOnly ? [first, slotted, last] : [before, first, slotted, last];
  const active = () => shadow.activeElement ?? document.activeElement;
  await tabCycle(order, active);
});

it.each(["summary", "editable"])(
  "wraps native %s content without an explicit tabindex",
  async (kind) => {
    const target =
      kind === "summary"
        ? element("summary", { textContent: "Details" })
        : element("div", { contentEditable: "true", textContent: "Draft" });
    const content = kind === "summary" ? element("details") : target;
    if (kind === "summary") {
      content.append(target, "Content");
    }
    const { handle } = renderModal("Native content", () => content);
    await tabCycle([target]);
    target.tabIndex = -1;
    modalDialog(handle).focus();
    await keyFocus("{Tab}", modalDialog(handle));
  },
);

it.each([-1, 0, 1])("wraps to the radio group's tab stop (checked: %s)", async (checked) => {
  const text = element("input", { ariaLabel: "Text" });
  const radio = (index: number) =>
    element("input", { type: "radio", name: "mode", checked: checked === index });
  const first = radio(0),
    second = radio(1);
  renderModal("Radio group", () => [text, first, second]);
  const selected = checked === 1 ? second : first;
  text.focus();
  await keyFocus("{Shift>}{Tab}{/Shift}", selected);
  await keyFocus("{Tab}", text);
});

it("keeps an empty modal focused without cycling through its guards", async () => {
  const { dialog } = renderModal("Empty modal", () => null);
  expect(document.activeElement).toBe(dialog);
  await tabCycle([dialog]);
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
      expect(dialog.clientHeight).toBeLessThanOrEqual(window.innerHeight);
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
