import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { page } from "vitest/browser";
import { createPointerDrag } from "../../lib/reactive/pointer-drag.ts";
import {
  createComposerContainer,
  createComposerProps,
  renderComposerInto,
  disposeComposer,
} from "./chat-composer.test-support.ts";
import { ComposerLayout } from "./components/chat-composer-layout.ts";
import { resetChatComposerState } from "./components/chat-composer.tsx";
import baseStyles from "../../styles/base.css?inline";
import surfaceStyles from "../../styles/chat/composer-surface.css?inline";
import composerStyles from "../../styles/chat/composer.css?inline";
import layoutStyles from "../../styles/chat/layout.css?inline";
import startupStyles from "../../styles/chat/startup-layout.css?inline";

const settled = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

describe("content-sized composer with border width control", () => {
  let container: ReturnType<typeof createComposerContainer>;
  let styles: HTMLStyleElement;
  beforeEach(() => {
    styles = document.createElement("style");
    styles.textContent = [
      baseStyles,
      startupStyles,
      layoutStyles,
      surfaceStyles,
      composerStyles,
    ].join("\n");
    document.head.append(styles);
    container = createComposerContainer();
    document.body.append(container);
  });
  afterEach(() => {
    disposeComposer(container);
    (container.closest(".chat") ?? container).remove();
    styles.remove();
    resetChatComposerState();
  });

  function fixture() {
    let width: string | undefined = "1081px";
    const onWidthChange = vi.fn((value: string | undefined) => {
      width = value;
      draw();
    });
    const props = createComposerProps({ onComposerWidthChange: onWidthChange });
    function draw() {
      props.chatMessageMaxWidth = width;
      let root = container.closest<HTMLElement>(".chat");
      if (!root) {
        root = document.createElement("div");
        root.className = "chat";
        root.style.height = "calc(100vh - 60px)";
        root.innerHTML =
          '<div class="chat-main__conversation-frame"><div class="chat-main__conversation"><div class="chat-thread">Visible transcript</div><footer class="chat-footer"></footer></div></div>';
        container.replaceWith(root);
        root.querySelector(".chat-footer")!.append(container);
        container.style.display = "contents";
      }
      root.style.setProperty("--chat-thread-max-width", width ?? "");
      renderComposerInto(container, props);
    }

    draw();
    return {
      props,
      draw,
      onWidthChange,
      width: () => width,
      setWidth: (value: string) => {
        width = value;
        draw();
      },
      editor: () => container.querySelector<HTMLTextAreaElement>("textarea")!,
      input: () => container.querySelector<HTMLElement>(".agent-chat__input")!,
      edge: () => container.querySelector<HTMLElement>(".agent-chat__composer-width-edge")!,
    };
  }

  it.each([1440, 1600])(
    "grows beyond six lines, caps the whole footer, and shrinks at %ipx",
    async (width) => {
      await page.viewport(width, 900);
      const f = fixture();
      await settled();
      const initial = f.input().getBoundingClientRect();
      expect(initial.width).toBe(1081);
      f.props.draft = Array.from({ length: 10 }, (_, i) => `Line ${i}`).join("\n");
      f.draw();
      await settled();
      expect(f.editor().clientHeight).toBeGreaterThan(
        6 * Number.parseFloat(getComputedStyle(f.editor()).lineHeight),
      );
      expect(f.editor().scrollHeight).toBeLessThanOrEqual(f.editor().clientHeight + 1);
      f.props.draft = "Long draft\n".repeat(100);
      f.draw();
      await settled();
      const footer = container.closest<HTMLElement>(".chat-footer")!.getBoundingClientRect();
      expect(footer.height).toBeLessThanOrEqual(840 - 160 + 1);
      expect(
        container
          .closest(".chat")!
          .querySelector<HTMLElement>(".chat-thread")!
          .getBoundingClientRect().height,
      ).toBeGreaterThanOrEqual(159);
      expect(f.input().getBoundingClientRect().bottom).toBeLessThanOrEqual(footer.bottom);
      expect(f.editor().scrollHeight).toBeGreaterThan(f.editor().clientHeight);
      f.props.draft = "";
      f.draw();
      await settled();
      expect(f.input().getBoundingClientRect().height).toBe(initial.height);
    },
  );

  it("does not shrink or save when widening a full-width mobile composer", async () => {
    await page.viewport(390, 844);
    const f = fixture();
    await settled();
    const shell = f.input().closest<HTMLElement>(".agent-chat__composer-shell")!;
    const initial = shell.getBoundingClientRect().width;
    expect(initial).toBeGreaterThan(0);
    f.edge().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await settled();
    expect.soft(shell.getBoundingClientRect().width).toBe(initial);
    expect.soft(f.onWidthChange).not.toHaveBeenCalled();
    await page.viewport(1440, 900);
    await settled();
    expect(shell.getBoundingClientRect().width).toBe(1081);
  });

  it("resets width to the opening preference and leaves no observer-owned handle after unmount", async () => {
    await page.viewport(1440, 900);
    const f = fixture();
    await settled();
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(getComputedStyle(f.edge()).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(f.edge()).cursor).toBe("ew-resize");
    f.edge().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await settled();
    expect(f.width()).toBe("1061px");
    f.edge().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await settled();
    expect(f.width()).toBe("1081px");
    expect(f.input().getBoundingClientRect().width).toBe(1081);
    const input = f.input();
    disposeComposer(container);
    await settled();
    expect(
      input.closest(".agent-chat__composer-shell")!.querySelector('[role="separator"]'),
    ).toBeNull();
    expect(input.style.getPropertyValue("--chat-composer-editor-height-limit")).toBe("");
  });
  it("budgets newly appearing context before a capped draft and releases it again", async () => {
    await page.viewport(1440, 900);
    const f = fixture();
    f.props.draft = "Long draft\n".repeat(100);
    f.draw();
    await settled();
    await settled();
    const before = f.editor().clientHeight;
    // Context chrome must leave room for the editor inside the complete footer.
    f.props.footerContent = (
      <div style={{ height: "180px", "flex-shrink": "0" }}>Visible context</div>
    );
    f.draw();
    await settled();
    await settled();
    const context = container.querySelector<HTMLElement>(".chat-footer__context")!;
    expect(context.clientHeight).toBeGreaterThanOrEqual(180);
    expect(f.editor().clientHeight).toBeLessThanOrEqual(before - 180 + 1);
    expect(f.input().getBoundingClientRect().bottom).toBeLessThanOrEqual(900);
    f.props.footerContent = undefined;
    f.draw();
    await settled();
    await settled();
    expect(f.editor().clientHeight).toBe(before);
  });

  it("keeps the cap on the textarea a new draft scope mounts", async () => {
    await page.viewport(1440, 900);
    const f = fixture();
    f.props.draft = "Long draft\n".repeat(100);
    f.draw();
    await settled();
    await settled();
    const first = f.editor();
    const capped = first.clientHeight;
    f.props.sessionKey = "agent:main:another-draft";
    f.draw();
    await settled();
    await settled();
    expect(f.editor()).not.toBe(first);
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(f.editor().clientHeight).toBe(capped);
    f.props.draft = "";
    f.draw();
    await settled();
    f.props.draft = "Long draft\n".repeat(100);
    f.draw();
    await settled();
    await settled();
    expect(f.editor().clientHeight).toBe(capped);
  });

  it("takes the current width as the reset target after a detach", async () => {
    await page.viewport(1440, 900);
    const integrated = fixture();
    await settled();
    expect(integrated.edge()).not.toBeNull();
    disposeComposer(container);
    container.closest(".chat")!.replaceWith(container);
    container.innerHTML = `<div class="chat"><div><div class="agent-chat__composer-shell">
      <div class="agent-chat__input"><div class="agent-chat__composer-combobox"><textarea></textarea></div></div>
    </div></div></div>`;
    const root = container.querySelector<HTMLElement>(".chat")!;
    const input = container.querySelector<HTMLElement>(".agent-chat__input")!;
    const edge = () =>
      input
        .closest(".agent-chat__composer-shell")!
        .querySelector<HTMLElement>('[role="separator"]')!;
    const layout = createRoot((dispose) => {
      onTestFinished(dispose);
      return new ComposerLayout(createPointerDrag());
    });
    const widths: (string | undefined)[] = [];
    const bind = (width: string) => {
      root.style.setProperty("--chat-thread-max-width", width);
      layout.update(input, {
        width,
        onWidthChange: (value) => widths.push(value),
        getEditor: () => input.querySelector("textarea"),
      });
    };
    bind("1081px");
    await settled();
    edge().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(widths).toEqual(["1061px"]);
    bind("1061px");
    layout.disconnect();
    expect(
      input.closest(".agent-chat__composer-shell")!.querySelector('[role="separator"]'),
    ).toBeNull();
    bind("1061px");
    await settled();
    expect(
      input.closest(".agent-chat__composer-shell")!.querySelectorAll('[role="separator"]'),
    ).toHaveLength(1);
    edge().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(widths).toEqual(["1061px", "1061px"]);
    // A second surface takes the layout over; the first keeps nothing.
    const shell = input.closest<HTMLElement>(".agent-chat__composer-shell")!;
    const other = shell.cloneNode(true) as HTMLElement;
    other.querySelector('[role="separator"]')!.remove();
    shell.after(other);
    const next = other.querySelector<HTMLElement>(".agent-chat__input")!;
    layout.update(next, {
      width: "900px",
      onWidthChange: (value) => widths.push(value),
      getEditor: () => next.querySelector("textarea"),
    });
    await settled();
    expect(
      input.closest(".agent-chat__composer-shell")!.querySelector('[role="separator"]'),
    ).toBeNull();
    expect(input.style.getPropertyValue("--chat-composer-editor-height-limit")).toBe("");
    expect(
      next.closest(".agent-chat__composer-shell")!.querySelectorAll('[role="separator"]'),
    ).toHaveLength(1);
    layout.disconnect();
    container.innerHTML = "";
  });

  it.each(["pointercancel", "lostpointercapture", "blur"] as const)(
    "cancels a width preview on %s without saving or handling later pointer input",
    async (reason) => {
      await page.viewport(1440, 900);
      const f = fixture();
      await settled();
      const edge = f.edge();
      const root = container.closest<HTMLElement>(".chat")!;
      edge.dispatchEvent(
        new PointerEvent("pointerdown", {
          pointerId: 7,
          isPrimary: true,
          button: 0,
          clientX: 300,
          bubbles: true,
        }),
      );
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX: 330 }));
      expect(root.style.getPropertyValue("--chat-thread-drag-width")).toBe("1021px");
      if (reason === "blur") {
        window.dispatchEvent(new Event("blur"));
      } else {
        edge.dispatchEvent(new PointerEvent(reason, { pointerId: 7, bubbles: true }));
      }
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX: 350 }));
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7 }));
      expect(root.style.getPropertyValue("--chat-thread-drag-width")).toBe("");
      expect(edge.classList.contains("agent-chat__composer-width-edge--dragging")).toBe(false);
      expect(f.onWidthChange).not.toHaveBeenCalled();
      expect(f.input().getBoundingClientRect().width).toBe(1081);
    },
  );

  it("retires the edge when a replacement banner hides the input", async () => {
    await page.viewport(1440, 900);
    const f = fixture();
    await settled();
    const edge = f.edge();
    expect(edge).not.toBeNull();
    const input = f.input();
    f.props.disabledBanner = { kind: "composer-replacement", text: "Archived" };
    f.draw();
    await settled();
    expect(container.querySelector('[role="separator"]')).toBeNull();
    expect(input.style.getPropertyValue("--chat-composer-editor-height-limit")).toBe("");
    edge.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(f.width()).toBe("1081px");
    f.props.disabledBanner = undefined;
    f.draw();
    await settled();
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
  });

  it("keeps the outside edge hittable when the landscape input scrolls", async () => {
    await page.viewport(844, 390);
    const f = fixture();
    await settled();
    const edge = f.edge();
    expect(edge).not.toBeNull();
    const box = edge.getBoundingClientRect();
    expect(box.width).toBe(8);
    expect(box.right).toBeLessThanOrEqual(f.input().getBoundingClientRect().left + 1);
    expect(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)).toBe(
      edge,
    );
  });

  it("budgets New Session against a shorter containing scroll pane", async () => {
    await page.viewport(1440, 900);
    const f = fixture();
    await settled();
    expect(f.edge()).not.toBeNull();
    const root = container.closest<HTMLElement>(".chat")!;
    const scroll = container.closest<HTMLElement>(".chat-footer")!;
    root.className = "new-session-page";
    scroll.className = "new-session-page__scroll";
    scroll.style.cssText = "position: fixed; top: 100px; height: 500px; width: 1200px";
    f.props.draft = "Long draft\n".repeat(100);
    renderComposerInto(container, f.props);
    await settled();
    await settled();
    const chrome = f.input().offsetHeight - f.editor().offsetHeight;
    const shell = f.input().closest<HTMLElement>(".agent-chat__composer-shell")!;
    const margins =
      Number.parseFloat(getComputedStyle(shell).marginTop) +
      Number.parseFloat(getComputedStyle(shell).marginBottom);
    const budget =
      scroll.getBoundingClientRect().bottom - shell.getBoundingClientRect().top - margins - chrome;
    expect(
      Number.parseFloat(f.input().style.getPropertyValue("--chat-composer-editor-height-limit")),
    ).toBeLessThanOrEqual(budget + 1);
    root.className = "chat";
  });

  it("accepts external presets matching earlier self-commits and exposes a valid narrow range", async () => {
    await page.viewport(1440, 900);
    const f = fixture();
    await settled();
    const press = () =>
      f.edge().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    press();
    await settled();
    expect(f.width()).toBe("1061px");
    f.setWidth("560px");
    await settled();
    f.setWidth("1061px");
    await settled();
    press();
    await settled();
    f.edge().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await settled();
    expect(f.width()).toBe("1061px");
    f.setWidth("400px");
    await settled();
    expect(Number(f.edge().getAttribute("aria-valuemin"))).toBeLessThanOrEqual(
      Number(f.edge().getAttribute("aria-valuenow")),
    );
  });
});
