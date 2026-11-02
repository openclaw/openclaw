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
