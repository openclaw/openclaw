import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { page } from "vitest/browser";
import {
  createComposerContainer,
  createComposerProps,
  renderComposerInto,
  disposeComposer,
} from "./chat-composer.test-support.ts";
import {
  observeTextareaOverflow,
  disconnectTextareaOverflowObserver,
} from "./components/chat-composer-dom.ts";
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

describe("content-sized composer height", () => {
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
    const props = createComposerProps();
    function draw() {
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
      root.style.setProperty("--chat-thread-max-width", "1081px");
      renderComposerInto(container, props);
    }

    draw();
    return {
      props,
      draw,
      editor: () => container.querySelector<HTMLTextAreaElement>("textarea")!,
      input: () => container.querySelector<HTMLElement>(".agent-chat__input")!,
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

  it.each([
    [1440, 900, 12],
    [390, 844, 6],
  ])("caps automatic growth at %ipx × %ipx to %i lines", async (width, height, lines) => {
    await page.viewport(width, height);
    const f = fixture();
    f.props.draft = "Long draft\n".repeat(40);
    f.draw();
    await settled();
    await settled();
    const style = getComputedStyle(f.editor());
    const expectedHeight =
      lines * Number.parseFloat(style.lineHeight) +
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom);
    expect(f.editor().clientHeight).toBeCloseTo(expectedHeight, 0);
    expect(f.editor().scrollHeight).toBeGreaterThan(f.editor().clientHeight);
  });

  it("keeps the correct draft line visible after shrinking", async () => {
    const editor = document.createElement("textarea");
    editor.style.cssText =
      "width:200px;height:96px;max-height:96px;min-height:0;padding:8px;border:0;box-sizing:border-box;font:16px/24px monospace;white-space:pre-wrap;overflow-wrap:break-word;resize:none";
    editor.value = "abcdefghij ".repeat(80);
    container.append(editor);
    observeTextareaOverflow(editor);
    onTestFinished(() => disconnectTextareaOverflowObserver(editor));
    editor.focus();
    editor.setSelectionRange(11, 11);
    editor.scrollTop = 0;
    await settled();
    editor.style.height = "60px";
    editor.style.maxHeight = editor.style.height;
    await settled();
    await settled();
    expect(editor.scrollTop).toBe(8);
  });

  it.each(["end", "top", "grow"] as const)(
    "keeps the draft viewport anchored on window shrink (%s)",
    async (position) => {
      await page.viewport(1440, 900);
      const f = fixture();
      f.props.draft = Array.from({ length: 100 }, (_, i) => `Line ${i}`).join("\n");
      f.draw();
      await settled();
      await settled();
      const editor = f.editor();
      editor.focus();
      const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight);
      const padding = Number.parseFloat(getComputedStyle(editor).paddingTop);
      const line = position === "end" ? 99 : position === "top" ? 2 : 15;
      const caret = position === "end" ? editor.value.length : editor.value.indexOf(`Line ${line}`);
      editor.setSelectionRange(caret, caret);
      editor.scrollTop =
        position === "end" ? editor.scrollHeight : position === "top" ? 0 : 10 * lineHeight;
      await settled();
      const before = { height: editor.clientHeight, scroll: editor.scrollTop };
      await page.viewport(1440, 400);
      await settled();
      await settled();
      const lost = before.height - editor.clientHeight;
      expect(lost).toBeGreaterThan(lineHeight);
      const caretTop = padding + line * lineHeight;
      const anchored = before.scroll + lost;
      const expected = Math.max(0, Math.min(anchored, caretTop));
      expect.soft(editor.scrollTop).toBeCloseTo(expected, 0);
      expect.soft(caretTop - editor.scrollTop).toBeGreaterThanOrEqual(-1);
      expect
        .soft(caretTop + lineHeight - editor.scrollTop)
        .toBeLessThanOrEqual(editor.clientHeight + 1);
      if (position === "end") {
        expect
          .soft(editor.scrollHeight - editor.scrollTop - editor.clientHeight)
          .toBeLessThanOrEqual(1);
      }
      if (position === "grow") {
        const scroll = editor.scrollTop;
        await page.viewport(1440, 900);
        await settled();
        await settled();
        expect(editor.scrollTop).toBe(scroll);
      }
    },
  );

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
      <div style={{ height: "560px", "flex-shrink": "0" }}>Visible context</div>
    );
    f.draw();
    await settled();
    await settled();
    const context = container.querySelector<HTMLElement>(".chat-footer__context")!;
    expect(context.clientHeight).toBeGreaterThanOrEqual(560);
    expect(f.editor().clientHeight).toBeLessThan(before);
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
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(0);
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

  it("budgets New Session against a shorter containing scroll pane", async () => {
    await page.viewport(1440, 900);
    const f = fixture();
    await settled();
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
    const cap = f.input().style.getPropertyValue("--chat-composer-editor-height-limit");
    // More page content makes the containing pane scroll independently of the draft.
    scroll.style.overflowY = "auto";
    const trailing = document.createElement("div");
    trailing.style.height = "800px";
    scroll.append(trailing);
    scroll.scrollTop = 100;
    expect(scroll.scrollTop).toBeGreaterThan(0);
    renderComposerInto(container, f.props);
    await settled();
    await settled();
    expect(f.input().style.getPropertyValue("--chat-composer-editor-height-limit")).toBe(cap);
    trailing.remove();
    root.className = "chat";
  });
  it.each([900, 400])("keeps the existing embedded composer cap at %ipx height", async (height) => {
    await page.viewport(1440, height);
    renderComposerInto(container, createComposerProps({ draft: "Long draft\n".repeat(100) }));
    const editor = container.querySelector("textarea")!;
    await settled();
    await settled();
    const style = getComputedStyle(editor);
    const sixLines =
      6 * Number.parseFloat(style.lineHeight) +
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom);
    expect(editor.clientHeight).toBeLessThanOrEqual(Math.min(sixLines, height * 0.25) + 1);
    expect(editor.scrollHeight).toBeGreaterThan(editor.clientHeight);
  });
});
