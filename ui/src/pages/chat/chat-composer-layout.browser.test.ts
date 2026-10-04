import { html, nothing, render } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { createComposerProps } from "./chat-composer.test-support.ts";
import { renderChatComposer, resetChatComposerState } from "./components/chat-composer.ts";
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
  let container: HTMLDivElement;
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
    container = document.createElement("div");
    document.body.append(container);
  });
  afterEach(() => {
    render(nothing, container);
    container.remove();
    styles.remove();
    resetChatComposerState();
  });

  function fixture() {
    let width: string | undefined = "1081px";
    const props = createComposerProps({
      onComposerWidthChange: (value) => {
        width = value;
        draw();
      },
    });
    function draw() {
      props.chatMessageMaxWidth = width;
      render(
        html`<div
          class="chat"
          style=${styleMap({ "--chat-thread-max-width": width, height: "calc(100vh - 60px)" })}
        >
          <div class="chat-main__conversation-frame">
            <div class="chat-main__conversation">
              <div class="chat-thread">Visible transcript</div>
              <footer class="chat-footer">${renderChatComposer(props)}</footer>
            </div>
          </div>
        </div>`,
        container,
      );
    }
    draw();
    return {
      props,
      draw,
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
      const footer = container.querySelector<HTMLElement>(".chat-footer")!.getBoundingClientRect();
      expect(footer.height).toBeLessThanOrEqual(840 - 160 + 1);
      expect(
        container.querySelector<HTMLElement>(".chat-thread")!.getBoundingClientRect().height,
      ).toBeGreaterThanOrEqual(159);
      expect(f.input().getBoundingClientRect().bottom).toBeLessThanOrEqual(footer.bottom);
      expect(f.editor().scrollHeight).toBeGreaterThan(f.editor().clientHeight);
      f.props.draft = "";
      f.draw();
      await settled();
      expect(f.input().getBoundingClientRect().height).toBe(initial.height);
    },
  );

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
    render(nothing, container);
    await settled();
    expect(input.querySelector('[role="separator"]')).toBeNull();
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
    f.props.footerContent = html`<div style="height: 180px">Visible context</div>`;
    f.draw();
    await settled();
    await settled();
    const context = container.querySelector<HTMLElement>(".chat-footer__context")!;
    expect(context.clientHeight).toBeGreaterThanOrEqual(180);
    expect(f.editor().clientHeight).toBeLessThanOrEqual(before - 180 + 1);
    expect(f.input().getBoundingClientRect().bottom).toBeLessThanOrEqual(900);
    f.props.footerContent = nothing;
    f.draw();
    await settled();
    await settled();
    expect(f.editor().clientHeight).toBe(before);
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
