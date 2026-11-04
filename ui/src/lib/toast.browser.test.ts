import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showConfirmDialog } from "../components/confirm-dialog.ts";
import "../styles.css";
import { i18n } from "../i18n/index.ts";
import { waitForRenderedModalDialog } from "../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { showToast, type ToastOptions } from "./toast.ts";
import "./toast-host.tsx";

const rect = (element: Element) => element.getBoundingClientRect();
async function useViewport(width: number, height = 844) {
  const { page } = await import("vitest/browser");
  await page.viewport(width, height);
}
function makeAnchor(width: number, left = 0) {
  const anchor = document.body.appendChild(document.createElement("div"));
  anchor.style.cssText = `position: fixed; top: 100px; left: ${left}px; width: ${width}px; height: 100px`;
  return anchor;
}
function linkedMessage(label: string, before = "Connection lost. ".repeat(12)) {
  const message = document.createDocumentFragment();
  const link = document.createElement("a");
  link.href = `#${label}`;
  link.textContent = label;
  message.append(before, link);
  return { message, link };
}
const archived = {
  severity: undefined,
  message: "Session archived",
  actionLabel: "Undo",
  onAction: () => undefined,
  durationMs: 60_000,
} satisfies ToastOptions;
async function settleAnimations(host: HTMLElement) {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  await Promise.all(
    [...host.querySelectorAll(".app-toast")].flatMap((toast) =>
      toast.getAnimations({ subtree: true }).map((animation) => animation.finished),
    ),
  );
}
async function renderToast(
  options: Partial<ToastOptions> = {},
  host = document.createElement("openclaw-toast-host"),
) {
  if (!host.isConnected) {
    document.body.append(host);
  }
  await host.updateComplete;
  const title = typeof options.message === "string" ? options.message.trim() : undefined;
  showToast({ ...archived, ...options });
  await vi.dynamicImportSettled();
  const toast = () =>
    [...host.querySelectorAll<HTMLElement>('.app-toast[data-active="true"]')].find(
      (element) => !title || element.textContent?.includes(title),
    )!;
  await waitForSolid(() => expect(toast()).toBeTruthy());
  const element = toast();
  const part = (name: string) => element.querySelector<HTMLElement>(`.app-toast__${name}`)!;
  await settleAnimations(host);
  return {
    host,
    toast: element,
    lane: element.parentElement!,
    body: part("body"),
    message: part("message"),
    action: part("action"),
    dismiss: part("dismiss"),
  };
}

describe.skipIf(navigator.userAgent.toLowerCase().includes("jsdom"))("toast browser layout", () => {
  let rootStyle: string | null;
  const root = document.documentElement;
  beforeEach(async () => {
    rootStyle = root.getAttribute("style");
    await i18n.setLocale("en");
  });
  afterEach(() => {
    document.body.replaceChildren();
    if (rootStyle === null) {
      root.removeAttribute("style");
    } else {
      root.setAttribute("style", rootStyle);
    }
  });

  it("signals severity only through the leading icon color and the live role", async () => {
    const { host, toast } = await renderToast();
    const neutral = {
      card: getComputedStyle(toast).backgroundColor,
      text: getComputedStyle(toast).color,
    };
    expect(toast.querySelector(".app-toast__icon")).toBeNull();
    expect(toast.getAttribute("role")).toBe("status");
    const tone = (value: string) => {
      const probe = host.appendChild(document.createElement("span"));
      probe.style.color = value;
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    for (const [severity, token] of [
      ["success", "var(--ok)"],
      ["info", "var(--info)"],
      ["warning", "var(--warn)"],
      ["error", "var(--danger)"],
    ] as const) {
      const { toast: card, action } = await renderToast({ severity }, host);
      expect(card.classList.contains(`app-toast--${severity}`)).toBe(true);
      expect(getComputedStyle(card.querySelector(".app-toast__icon")!).color).toBe(tone(token));
      expect(getComputedStyle(card).backgroundColor).toBe(neutral.card);
      expect(getComputedStyle(card).color).toBe(neutral.text);
      expect(getComputedStyle(action).color).toBe(neutral.text);
      expect(card.getAttribute("role")).toBe(severity === "error" ? "alert" : "status");
    }
  });

  it("splits the title and description and keeps one line a pill", async () => {
    await useViewport(1280);
    const { host, toast, action } = await renderToast();
    const height = rect(toast).height;
    expect(height).toBe(44);
    expect(rect(action).height).toBe(28);
    expect(Number.parseFloat(getComputedStyle(toast).borderTopLeftRadius)).toBeGreaterThanOrEqual(
      height / 2,
    );
    expect(rect(toast).width).toBeGreaterThanOrEqual(240);
    expect(rect(action).top).toBeLessThan(rect(toast).top + height / 2);
    const block = await renderToast(
      {
        message: "A pending message is only saved in this tab.",
        description:
          "Keep this tab open until it is sent, or copy it before discarding it and reloading.",
        actionLabel: "Review pending input",
        actionPrimary: true,
      },
      host,
    );
    expect(rect(block.toast).width).toBeCloseTo(360, 0);
    expect(rect(block.action).top).toBeGreaterThan(rect(block.body).bottom);
    expect(rect(block.action).right).toBeCloseTo(rect(block.toast).right - 10, 0);
    expect(getComputedStyle(block.toast).paddingBlockStart).toBe("12px");
    expect(getComputedStyle(block.toast).paddingBlockEnd).toBe("12px");
    expect(getComputedStyle(block.toast).borderTopLeftRadius).toBe("28px");
    expect(block.action.classList.contains("app-toast__action--primary")).toBe(true);
  });

  it("restores roomy padding when the title or action wraps after resizing", async () => {
    const { host, toast } = await renderToast({
      message: "Sitzung wurde archiviert",
      actionLabel: "Wiederherstellen",
    });
    const padding = () => getComputedStyle(toast).paddingBlockStart;
    for (const width of [1280, 320, 1280]) {
      await useViewport(width);
      await waitForSolid(() => expect(padding()).toBe(width === 320 ? "12px" : "8px"));
    }
    root.style.setProperty("--control-ui-text-scale", "1.6");
    await useViewport(390);
    await waitForSolid(() => expect(padding()).toBe("12px"));
    const wrapped = await renderToast(
      {
        message: "The session could not be archived because it is currently in use",
        actionLabel: undefined,
      },
      host,
    );
    expect(wrapped.message.offsetHeight).toBeGreaterThan(
      Number.parseFloat(getComputedStyle(wrapped.message).lineHeight),
    );
    expect(getComputedStyle(wrapped.toast).paddingBlockStart).toBe("12px");
  });

  it("places actions in the center and arrivals on the right as fixed-width blocks", async () => {
    await useViewport(1280);
    const center = await renderToast();
    const avatar = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    const arrival = await renderToast(
      {
        message: "Release readiness check",
        actionLabel: "Open session",
        placement: "top-right",
        avatar: { id: "gardener", name: "Garden keeper", avatar },
      },
      center.host,
    );
    expect(rect(center.toast).left + rect(center.toast).width / 2).toBeCloseTo(640, 0);
    expect(rect(arrival.toast)).toMatchObject({
      right: expect.closeTo(1260, 0),
      width: expect.closeTo(360, 0),
      top: expect.closeTo(rect(center.toast).top, 0),
    });
    expect(Number.parseFloat(getComputedStyle(arrival.toast).borderTopLeftRadius)).toBeLessThan(
      rect(arrival.toast).height / 2,
    );
    const image = arrival.toast.querySelector<HTMLImageElement>(".app-toast__avatar img")!;
    await waitForSolid(() => expect(image.naturalWidth).toBeGreaterThan(0));
    expect(rect(image)).toMatchObject({ width: 32, height: 32 });
  });

  it("stacks three behind the newest and opens into a list on hover", async () => {
    await useViewport(1280);
    const { host, lane } = await renderToast({ message: "Copied" });
    await renderToast({ message: "Worktrees: release/readiness-check — live run active" }, host);
    const { toast: front } = await renderToast(archived, host);
    await renderToast({ message: "Waiting" }, host);
    const cards = [...lane.querySelectorAll<HTMLElement>(".app-toast")];
    expect(cards.map((card) => card.dataset.depth)).toEqual(["0", "1", "2", "3"]);
    expect(rect(lane).height).toBeCloseTo(rect(cards[0]!).height, 0);
    expect(rect(cards[1]!).bottom).toBeCloseTo(rect(cards[0]!).bottom + 10, 0);
    expect(getComputedStyle(cards[3]!).visibility).toBe("hidden");
    expect(front).not.toBe(cards[0]);

    lane.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    await waitForSolid(() => expect(lane.hasAttribute("data-open")).toBe(true));
    await settleAnimations(host);
    const widths = new Set(cards.map((card) => Math.round(rect(card).width)));
    expect(widths.size).toBe(1);
    for (const [index, card] of cards.entries()) {
      expect(getComputedStyle(card).visibility).toBe("visible");
      if (index > 0) {
        expect(rect(card).top).toBeCloseTo(rect(cards[index - 1]!).bottom + 8, 0);
      }
    }
    lane.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
    await waitForSolid(() => expect(lane.hasAttribute("data-open")).toBe(false));
  });

  it("keeps a toast usable inside a native modal and returns it to the shell on dismissal", async () => {
    const shell = document.body.appendChild(document.createElement("div"));
    shell.className = "shell shell--chat shell--session";
    const host = shell.appendChild(document.createElement("openclaw-toast-host"));
    await useViewport(1280);
    const { toast: restingToast } = await renderToast({ message: "Saved" }, host);
    const restingBounds = rect(restingToast);
    const controller = new AbortController();
    const prompt = { title: "Keep?", message: "", confirmLabel: "Keep" };
    const confirmation = showConfirmDialog({ ...prompt, signal: controller.signal });
    try {
      const { modal, dialog } = await waitForRenderedModalDialog(document.body);
      const onAction = vi.fn();
      const { toast, action } = await renderToast({ message: "Saved", onAction }, host);
      // The replacement enters from 14px above its resting place.
      await vi.waitFor(() => expect(rect(toast).top).toBeCloseTo(restingBounds.top, 0));
      expect(host.parentElement).toBe(modal.getOverlayContainer());
      await Promise.all([
        new Promise<void>((resolve) => {
          window.addEventListener("resize", () => resolve(), { once: true });
        }),
        useViewport(390),
      ]);
      const narrowBounds = rect(toast);
      action.focus();
      expect(document.activeElement).toBe(action);
      expect(dialog.open).toBe(true);
      const { left, top, width, height } = rect(action);
      expect(document.elementFromPoint(left + width / 2, top + height / 2)).toBe(action);
      modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
      await confirmation;
      await host.updateComplete;
      expect(host.parentElement).toBe(shell);
      // Reinserting the host replays the short entry offset.
      await vi.waitFor(() => expect(rect(toast).top).toBeCloseTo(narrowBounds.top, 0));
      expect(rect(toast).right).toBeCloseTo(narrowBounds.right, 0);
      expect(host.textContent).toContain("Saved");
      action.click();
      expect(onAction).toHaveBeenCalledOnce();
    } finally {
      controller.abort();
      await confirmation;
    }
  });

  it.each([390, 1280])("keeps both lanes usable at width %i", async (width) => {
    await useViewport(width);
    const center = await renderToast();
    const arrival = await renderToast(
      { message: "Release readiness check: Failed", placement: "top-right" },
      center.host,
    );
    for (const { toast, action, dismiss } of [center, arrival]) {
      expect(dismiss.offsetHeight).toBe(22);
      expect(rect(action).height).toBe(28);
      expect(rect(toast).left).toBeGreaterThanOrEqual(12);
      expect(rect(toast).right).toBeLessThanOrEqual(width - 12);
    }
    expect(rect(center.toast).top).toBeCloseTo(20, 0);
    if (width === 390) {
      for (const { toast } of [center, arrival]) {
        expect(rect(toast)).toMatchObject({
          left: expect.closeTo(12, 0),
          right: expect.closeTo(378, 0),
        });
      }
      expect(rect(arrival.toast).top).toBeCloseTo(rect(center.toast).bottom + 8, 0);
      expect(rect(center.action).left).toBeGreaterThan(
        rect(center.toast).left + rect(center.toast).width * 0.6,
      );
    } else {
      expect(rect(center.toast).width).toBeLessThan(320);
      expect(rect(center.toast).height).toBeLessThan(60);
      expect(rect(arrival.toast).top).toBeCloseTo(20, 0);
    }
  });

  it("keeps anchored notices on their panel", async () => {
    const { toast } = await renderToast({ anchor: makeAnchor(350, 20) });
    expect(toast.classList.contains("app-toast--anchored")).toBe(true);
    expect(toast.closest(".app-toast-lane")).toBeNull();
    expect(getComputedStyle(toast).top).toBe("100px");
  });

  it("keeps oversized errors scrollable with actions inside a short phone viewport", async () => {
    await useViewport(320, 400);
    for (const placement of ["top-center", "top-right"] as const) {
      const { host, toast, body } = await renderToast({
        placement,
        message: "Lost. ".repeat(1000),
      });
      expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
      body.scrollTop = body.scrollHeight;
      expect(body.scrollTop).toBeGreaterThan(0);
      for (const element of [toast, ...toast.querySelectorAll("button")]) {
        expect(rect(element).top).toBeGreaterThanOrEqual(0);
        expect(rect(element).bottom).toBeLessThanOrEqual(400);
      }
      host.remove();
    }
  });

  it.each([1280, 390, 320])("keeps rich feedback readable at width %i", async (width) => {
    await useViewport(width);
    for (const placement of ["top-center", "top-right", "anchored"] as const) {
      const anchor = makeAnchor(width);
      const recovery = linkedMessage("Settings");
      const { host, toast, body, message, action } = await renderToast({
        message: recovery.message,
        actionLabel: "Discard unsaved changes and reload",
        ...(placement === "anchored" ? { anchor } : { placement }),
      });
      host.style.setProperty("--control-ui-text-scale", "1.3");
      expect(rect(toast).left).toBeGreaterThanOrEqual(0);
      expect(rect(toast).right).toBeLessThanOrEqual(width);
      expect(action.clientHeight).toBeGreaterThanOrEqual(action.scrollHeight);
      if (body.scrollHeight > body.clientHeight) {
        body.scrollTop = body.scrollHeight;
        expect(body.scrollTop).toBeGreaterThan(0);
      }
      for (const element of [message, action]) {
        expect(element.clientWidth).toBeGreaterThanOrEqual(element.scrollWidth);
        expect(rect(element).width).toBeGreaterThan(0);
      }
      const textBox = rect(message);
      const actionBox = rect(action);
      expect(actionBox.right).toBeLessThanOrEqual(rect(toast).right);
      expect(textBox.right <= actionBox.left || textBox.bottom <= actionBox.top).toBe(true);
      expect(message.querySelector("a")).toBe(recovery.link);
      recovery.link.focus();
      expect(document.activeElement).toBe(recovery.link);
      expect(actionBox.height).toBeGreaterThanOrEqual(28);
      host.remove();
      anchor.remove();
    }
  });
});
