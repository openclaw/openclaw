import { expect, it } from "vitest";
import { withBrowserPage } from "../test-helpers/browser-page.ts";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("shimmer-", { ignoreCloseErrors: true });

const skeletons = [
  ["skeleton-line", "1.5s"],
  ["usage-skeleton-block", "1.35s"],
  ["memory-import__skeleton", "1.4s"],
  ["chat-controls__model-trigger-skeleton", "1.45s"],
] as const;
const skeletonFixture = styleDocument(
  readStyles(
    "styles/base",
    "styles/chat/layout",
    "styles/chat/composer",
    "styles/memory-import",
    "styles/usage",
  ),
  skeletons.map(([name]) => `<div class="skeleton ${name}"></div>`).join(""),
);

fixture.describe("Control UI shimmer", () => {
  it.each(["no-preference", "reduce"] as const)(
    "keeps skeleton shimmer compositor-safe with motion=%s",
    async (reducedMotion) => {
      await withBrowserPage(fixture.page({ reducedMotion }), async (page) => {
        await page.setContent(skeletonFixture);
        for (const [name, duration] of skeletons) {
          const styles = await page.locator("." + name).evaluate((element) => {
            const host = getComputedStyle(element);
            const highlight = getComputedStyle(element, "::after");
            const animations = element.getAnimations({ subtree: true });
            const effect = animations[0]?.effect;
            const keyframes = effect instanceof KeyframeEffect ? effect.getKeyframes() : [];
            return {
              host: [host.animationName, host.backgroundImage, host.overflow],
              highlight: [highlight.animationName, highlight.animationIterationCount],
              highlightBackground: highlight.backgroundImage,
              highlightDuration: highlight.animationDuration,
              highlightWillChange: highlight.willChange,
              animatedProperties: [...new Set(keyframes.flatMap(Object.keys))].filter(
                (key) => !["composite", "computedOffset", "easing", "offset"].includes(key),
              ),
              running: animations.some((item) => item.playState === "running"),
              settledX: Number.parseFloat(highlight.transform.split(",")[4] ?? "NaN"),
              width: element.clientWidth,
            };
          });
          if (reducedMotion === "reduce") {
            expect(styles).toMatchObject({ highlight: ["none", "1"], running: false });
            expect(Number.parseFloat(styles.highlightDuration)).toBeLessThanOrEqual(0.00001);
            expect(Math.abs(styles.settledX + styles.width)).toBeLessThanOrEqual(1);
          } else {
            expect(styles).toMatchObject({
              host: ["none", "none", "hidden"],
              highlight: ["shimmer", "infinite"],
              highlightDuration: duration,
              highlightWillChange: "transform",
              animatedProperties: ["transform"],
            });
            expect(styles.highlightBackground).toContain("linear-gradient");
          }
        }
      });
    },
  );
  it("aligns intrinsic typing stacks and shimmers only active text, including names", async () => {
    await withBrowserPage(fixture.page({ reducedMotion: "no-preference" }), async (page) => {
      for (const count of [1, 2, 5]) {
        await page.setContent(
          `<style>${readStyles("styles/base", "styles/chat/grouped")}</style><div style="padding:16px;width:360px"><span id="preview">A</span><span class="agent-chat__typing-state agent-chat__typing-text" data-typing>is typing…</span><span id="draft" class="agent-chat__typing-state agent-chat__typing-text">Draft</span><div class="agent-chat__typing-overflow"><span class="agent-chat__typing-identities">${'<span class="agent-chat__typing-person">C</span>'.repeat(count)}</span><span class="agent-chat__typing-summary"><span class="agent-chat__typing-text" data-typing><bdi class="agent-chat__typing-name">Camila</bdi> is typing…</span></span></div><span class="agent-chat__typing-text" data-typing>Several people are typing…</span></div>`,
        );
        const result = await page.evaluate(() => {
          const element = (selector: string) => {
            const found = document.querySelector(selector);
            if (!found) {
              throw new Error(`Missing typing fixture: ${selector}`);
            }
            return found;
          };
          const rect = (selector: string) => element(selector).getBoundingClientRect();
          return {
            offset: rect(".agent-chat__typing-person").x - rect("#preview").x,
            gap:
              rect(".agent-chat__typing-summary").x - rect(".agent-chat__typing-identities").right,
            width: rect(".agent-chat__typing-identities").width,
            animated: [...document.querySelectorAll(".agent-chat__typing-text[data-typing]")].map(
              (e) => getComputedStyle(e).animationName,
            ),
            draftAnimation: getComputedStyle(element("#draft")).animationName,
            nameFill: getComputedStyle(element(".agent-chat__typing-name")).webkitTextFillColor,
            avatarAnimations: element(".agent-chat__typing-person").getAnimations({ subtree: true })
              .length,
          };
        });
        expect(result).toMatchObject({
          offset: 0,
          gap: 8,
          width: 20 + (count - 1) * 14,
          animated: ["text-shimmer", "text-shimmer", "text-shimmer"],
          draftAnimation: "none",
          nameFill: "rgba(0, 0, 0, 0)",
          avatarAnimations: 0,
        });
      }
      for (const media of [
        { reducedMotion: "reduce" },
        { reducedMotion: "no-preference", forcedColors: "active" },
      ] as const) {
        await page.emulateMedia(media);
        const texts = await page.locator(".agent-chat__typing-text").evaluateAll((elements) =>
          elements.map((e) => ({
            animation: getComputedStyle(e).animationName,
            background: getComputedStyle(e).backgroundImage,
            fill: getComputedStyle(e).webkitTextFillColor,
          })),
        );
        for (const text of texts) {
          expect(text.animation).toBe("none");
          if (media.reducedMotion === "reduce") {
            expect(text.background).toBe("none");
          }
          expect(text.fill).not.toBe("rgba(0, 0, 0, 0)");
        }
      }
    });
  });
});
