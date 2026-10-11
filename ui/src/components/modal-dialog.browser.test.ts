import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeNativeOverlayOcclusion } from "../lib/native-overlay-occlusion.ts";
import { getRenderedModalDialog } from "../test-helpers/modal-dialog.ts";
import { emulateOverlayMedia } from "../test-helpers/overlay-browser-media.ts";
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

function modalSurface(modal: Modal) {
  return modal;
}

function modalDialog(modal: Modal) {
  return modal.querySelector<HTMLDialogElement>(":scope > .oc-modal-dialog")!;
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
  return tooltip
    .shadowRoot!.querySelector<HTMLElement>(".tooltip-surface")!
    .matches(":popover-open");
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  container.remove();
});

async function mountModal(
  host = container,
  variant = "",
  autofocus = true,
  fieldDocument = host.ownerDocument,
) {
  const modal = document.createElement("openclaw-modal-dialog");
  modal.label = "Edit details";
  modal.className = variant;
  const name = fieldDocument.createElement("input");
  name.autofocus = autofocus;
  name.value = "Original name";
  name.setAttribute("aria-label", "Name");
  const notes = fieldDocument.createElement("textarea");
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
  it("retains presentation through native exit transitions after closing during opening", async () => {
    vi.stubGlobal("webkit", { messageHandlers: { openclawBrowser: { postMessage: vi.fn() } } });
    let occluded = false;
    const unsubscribe = subscribeNativeOverlayOcclusion(
      (value) => {
        occluded = value;
      },
      () => null,
    );
    const originalOverflow = getComputedStyle(document.body).overflow;
    const modal = document.createElement("openclaw-modal-dialog");
    modal.manual = true;
    modal.label = "Animated dialog";
    modal.textContent = "Opening content";
    modal.style.setProperty("--openclaw-modal-show-duration", "1000ms");
    modal.style.setProperty("--openclaw-modal-hide-duration", "1000ms");
    container.append(modal);
    await modal.updateComplete;
    const dialog = modalDialog(modal);
    // Keep the exit measurable even in engines that immediately remove top-layer display.
    dialog.style.display = "flex";
    try {
      modal.show();
      const opening = dialog
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition);
      expect(opening.length).toBeGreaterThan(0);
      for (const animation of opening) {
        animation.pause();
        animation.currentTime = 500;
      }
      expect(dialog.dataset.phase).toBe("opening");
      let completions = 0;
      modal.addEventListener("wa-after-hide", () => {
        completions += 1;
      });
      const hidden = afterModalPhase(modal, "closed");
      modal.hide();
      expect(modal.open).toBe(false);
      expect(dialog.open).toBe(true);
      for (const animation of opening) {
        animation.finish();
      }
      expect(getComputedStyle(dialog).opacity).toBe("1");

      let exiting: Animation[] = [];
      await expect
        .poll(() => {
          if (dialog.open) {
            return 0;
          }
          exiting = dialog
            .getAnimations()
            .filter(
              (animation) =>
                animation instanceof CSSTransition &&
                ["running", "paused"].includes(animation.playState) &&
                Number.isFinite(animation.effect?.getComputedTiming().endTime),
            );
          for (const animation of exiting) {
            animation.pause();
          }
          return exiting.length;
        })
        .toBeGreaterThan(0);
      expect(completions).toBe(0);
      expect(dialog.dataset.phase).toBe("closing");
      expect(getComputedStyle(document.body).overflow).toBe("hidden");
      expect(occluded).toBe(true);

      for (const animation of exiting) {
        animation.finish();
      }
      await hidden;
      expect(completions).toBe(1);
      expect(dialog.dataset.phase).toBe("hidden");
      expect(getComputedStyle(document.body).overflow).toBe(originalOverflow);
      expect(occluded).toBe(false);
    } finally {
      for (const animation of dialog.getAnimations()) {
        animation.cancel();
      }
      modal.remove();
      unsubscribe();
      vi.unstubAllGlobals();
    }
  });

  it("locks the owning document until its last shadow-hosted modal closes", async () => {
    const frame = document.createElement("iframe");
    container.append(frame);
    const doc = frame.contentDocument!;
    const view = frame.contentWindow!;
    doc.body.style.minHeight = "200vh";
    const originalOverflow = view.getComputedStyle(doc.body).overflow;
    const host = document.createElement("div");
    doc.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const firstMount = document.createElement("div");
    const secondMount = document.createElement("div");
    shadow.append(firstMount, secondMount);

    const first = await mountModal(firstMount, "palette");
    expect(first.dialog.open).toBe(true);
    expect(view.getComputedStyle(doc.body).overflow).toBe("hidden");
    const second = await mountModal(secondMount, "palette");
    const secondHidden = afterModalPhase(second.modal, "closed");
    second.modal.hide();
    await secondHidden;
    expect(first.dialog.open).toBe(true);
    expect(view.getComputedStyle(doc.body).overflow).toBe("hidden");

    const firstHidden = afterModalPhase(first.modal, "closed");
    first.modal.hide();
    await firstHidden;
    expect(view.getComputedStyle(doc.body).overflow).toBe(originalOverflow);
  });

  it.each(["palette", "drawer", "drawer drawer--floating"])(
    "assigns motion to the rendered interaction (%s)",
    async (variant) => {
      const modal = document.createElement("openclaw-modal-dialog");
      modal.manual = true;
      modal.className = variant;
      modal.textContent = "Motion policy";
      container.append(modal);
      await modal.updateComplete;
      modal.show();
      const dialog = modalDialog(modal);
      const style = getComputedStyle(dialog);
      if (variant === "palette") {
        expect(style.getPropertyValue("--openclaw-modal-show-duration").trim()).toBe("0ms");
        expect(style.getPropertyValue("--openclaw-modal-hide-duration").trim()).toBe("0ms");
        expect(
          dialog
            .getAnimations()
            .filter(
              (animation) => Number(animation.effect?.getComputedTiming().activeDuration ?? 0) > 0,
            ),
        ).toHaveLength(0);
        return;
      }
      expect(style.getPropertyValue("--openclaw-modal-show-duration").trim()).toBe("200ms");
      expect(style.getPropertyValue("--openclaw-modal-hide-duration").trim()).toBe("0ms");
      expect(style.animationName).toBe("openclaw-drawer-in");
      expect(style.animationDuration).toBe("0.2s");
      expect(style.animationTimingFunction).toBe("cubic-bezier(0.32, 0.72, 0, 1)");
      const animation = dialog
        .getAnimations()
        .find(
          (candidate) =>
            candidate instanceof CSSAnimation && candidate.animationName === "openclaw-drawer-in",
        );
      expect(animation).toBeDefined();
      animation!.pause();
      animation!.currentTime = 0;
      const inset = Number.parseFloat(style.getPropertyValue("--openclaw-drawer-inset")) || 0;
      expect(new DOMMatrixReadOnly(getComputedStyle(dialog).transform).m41).toBeCloseTo(
        dialog.getBoundingClientRect().width + inset,
        0,
      );
      animation!.currentTime = 200;
      expect(new DOMMatrixReadOnly(getComputedStyle(dialog).transform).m41).toBeCloseTo(0, 0);
      animation!.finish();
    },
  );

  it.each(
    [false, true].flatMap((moved) =>
      ["light", "shadow", "slot"]
        .map((tree) => ({ moved, tree, blocked: "inert" }))
        .concat({ moved, tree: "light", blocked: "disabled" }),
    ),
  )(
    "returns focus after background controls become focusable without replacing new focus ($tree, $blocked, moved=$moved)",
    async ({ moved, tree, blocked }) => {
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

      background.inert = blocked === "inert";
      trigger.disabled = blocked === "disabled";
      modal.remove();
      expect(trigger.matches(":focus")).toBe(false);
      background.inert = false;
      trigger.disabled = false;
      if (moved) {
        nextTarget.focus();
      }

      await expect.poll(() => (moved ? nextTarget : trigger).matches(":focus")).toBe(true);
    },
  );

  it.each(["inert", "disabled", "reconnected", "removed"])(
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

      background.inert = state !== "disabled";
      trigger.disabled = state === "disabled";
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

  it.each(["immediate", "queued"] as const)(
    "hands off deferred focus after an accepted close and %s removal",
    async (removal) => {
      const background = document.createElement("div");
      const trigger = document.createElement("button");
      background.append(trigger);
      container.append(background);
      trigger.focus();
      const { modal, dialog } = await mountModal(container, "palette");

      background.inert = true;
      modal.hide();
      expect(dialog.open).toBe(false);
      const remove = () => {
        modal.remove();
        background.inert = false;
      };
      if (removal === "immediate") {
        remove();
      } else {
        await new Promise<void>((resolve) => {
          queueMicrotask(() => {
            remove();
            resolve();
          });
        });
      }

      await Promise.resolve();
      expect(document.activeElement).toBe(trigger);
    },
  );

  it.each(["replacement", "suppressed"] as const)(
    "preserves the original opener after reversing a pending close (%s)",
    async (mode) => {
      const opener = document.createElement("button");
      const replacement = document.createElement("button");
      container.append(opener, replacement);
      opener.focus();
      const { modal, dialog, notes } = await mountModal();
      notes.focus();
      const animation = dialog.animate({ opacity: [1, 0.9] }, { duration: 1000 });
      animation.pause();
      try {
        modal.hide();
        expect(modal.open).toBe(false);
        expect(dialog.open).toBe(true);
        modal.show();
        expect(modal.open).toBe(true);
        expect(modalDialog(modal)).toBe(dialog);
        modal.setReturnFocusTarget(mode === "replacement" ? replacement : null);

        const hidden = afterModalPhase(modal, "closed");
        modal.hide();
        expect(modal.open).toBe(false);
        expect(dialog.open).toBe(true);
        animation.finish();
        await hidden;

        expect(dialog.open).toBe(false);
        if (mode === "replacement") {
          expect(document.activeElement).toBe(replacement);
        } else {
          expect(document.activeElement).not.toBe(opener);
        }
      } finally {
        animation.cancel();
      }
    },
  );

  it.each(["standard", "drawer"])(
    "honors reduced motion when opening and closing (%s)",
    async (variant) => {
      await emulateOverlayMedia({ reducedMotion: "reduce" });
      try {
        expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
        const modal = document.createElement("openclaw-modal-dialog");
        modal.manual = true;
        modal.className = variant === "drawer" ? "drawer" : "";
        modal.label = "Motion preference";
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
        await emulateOverlayMedia({ forcedColors: "none", reducedMotion: "no-preference" });
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
      modal.querySelector(".oc-modal-dialog__body")!.replaceChildren(content);

      await expect.poll(() => scroller.clientHeight).toBeGreaterThan(0);
      expect(scroller.clientHeight).toBeLessThanOrEqual(window.innerHeight);
      expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
      await userEvent.click(action);
      expect(clicked).toBe(true);
      expect(action.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    },
  );

  it("scrolls long default modal content without a child scroll container", async () => {
    const { userEvent } = await import("vitest/browser");
    const { modal, dialog } = await mountModal(container, "", false);
    const body = modal.querySelector<HTMLElement>(".oc-modal-dialog__body")!;
    const form = document.createElement("form");
    const content = document.createElement("div");
    content.style.height = "200dvh";
    content.textContent = "Long form content";
    const action = document.createElement("button");
    action.type = "button";
    action.textContent = "Save changes";
    let clicked = false;
    action.addEventListener("click", () => {
      clicked = true;
    });
    form.append(content, action);
    body.replaceChildren(form);

    expect(body.clientHeight).toBeGreaterThan(0);
    expect(body.clientHeight).toBeLessThanOrEqual(dialog.clientHeight);
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    await userEvent.click(action);
    expect(clicked).toBe(true);
    expect(body.scrollTop).toBeGreaterThan(0);
  });

  it("dismisses a tooltip before native modal cancellation and preserves the draft", async () => {
    const { userEvent } = await import("vitest/browser");
    const { modal, dialog, notes } = await mountModal();
    notes.value = "Unsaved draft";
    const tooltip = document.createElement("openclaw-tooltip");
    tooltip.content = "Draft editing help";
    tooltip.anchor = notes;
    modal.getOverlayContainer()!.append(tooltip);
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
    outer.modal.getOverlayContainer()!.append(nestedHost);
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

  it.each(["parent", "iframe"])(
    "preserves a field created in the %s document when iframe dialog chrome receives focus",
    async (realm) => {
      const frame = document.createElement("iframe");
      container.append(frame);
      const doc = frame.contentDocument!;
      const host = doc.createElement("div");
      doc.body.append(host);
      const { dialog, name, notes } = await mountModal(
        host,
        "",
        true,
        realm === "parent" ? document : doc,
      );
      expect(doc.activeElement).toBe(name);
      notes.focus();
      dialog.focus();
      expect(doc.activeElement).toBe(notes);
    },
  );

  it("returns to an external shadow-root trigger when the modal owner is removed", async () => {
    const triggerHost = document.createElement("div");
    const triggerRoot = triggerHost.attachShadow({ mode: "open" });
    const trigger = document.createElement("button");
    trigger.textContent = "Open image preview";
    triggerRoot.append(trigger);
    container.append(triggerHost);
    trigger.focus();
    const previewHost = document.createElement("div");
    const previewRoot = previewHost.attachShadow({ mode: "open" });
    const preview = document.createElement("div");
    previewRoot.append(preview);
    container.append(previewHost);
    const { dialog } = await mountModal(preview);
    expect(dialog.open).toBe(true);
    previewHost.remove();
    expect(dialog.open).toBe(false);
    expect(triggerRoot.activeElement).toBe(trigger);
  });

  it("leaves native chrome focused when there is no autofocus target or displaced field", async () => {
    const { dialog } = await mountModal(container, "", false);
    expect(dialog.matches(":focus")).toBe(true);
    expect(document.activeElement).toBe(dialog);
    expect(dialog.getAttribute("aria-label")).toBe("Edit details");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });
});
