import { createComponent } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { MessageMarkdown } from "../pages/chat/components/chat-message-text-view.tsx";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/chat/startup-layout.css";
import "../styles/chat/text.css";

let scroller: HTMLElement;

afterEach(() => {
  cleanupSolid();
  scroller?.remove();
});

it.each([299, 300, 301, 1200])(
  "keeps code actions available while reading %i source lines",
  async (lines) => {
    scroller = document.body.appendChild(document.createElement("section"));
    scroller.className = "chat-thread";
    scroller.style.cssText = "height:400px;width:600px";
    const message = scroller.appendChild(document.createElement("div"));
    const tail = scroller.appendChild(document.createElement("div"));
    tail.style.height = "500px";
    const source = Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join("\n");
    mountSolid(
      () =>
        createComponent(MessageMarkdown, {
          markdown: `\`\`\`text\n${source}\n\`\`\``,
          messageKey: "long-code",
          options: { role: "assistant", isStreaming: false },
          markdownOptions: { codeBlockInteraction: "interactive" },
        }),
      { container: message },
    );
    flush();
    const copy = message.querySelector<HTMLButtonElement>(".code-block-copy")!;
    const language = message.querySelector<HTMLElement>(".code-block-lang")!;
    const scroll = async (top: number) => {
      scroller.scrollTop = top;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      return copy.getBoundingClientRect();
    };
    const top = scroller.getBoundingClientRect().top;
    const first = await scroll(400);
    const second = await scroll(600);
    expect(language.getBoundingClientRect().bottom).toBeLessThan(top);
    if (lines > 300) {
      expect(first.top - top).toBeGreaterThanOrEqual(0);
      expect(first.top - top).toBeLessThanOrEqual(6);
      expect(second.top).toBeCloseTo(first.top, 0);
    } else {
      expect(first.bottom).toBeLessThan(top);
      expect(second.top).toBeLessThan(first.top);
    }
    const end = await scroll(scroller.scrollHeight);
    expect(end.bottom).toBeLessThanOrEqual(top);
  },
);
