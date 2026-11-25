import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { MessageMarkdown } from "../pages/chat/components/chat-message-text-view.tsx";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { handleMarkdownCodeBlockClick } from "./markdown-code-blocks.ts";
import { markdownBlocksRef } from "./markdown-element-refs-solid.ts";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/chat/startup-layout.css";
import "../styles/chat/text.css";
import "../styles/layout.mobile.css";

afterEach(cleanupSolid);

it("reserves the hidden wrap control without exposing it to keyboard or accessibility", async () => {
  const view = mountSolid(() => (
    <section ref={markdownBlocksRef(() => true)} onClick={handleMarkdownCodeBlockClick}>
      <MessageMarkdown
        markdown={
          "```text\nA moderately long line that only overflows the narrow code viewport.\n```"
        }
        messageKey="wrap-slot"
        options={{ role: "assistant", isStreaming: false }}
        markdownOptions={{ codeBlockInteraction: "interactive" }}
      />
    </section>
  ));
  view.container.style.width = "1000px";
  flush();
  const wrap = view.container.querySelector<HTMLButtonElement>(".code-block-wrap")!;
  const actions = view.container.querySelector<HTMLElement>(".code-block-actions")!;
  const copy = view.container.querySelector<HTMLButtonElement>(".code-block-copy")!;
  await expect.poll(() => wrap.checkVisibility({ visibilityProperty: true })).toBe(false);
  copy.focus();
  wrap.focus();
  expect(document.activeElement).toBe(copy);
  expect(page.getByRole("button", { name: "Enable word wrap" }).all()).toHaveLength(0);
  const reservedWidth = actions.getBoundingClientRect().width;
  view.container.style.width = "240px";
  await expect.poll(() => wrap.checkVisibility({ visibilityProperty: true })).toBe(true);
  expect(actions.getBoundingClientRect().width).toBe(reservedWidth);
  await page.getByRole("button", { name: "Enable word wrap" }).click();
  expect(wrap.getAttribute("aria-pressed")).toBe("true");
  expect(wrap.getAttribute("aria-label")).toBe("Disable word wrap");
});

it("highlights the remaining source after native expansion of a settled long fence", async () => {
  const source = "let x;\n".repeat(400);
  const view = mountSolid(() => (
    <section
      class="chat-thread"
      style={{ height: "400px", width: "600px" }}
      ref={markdownBlocksRef(() => true)}
      onClick={handleMarkdownCodeBlockClick}
    >
      <MessageMarkdown
        markdown={`\`\`\`ts\n${source}\`\`\``}
        messageKey="native-highlight-expand"
        options={{ role: "assistant", isStreaming: false }}
        markdownOptions={{ codeBlockInteraction: "interactive" }}
      />
    </section>
  ));
  flush();
  const code = view.container.querySelector("code")!;
  // The first visible fence starts the native worker and loads its grammar.
  await expect
    .poll(() => code.querySelectorAll(".hljs-keyword").length, { timeout: 5_000 })
    .toBe(7);
  await page.getByRole("button", { name: /Show \d+ hidden lines/ }).click();
  await expect.poll(() => code.querySelectorAll(".hljs-keyword").length).toBe(400);
  expect(code.textContent).toBe(source);
});
