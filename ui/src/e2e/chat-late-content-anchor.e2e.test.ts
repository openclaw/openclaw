import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat late content anchoring" });
const filler = (from: number) =>
  Array.from({ length: 8 }, (_, index) => ({
    role: "assistant",
    content: `Synthetic filler message ${from + index}. `.repeat(12),
    timestamp: 1000 + (from + index) * 100,
  }));

/** Wait until native scrolling and row measurement stop moving the transcript. */
function settle(thread: Locator): Promise<void> {
  return thread.evaluate(
    (node) =>
      new Promise<void>((resolve) => {
        let last = Number.NaN;
        let still = 0;
        const tick = () => {
          still = node.scrollTop === last ? still + 1 : 0;
          last = node.scrollTop;
          if (still < 10) {
            requestAnimationFrame(tick);
          } else {
            resolve();
          }
        };
        tick();
      }),
  );
}

suite.define(() => {
  it("keeps visible text still when a diagram above it in the same message renders", async () => {
    await suite.withPage(
      { viewport: { width: 1000, height: 700 }, reducedMotion: "reduce" },
      async ({ page }) => {
        const held = await holdModuleResponse(
          page,
          controlUiE2eBuiltModuleRequest("ui/src/components/markdown-mermaid.tsx"),
        );
        const marker = "Reader text below the diagram.";
        const diagram = "flowchart TD\nA[Draft] --> B[Review]\nB --> C[Build]\nC --> D[Ship]";
        await installMockGateway(page, {
          historyMessages: [
            ...filler(0),
            {
              role: "assistant",
              content: "```mermaid\n" + diagram + "\n```\n\n" + marker,
              timestamp: 5000,
            },
            ...filler(10),
          ],
        });
        try {
          await page.goto(suite.server.baseUrl + "chat");
          await page.getByText("Synthetic filler message 17.", { exact: false }).first().waitFor();
          const thread = page.locator(".chat-thread");
          const text = page.getByText(marker, { exact: true });
          for (let step = 0; step < 30 && (await text.count()) === 0; step++) {
            await thread.hover();
            await page.mouse.wheel(0, -250);
            await settle(thread);
          }
          await held.request;
          // The diagram's source block crosses the top edge; the reader's text sits below it.
          await text.evaluate((node) => {
            const scroller = node.closest<HTMLElement>(".chat-thread")!;
            scroller.scrollTop +=
              node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40;
          });
          await settle(thread);
          const threadTop = (await thread.boundingBox())!.y;
          const before = (await text.boundingBox())!.y;
          expect(Math.abs(before - threadTop - 40)).toBeLessThan(2);

          held.release();
          await page.locator("openclaw-mermaid img").first().waitFor({ state: "attached" });
          await settle(thread);
          expect(await text.count()).toBe(1);
          expect(Math.abs((await text.boundingBox())!.y - before)).toBeLessThan(1);
        } finally {
          held.release();
        }
      },
    );
  });
});
