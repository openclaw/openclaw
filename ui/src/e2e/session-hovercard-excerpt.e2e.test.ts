import { expect, it } from "vitest";
import { sessionRow } from "./chat-flow-fixtures.test-support.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import { sessionPerson } from "./session-ownership-fixtures.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("renders only what fits three lines of an excerpt, with nothing past them to reach", async () => {
    const selectedSessionKey = "agent:main:selected-excerpt";
    const shortKey = "agent:main:excerpt-short";
    const longKey = "agent:main:excerpt-long";
    const paragraphsKey = "agent:main:excerpt-paragraphs";
    const shortPreview = "Merged and deployed.";
    const longPreview = `${"Review the launch notes and agree on the release window. ".repeat(6)}Tail sentence.`;
    const paragraphsPreview = `First paragraph of the update.\n\n${"The second paragraph keeps going with more detail. ".repeat(4)}\n\n- A list item\n\nTail sentence.`;
    const excerptRow = (key: string, title: string, updatedAt: number, preview: string) => ({
      ...sessionRow(key, title, updatedAt),
      createdActor: sessionPerson("profile-ada", "Ada King"),
      lastMessagePreview: preview,
    });

    await suite.withPage(
      { hasTouch: false, ...createControlUiE2eContextOptions() },
      async ({ page }) => {
        await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          historyMessages: [
            {
              role: "assistant",
              timestamp: 1,
              content: [{ type: "text", text: `Open ${longKey} for the last message.` }],
            },
          ],
          methodResponses: {
            "progressCard.get": { card: null },
            "sessions.list": chatSessionListResponse([
              sessionRow(selectedSessionKey, "Selected session", 4),
              excerptRow(shortKey, "Short excerpt", 3, shortPreview),
              excerptRow(longKey, "Long excerpt", 2, longPreview),
              excerptRow(paragraphsKey, "Paragraphs excerpt", 1, paragraphsPreview),
            ]),
          },
          sessionKey: selectedSessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
        const excerpt = page.locator(".session-progress-hovercard .session-hovercard__excerpt");
        const hoverRow = async (key: string, title: string) => {
          const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
          await row.waitFor({ state: "visible" });
          await row.hover();
          await expect
            .poll(() =>
              page.locator(".session-progress-hovercard .session-hovercard__title").textContent(),
            )
            .toBe(title);
          await excerpt.waitFor({ state: "visible" });
          return row;
        };
        const measure = () =>
          excerpt.evaluate((node) => {
            const style = getComputedStyle(node);
            return {
              cardHeight: node.closest(".session-progress-hovercard")?.getBoundingClientRect()
                .height,
              childElements: node.childElementCount,
              childNodes: node.childNodes.length,
              clientHeight: node.clientHeight,
              height: node.getBoundingClientRect().height,
              lineHeight: Number.parseFloat(style.lineHeight),
              maskImage: style.maskImage,
              scrollHeight: node.scrollHeight,
              text: node.textContent ?? "",
            };
          });

        await hoverRow(shortKey, "Short excerpt");
        const short = await measure();
        expect(short).toMatchObject({
          childElements: 0,
          childNodes: 1,
          height: short.lineHeight,
          maskImage: "none",
          scrollHeight: short.clientHeight,
          text: shortPreview,
        });

        await hoverRow(paragraphsKey, "Paragraphs excerpt");
        const paragraphs = await measure();
        await hoverRow(longKey, "Long excerpt");
        const long = await measure();
        for (const [cut, source] of [
          [paragraphs, paragraphsPreview],
          [long, longPreview],
        ] as const) {
          expect(cut).toMatchObject({
            childElements: 0,
            childNodes: 1,
            height: cut.lineHeight * 3,
            maskImage: "none",
            scrollHeight: cut.clientHeight,
          });
          expect(cut.text.endsWith("…")).toBe(true);
          expect(cut.text).not.toContain("Tail sentence");
          expect(source.replace(/\s+/g, " ").startsWith(cut.text.slice(0, -1))).toBe(true);
        }
        expect(paragraphs.cardHeight).toBe(long.cardHeight);

        await page
          .locator(`.sidebar-recent-session[data-session-key="${longKey}"]`)
          .locator(".sidebar-recent-session__link")
          .focus();
        await page.keyboard.press("Tab");
        const focused = () =>
          page.evaluate(() => ({
            inCard: Boolean(document.activeElement?.closest(".session-progress-hovercard")),
            inExcerpt: Boolean(document.activeElement?.closest(".session-hovercard__excerpt")),
          }));
        expect(await focused()).toEqual({ inCard: true, inExcerpt: false });
        await page.keyboard.press("Tab");
        expect(await focused()).toEqual({ inCard: false, inExcerpt: false });
        const row = page.locator(
          `.chat-thread a.markdown-session-link[data-session-key="${longKey}"]`,
        );
        await row.hover();
        await excerpt.waitFor({ state: "visible" });
        await row.focus();
        await page.setViewportSize({ width: 320, height: 900 });
        await expect.poll(() => excerpt.textContent()).not.toBe(long.text);
        const narrow = await measure();
        expect(narrow.scrollHeight).toBe(narrow.clientHeight);
        expect(narrow.text.length).toBeLessThan(long.text.length);
        await page.setViewportSize({ width: 1280, height: 900 });
        await expect.poll(() => excerpt.textContent()).toBe(long.text);
      },
    );
  });
});
