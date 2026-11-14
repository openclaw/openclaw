import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import {
  createComposerContainer,
  createComposerProps,
  renderComposerInto,
  disposeComposer,
} from "./chat-composer.test-support.ts";
import { prepareComposerWidthEdge } from "./components/chat-composer-width-ref.tsx";
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

describe("composer border width control", () => {
  let container: ReturnType<typeof createComposerContainer>;
  let styles: HTMLStyleElement;
  beforeEach(async () => {
    // Production warms the lazy edge owner at idle; the new-session suite covers intent loading.
    await prepareComposerWidthEdge();
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

  function fixture(writable = true) {
    let width: string | undefined = "1081px";
    const onWidthChange = vi.fn((value: string | undefined) => {
      width = value;
      draw();
    });
    const props = createComposerProps({
      onComposerWidthChange: writable ? onWidthChange : undefined,
      getTranscriptElement: () =>
        container.closest(".chat")?.querySelector<HTMLElement>(".chat-thread") ?? null,
    });
    function draw() {
      props.chatMessageMaxWidth = width;
      let root = container.closest<HTMLElement>(".chat");
      if (!root) {
        root = document.createElement("div");
        root.className = "chat";
        root.style.height = "calc(100vh - 60px)";
        root.innerHTML =
          '<div class="chat-main__conversation-frame"><div class="chat-main__conversation"><div class="chat-thread"><div class="chat-thread-inner">Visible transcript</div></div><footer class="chat-footer"></footer></div></div>';
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

  it("keeps callback-only updates off the geometry path and uses the latest callback", async () => {
    await page.viewport(1440, 900);
    const f = fixture();
    await settled();
    const edge = f.edge();
    const shell = f.input().closest<HTMLElement>(".agent-chat__composer-shell")!;
    const shellRead = vi.spyOn(shell, "getBoundingClientRect");
    const inputRead = vi.spyOn(f.input(), "getBoundingClientRect");
    const onWidthChange = vi.fn(f.onWidthChange);
    f.props.onComposerWidthChange = onWidthChange;
    f.props.getTranscriptElement = () =>
      container.closest(".chat")!.querySelector<HTMLElement>(".chat-thread");
    f.draw();
    expect(f.edge()).toBe(edge);
    expect(shellRead).not.toHaveBeenCalled();
    expect(inputRead).not.toHaveBeenCalled();
    await settled();
    f.edge().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await settled();
    expect(onWidthChange).toHaveBeenCalledWith("1061px");
    expect(f.width()).toBe("1061px");
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
    const edge = f.edge();
    disposeComposer(container);
    await settled();
    expect(container.querySelector('[role="separator"]')).toBeNull();
    edge.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    edge.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(f.onWidthChange).toHaveBeenCalledTimes(2);
  });
  it.each(["pointercancel", "lostpointercapture", "blur"] as const)(
    "cancels a width preview on %s without saving or handling later pointer input",
    async (reason) => {
      await page.viewport(1440, 900);
      const f = fixture();
      await settled();
      const edge = f.edge();
      const root = container.closest<HTMLElement>(".chat")!;
      const saved = root.style.getPropertyValue("--chat-thread-max-width");
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
      expect(root.style.getPropertyValue("--chat-thread-max-width")).toBe("1021px");
      if (reason === "blur") {
        window.dispatchEvent(new Event("blur"));
      } else {
        edge.dispatchEvent(new PointerEvent(reason, { pointerId: 7, bubbles: true }));
      }
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX: 350 }));
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7 }));
      expect(root.style.getPropertyValue("--chat-thread-max-width")).toBe(saved);
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
    f.props.disabledBanner = { kind: "composer-replacement", text: "Archived" };
    f.draw();
    await settled();
    expect(container.querySelector('[role="separator"]')).toBeNull();
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
  it("rebinds one Solid-owned edge on a new draft and cancels an unmounted drag", async () => {
    await page.viewport(1440, 900);
    const f = fixture();
    await settled();
    f.props.sessionKey = "agent:main:another-draft";
    f.draw();
    await settled();
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
    const edge = f.edge();
    edge.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await settled();
    expect(f.width()).toBe("1061px");
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
    const root = container.closest<HTMLElement>(".chat")!;
    expect(root.style.getPropertyValue("--chat-thread-max-width")).toBe("1001px");
    disposeComposer(container);
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7 }));
    expect(root.style.getPropertyValue("--chat-thread-max-width")).toBe("1061px");
    expect(f.onWidthChange).toHaveBeenCalledTimes(1);
  });

  it("clamps a drag to the reading column and follows a narrower pane without saving it", async () => {
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
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX: -2000 }));
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7 }));
    await settled();
    const assertColumn = () => {
      const transcript = root
        .querySelector<HTMLElement>(".chat-thread-inner")!
        .getBoundingClientRect();
      const composer = f.input().getBoundingClientRect();
      expect(composer.left).toBeGreaterThanOrEqual(transcript.left - 1);
      expect(composer.right).toBeLessThanOrEqual(transcript.right + 1);
      expect(composer.width).toBeGreaterThan(0);
    };
    assertColumn();
    const saved = f.width();
    // A docked side panel changes the containing region, not the saved preference.
    root.style.width = "1000px";
    await settled();
    await settled();
    assertColumn();
    expect(f.width()).toBe(saved);
    expect(f.onWidthChange).toHaveBeenCalledTimes(1);
  });
  it("keeps unsaved and narrow-column geometry at the default composer width", async () => {
    await page.viewport(1440, 900);
    const f = fixture();
    const root = container.closest<HTMLElement>(".chat")!;
    const shell = f.input().closest<HTMLElement>(".agent-chat__composer-shell")!;
    f.onWidthChange(undefined);
    root.style.width = "600px";
    await settled();
    expect(shell.style.maxWidth).toBe("");
    const unsaved = shell.getBoundingClientRect().width;
    f.setWidth("1081px");
    await settled();
    expect(shell.getBoundingClientRect().width).toBe(unsaved);
  });

  it("leaves embedded composers alone until writable and retires their old edge", async () => {
    await page.viewport(1440, 900);
    const f = fixture(false);
    await settled();
    const shell = f.input().closest<HTMLElement>(".agent-chat__composer-shell")!;
    expect(f.edge()).toBeNull();
    expect(shell.style.maxWidth).toBe("");
    window.dispatchEvent(new Event("resize"));
    expect(shell.style.maxWidth).toBe("");

    f.props.onComposerWidthChange = f.onWidthChange;
    f.draw();
    await settled();
    const edge = f.edge();
    expect(edge).not.toBeNull();
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
    const root = container.closest<HTMLElement>(".chat")!;
    expect(root.style.getPropertyValue("--chat-thread-max-width")).toBe("1021px");
    f.props.onComposerWidthChange = undefined;
    f.draw();
    await settled();
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7 }));
    expect(f.edge()).toBeNull();
    expect(shell.style.maxWidth).toBe("");
    expect(root.style.getPropertyValue("--chat-thread-max-width")).toBe("1081px");
    expect(f.onWidthChange).not.toHaveBeenCalled();

    f.props.onComposerWidthChange = f.onWidthChange;
    f.draw();
    await settled();
    edge.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    edge.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(f.onWidthChange).not.toHaveBeenCalled();
    f.edge().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await settled();
    expect(f.width()).toBe("1061px");
  });
});
