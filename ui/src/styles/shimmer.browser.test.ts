import { expect, it } from "vitest";
import { withBrowserPage } from "../test-helpers/browser-page.ts";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("shimmer-", { ignoreCloseErrors: true });

const skeletons = [
  "skeleton-line",
  "usage-skeleton-block",
  "memory-import__skeleton",
  "chat-controls__model-trigger-skeleton",
] as const;
const skeletonFixture = styleDocument(
  readStyles(
    "styles/base",
    "styles/chat/layout",
    "styles/chat/composer",
    "styles/memory-import",
    "styles/usage",
  ),
  skeletons.map((name) => `<div class="skeleton ${name}"></div>`).join(""),
);

fixture.describe("Control UI shimmer", () => {
  it.each(["standalone", "gallery"])(
    "clips %s attachment shimmer without clipping status text",
    async (context) => {
      await withBrowserPage(
        fixture.page({ viewport: { width: 390, height: 844 } }),
        async (page) => {
          await page.setContent(
            styleDocument(
              readStyles("styles/base", "styles/chat/message-layout"),
              `<div class="${context === "gallery" ? "chat-message-images--gallery" : ""}"><div class="chat-video-preview"><div class="chat-assistant-attachment-card chat-assistant-attachment-card--blocked">
            <span class="chat-assistant-attachment-card__status-meta skeleton skeleton-line"></span>
            <span class="chat-assistant-attachment-card__status-meta">
              <span class="chat-assistant-attachment-card__status-reason">File unavailable. Retry to load this attachment.</span>
            </span>
          </div></div></div>`,
            ),
          );
          const status = page.locator(".chat-assistant-attachment-card__status-meta");
          expect(
            await status.first().evaluate((element) => getComputedStyle(element).overflow),
          ).toBe("hidden");
          expect(
            await status.last().evaluate((element) => getComputedStyle(element).overflow),
          ).toBe("visible");
        },
      );
    },
  );
  it.each(["no-preference", "reduce"] as const)(
    "keeps skeleton shimmer compositor-safe with motion=%s",
    async (reducedMotion) => {
      await withBrowserPage(fixture.page({ reducedMotion }), async (page) => {
        await page.setContent(skeletonFixture);
        for (const name of skeletons) {
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
              highlightDuration: "2s",
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
          `<style>${readStyles("styles/base", "styles/chat/grouped")}</style><div style="padding:16px;width:360px"><span id="preview">A</span><span class="agent-chat__typing-state agent-chat__typing-text text-shimmer" data-typing>is typing…</span><span id="draft" class="agent-chat__typing-state agent-chat__typing-text">Draft</span><div class="agent-chat__typing-overflow"><span class="agent-chat__typing-identities">${'<span class="agent-chat__typing-person">C</span>'.repeat(count)}</span><span class="agent-chat__typing-summary"><span class="agent-chat__typing-text text-shimmer" data-typing><bdi class="agent-chat__typing-name">Camila</bdi> is typing…</span></span></div><span class="agent-chat__typing-text text-shimmer" data-typing>Several people are typing…</span></div>`,
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
          expect(text.background).toBe("none");
          expect(text.fill).not.toBe("rgba(0, 0, 0, 0)");
        }
      }
    });
  });
  it("keeps the gradient on a row whose own styles reset its background", async () => {
    await withBrowserPage(fixture.page({ reducedMotion: "no-preference" }), async (page) => {
      await page.setContent(
        styleDocument(
          readStyles("styles/base", "styles/chat/tool-cards"),
          `<code class="chat-tool-row__cmd text-shimmer"><span>pnpm check</span></code>`,
        ),
      );
      const image = await page
        .locator(".chat-tool-row__cmd")
        .evaluate((element) => getComputedStyle(element).backgroundImage);
      expect(image).toContain("linear-gradient");
    });
  });
  it("runs both sweeps on paint or compositor properties and stops them in forced colors", async () => {
    await withBrowserPage(fixture.page({ reducedMotion: "no-preference" }), async (page) => {
      await page.setContent(
        styleDocument(
          readStyles("styles/base"),
          `<span id="text" class="text-shimmer">Working</span><div id="block" class="skeleton" style="width:120px;height:12px"></div>`,
        ),
      );
      const read = () =>
        page.evaluate(() => {
          const properties = (element: Element) => [
            ...new Set(
              element.getAnimations({ subtree: true }).flatMap((animation) =>
                (animation.effect as KeyframeEffect)
                  .getKeyframes()
                  .flatMap(Object.keys)
                  .filter(
                    (key) => !["composite", "computedOffset", "easing", "offset"].includes(key),
                  ),
              ),
            ),
          ];
          const text = document.querySelector("#text")!;
          const block = document.querySelector("#block")!;
          const style = getComputedStyle(text);
          const highlight = getComputedStyle(block, "::after");
          return {
            text: style.animationName,
            block: highlight.animationName,
            textProperties: properties(text),
            blockProperties: properties(block),
            parkedX: Number.parseFloat(highlight.transform.split(",")[4] ?? "NaN"),
          };
        });
      expect(await read()).toMatchObject({
        text: "text-shimmer",
        block: "shimmer",
        textProperties: ["backgroundPositionX", "backgroundPositionY"],
        blockProperties: ["transform"],
      });
      await page.emulateMedia({ forcedColors: "active" });
      const forced = await read();
      expect(forced.text).toBe("none");
      expect(forced.block).toBe("none");
      expect(forced.parkedX).toBe(-120);
    });
  });
});
