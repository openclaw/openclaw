import type { CDPSession } from "@vitest/browser-playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRenderedModalDialog } from "../test-helpers/modal-dialog.ts";
import "./modal-dialog.ts";
import "./tooltip.ts";

const browserMode = "__vitest_browser__" in globalThis;
let container: HTMLDivElement;

type Modal = HTMLElementTagNameMap["openclaw-modal-dialog"];
type ModalPhase = "opening" | "opened" | "closing" | "closed";
const modalEvents = {
  opening: "wa-show",
  opened: "wa-after-show",
  closing: "wa-hide",
  closed: "wa-after-hide",
} as const;

function useAnimatedModal(modal: Modal) {
  modal.style.setProperty("--wa-transition-normal", "150ms");
}

function modalSurface(modal: Modal) {
  return modal.shadowRoot!.querySelector("wa-dialog")!;
}

function modalDialog(modal: Modal) {
  return modalSurface(modal).shadowRoot!.querySelector("dialog")!;
}

function afterModalPhase(modal: Modal, phase: ModalPhase) {
  return new Promise<void>((resolve) => {
    modalSurface(modal).addEventListener(modalEvents[phase], () => resolve(), { once: true });
  });
}

function motionAtModalPhase(modal: Modal, phase: "opening" | "closing") {
  // Lifecycle dispatch finishes before the continuation inspects native animations.
  return afterModalPhase(modal, phase).then(() =>
    modalDialog(modal)
      .getAnimations({ subtree: true })
      .map((animation) => Number(animation.effect?.getComputedTiming().activeDuration ?? 0))
      .filter((duration) => duration > 0),
  );
}

function finishModalOpening(modal: Modal) {
  modalSurface(modal).dispatchEvent(new CustomEvent(modalEvents.opened, { bubbles: true }));
}

function commitTooltip(tooltip: HTMLElementTagNameMap["openclaw-tooltip"]) {
  return tooltip.updateComplete;
}

function tooltipIsOpen(tooltip: HTMLElementTagNameMap["openclaw-tooltip"]) {
  return tooltip.shadowRoot!.querySelector("wa-tooltip")!.open;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  container.remove();
});

async function mountModal(host = container, variant = "", autofocus = true) {
  const modal = document.createElement("openclaw-modal-dialog");
  modal.label = "Edit details";
  modal.className = variant;
  useAnimatedModal(modal);
  const name = document.createElement("input");
  name.autofocus = autofocus;
  name.value = "Original name";
  name.setAttribute("aria-label", "Name");
  const notes = document.createElement("textarea");
  notes.setAttribute("aria-label", "Notes");
  modal.append(name, notes);
  modal.addEventListener("modal-cancel", (event) => {
    if (event.target === modal) {
      modal.hide();
    }
  });
  host.append(modal);
  const rendered = await getRenderedModalDialog(host);
  await Promise.all(rendered.dialog.getAnimations().map((animation) => animation.finished));
  return { modal, dialog: rendered.dialog, name, notes };
}

describe.runIf(browserMode)("modal native focus ownership", () => {
  it.each(
    [false, true].flatMap((moved) => ["light", "shadow", "slot"].map((tree) => ({ moved, tree }))),
  )(
    "returns focus after background inertness clears without replacing new focus ($tree, moved=$moved)",
    async ({ moved, tree }) => {
      const background = document.createElement("div");
      const trigger = document.createElement("button");
      const nextTarget = document.createElement("button");
      if (tree === "light") {
        background.append(trigger, nextTarget);
        container.append(background);
      } else if (tree === "shadow") {
        background.attachShadow({ mode: "open" }).append(trigger, nextTarget);
        container.append(background);
      } else {
        const host = document.createElement("div");
        host.attachShadow({ mode: "open" }).append(background);
        container.append(host);
        background.append(document.createElement("slot"));
        host.append(trigger, nextTarget);
      }
      trigger.focus();
      const { modal } = await mountModal();
      modal.setReturnFocusTarget(trigger);

      background.inert = true;
      modal.remove();
      expect(trigger.matches(":focus")).toBe(false);
      background.inert = false;
      if (moved) {
        nextTarget.focus();
      }

      await expect.poll(() => (moved ? nextTarget : trigger).matches(":focus")).toBe(true);
    },
  );

  it.each(["inert", "reconnected", "removed"])(
    "drops deferred focus restoration after cancellation (%s)",
    async (state) => {
      const background = document.createElement("div");
      const trigger = document.createElement("button");
      background.append(trigger);
      container.append(background);
      trigger.focus();
      const { modal } = await mountModal();
      let restored = false;
      trigger.addEventListener("openclaw:restore-focus", () => {
        restored = true;
      });

      background.inert = true;
      modal.remove();
      if (state === "reconnected") {
        background.inert = false;
        container.append(modal);
      } else if (state === "removed") {
        background.remove();
      }
      await Promise.resolve();

      expect(restored).toBe(false);
      expect(document.activeElement).not.toBe(trigger);
    },
  );

  it.each(["standard", "drawer"])(
    "honors reduced motion when opening and closing (%s)",
    async (variant) => {
      const { cdp } = await import("vitest/browser");
      const session: CDPSession = cdp();
      await session.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
      try {
        expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
        const modal = document.createElement("openclaw-modal-dialog");
        modal.manual = true;
        modal.className = variant === "drawer" ? "drawer" : "";
        modal.label = "Motion preference";
        useAnimatedModal(modal);
        modal.textContent = "Settings";
        container.append(modal);
        const { dialog } = await getRenderedModalDialog(container);
        expect(dialog.open).toBe(false);
        const opening = motionAtModalPhase(modal, "opening");
        const shown = afterModalPhase(modal, "opened");
        modal.show();
        expect(await opening).toEqual([]);
        await shown;
        expect(dialog.open).toBe(true);

        const closing = motionAtModalPhase(modal, "closing");
        const hidden = afterModalPhase(modal, "closed");
        modal.hide();
        expect(await closing).toEqual([]);
        await hidden;
        expect(dialog.open).toBe(false);
      } finally {
        await session.send("Emulation.setEmulatedMedia", { features: [] });
      }
    },
  );

  it.each(["drawer", "viewport-edge-to-edge"])(
    "keeps the bottom action reachable in scrollable viewport content (%s)",
    async (variant) => {
      const { userEvent } = await import("vitest/browser");
      const { modal } = await mountModal(container, variant, false);
      const content = document.createElement("section");
      content.style.cssText = "display: flex; height: 100%; width: 100%;";
      const scroller = document.createElement("div");
      scroller.style.cssText = "width: 100%; min-height: 0; overflow: auto;";
      const longContent = document.createElement("div");
      longContent.style.height = "200dvh";
      const action = document.createElement("button");
      action.textContent = "Bottom action";
      let clicked = false;
      action.addEventListener("click", () => {
        clicked = true;
      });
      scroller.append(longContent, action);
      content.append(scroller);
      modal.replaceChildren(content);

      await expect.poll(() => scroller.clientHeight).toBeGreaterThan(0);
      expect(scroller.clientHeight).toBeLessThanOrEqual(window.innerHeight);
      expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
      await userEvent.click(action);
      expect(clicked).toBe(true);
      expect(action.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    },
  );

  it("dismisses a tooltip before native modal cancellation and preserves the draft", async () => {
    const { userEvent } = await import("vitest/browser");
    const { modal, dialog, notes } = await mountModal();
    notes.value = "Unsaved draft";
    const tooltip = document.createElement("openclaw-tooltip");
    tooltip.content = "Draft editing help";
    tooltip.anchor = notes;
    modal.append(tooltip);
    await commitTooltip(tooltip);
    notes.focus();
    await commitTooltip(tooltip);
    await expect.poll(() => tooltipIsOpen(tooltip)).toBe(true);

    await userEvent.keyboard("{Escape}");

    await expect.poll(() => tooltipIsOpen(tooltip)).toBe(false);
    expect(dialog.open).toBe(true);
    expect(modal.open).toBe(true);
    expect(notes.value).toBe("Unsaved draft");
    expect(document.activeElement).toBe(notes);

    await userEvent.keyboard("{Escape}");
    await expect.poll(() => dialog.open).toBe(false);
  });

  it.each(["", "palette", "drawer"])(
    "preserves selected content through chrome focus and retained reopen (%s)",
    async (variant) => {
      const { userEvent } = await import("vitest/browser");
      const trigger = document.createElement("button");
      trigger.textContent = "Open editor";
      container.append(trigger);
      trigger.focus();
      const { modal, dialog, name, notes } = await mountModal(container, variant);
      expect(document.activeElement).toBe(name);

      notes.focus();
      // The opening frame calls this real native method. It must not
      // redirect text after the operator has already selected slotted content.
      dialog.focus();
      expect(document.activeElement).toBe(notes);
      await userEvent.keyboard("First draft");
      expect(notes.value).toBe("First draft");
      expect(name.value).toBe("Original name");

      await userEvent.keyboard("{Escape}");
      await expect.poll(() => dialog.open).toBe(false);
      await expect.poll(() => document.activeElement).toBe(trigger);
      expect(modal.isConnected).toBe(true);

      modal.show();
      await expect.poll(() => dialog.open).toBe(true);
      await expect.poll(() => document.activeElement).toBe(name);
      notes.focus();
      dialog.focus();
      expect(document.activeElement).toBe(notes);
      await userEvent.keyboard(" continued");
      expect(notes.value).toBe("First draft continued");
      expect(name.value).toBe("Original name");
      expect(modalDialog(modal)).toBe(dialog);
    },
  );

  it("keeps nested modal focus and dismissal inside the owning layer", async () => {
    const { userEvent } = await import("vitest/browser");
    const outer = await mountModal();
    outer.notes.focus();
    const nestedHost = document.createElement("div");
    outer.modal.append(nestedHost);
    const inner = await mountModal(nestedHost);
    expect(document.activeElement).toBe(inner.name);

    inner.notes.focus();
    inner.dialog.focus();
    expect(document.activeElement).toBe(inner.notes);
    await userEvent.keyboard("Nested draft");
    expect(inner.notes.value).toBe("Nested draft");
    expect(outer.notes.value).toBe("");

    await userEvent.keyboard("{Escape}");
    await expect.poll(() => inner.dialog.open).toBe(false);
    await expect.poll(() => document.activeElement).toBe(outer.notes);
    expect(outer.dialog.open).toBe(true);
    outer.dialog.focus();
    expect(document.activeElement).toBe(outer.notes);
  });

  it("preserves selected content after showing inside a shadow root", async () => {
    const { userEvent } = await import("vitest/browser");
    const shadow = container.attachShadow({ mode: "open" });
    const host = document.createElement("div");
    shadow.append(host);
    const { modal, dialog, name, notes } = await mountModal(host);
    expect(shadow.activeElement).toBe(name);

    notes.focus();
    dialog.focus();
    expect(shadow.activeElement).toBe(notes);
    finishModalOpening(modal);
    expect(shadow.activeElement).toBe(notes);
    await userEvent.keyboard("Shadow draft");
    expect(notes.value).toBe("Shadow draft");
    expect(name.value).toBe("Original name");
  });

  it("leaves native chrome focused when there is no autofocus target or displaced field", async () => {
    const { modal, dialog } = await mountModal(container, "", false);
    expect(dialog.matches(":focus")).toBe(true);
    expect(document.activeElement).toBe(modal);
    expect(dialog.getAttribute("aria-label")).toBe("Edit details");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });
});
