import { expect, it } from "vitest";
import { SIDEBAR_GEOMETRY_COMMIT_EVENT } from "../pages/chat/sidebar-layout.ts";
import {
  controlUiBundledSettingsStorageKey,
  createControlUiMockSameOriginGatewayScript,
} from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProof,
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each(["dark", "light"] as const)(
    "tracks reader position and keyboard jumps in %s mode",
    async (colorScheme) => {
      await suite.withPage(
        {
          colorScheme,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1440 },
          ...(captureUiProofEnabled
            ? { recordVideo: { dir: suite.artifactDir, size: { height: 900, width: 1440 } } }
            : {}),
        },
        async ({ page }) => {
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          const messages = Array.from({ length: 240 }, (_, index) => ({
            __openclaw: { id: `position-rail-${index}`, seq: index + 1 },
            content:
              index === 0
                ? [
                    {
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: "image/png",
                        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=",
                      },
                    },
                  ]
                : [{ text: `Transcript checkpoint ${index}`, type: "text" }],
            role: index % 2 === 0 ? "user" : "assistant",
            timestamp: Date.UTC(2026, 8, 4, 12, index),
          }));
          await installMockGateway(page, { historyMessages: messages });
          await page.addInitScript(createControlUiMockSameOriginGatewayScript());
          await page.addInitScript(
            ({ key, mode }) => {
              localStorage.setItem(
                key,
                JSON.stringify({
                  ...JSON.parse(localStorage.getItem(key) ?? "{}"),
                  theme: mode,
                  themeMode: mode,
                }),
              );
            },
            { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), mode: colorScheme },
          );
          await page.goto(`${suite.server.baseUrl}chat`);
          const transcript = page.locator(".chat-thread");
          await transcript
            .locator(".chat-virtual-row")
            .getByText("Transcript checkpoint 239", { exact: true })
            .waitFor();

          const rail = page.locator(".chat-position-rail");
          const markers = rail.locator(".chat-position-rail__marker");
          const preview = rail.locator(".chat-position-rail__preview-copy");
          await markers.first().waitFor();
          await expect.poll(() => markers.count()).toBe(32);
          const track = rail.locator(".chat-position-rail__track");
          const trackBounds = (await track.boundingBox())!;
          const transcriptBounds = (await transcript.boundingBox())!;
          const contentBounds = (await transcript.locator(".chat-thread-inner").boundingBox())!;
          expect(trackBounds.x).toBeGreaterThanOrEqual(transcriptBounds.x);
          expect(trackBounds.x + trackBounds.width).toBeLessThan(contentBounds.x);
          expect(trackBounds.height).toBeCloseTo(256, 2);
          expect(
            Math.abs(
              trackBounds.y +
                trackBounds.height / 2 -
                (transcriptBounds.y + transcriptBounds.height / 2),
            ),
          ).toBeLessThan(2);
          const markBounds = await markers.evaluateAll((items) =>
            items.map((item) => item.getBoundingClientRect().toJSON()),
          );
          for (let index = 1; index < markBounds.length; index++) {
            expect(markBounds[index]!.y - markBounds[index - 1]!.y).toBeGreaterThanOrEqual(6);
            expect(markBounds[index]!.y).toBeCloseTo(markBounds[index - 1]!.bottom, 2);
          }
          expect(await markers.first().getAttribute("aria-label")).toContain("1 of 240");
          expect(await markers.last().getAttribute("aria-label")).toContain("240 of 240");
          expect(await preview.count()).toBe(0);
          expect(await rail.locator('[role="status"]').count()).toBe(0);
          await captureUiProof(suite, page, "chat-position-rail", "idle.png");

          const currentMarkerIndex = () =>
            markers.evaluateAll((items) =>
              items.findIndex((item) => item.getAttribute("aria-current") === "true"),
            );
          await transcript.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          await expect.poll(currentMarkerIndex).toBe(31);
          await transcript.evaluate((element) => {
            element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) / 2);
          });
          await expect.poll(currentMarkerIndex).toBeGreaterThan(0);
          await expect.poll(currentMarkerIndex).toBeLessThan(31);
          await transcript.evaluate((element) => {
            element.scrollTop = 0;
          });
          await expect.poll(currentMarkerIndex).toBe(0);

          const composer = page.locator(".agent-chat__composer-combobox textarea");
          await composer.focus();
          await markers.nth(4).hover();
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 31");
          await expect
            .poll(() =>
              markers
                .nth(4)
                .evaluate((marker) =>
                  Number.parseFloat(
                    getComputedStyle(marker.querySelector(".chat-position-rail__tick")!).width,
                  ),
                ),
            )
            .toBe(16);
          const hoveredAppearance = await markers.nth(4).evaluate((marker) => {
            const tick = marker.querySelector(".chat-position-rail__tick")!;
            const style = getComputedStyle(tick);
            return {
              color: style.backgroundColor,
              width: Number.parseFloat(style.width),
              height: Number.parseFloat(style.height),
              ring: style.boxShadow,
            };
          });
          expect(hoveredAppearance.width).toBe(16);
          expect(hoveredAppearance.height).toBe(2);
          expect(hoveredAppearance.ring).toBe("none");
          const activeColor = () =>
            rail
              .locator('[aria-current="true"] .chat-position-rail__tick')
              .evaluate((element) => getComputedStyle(element).backgroundColor);
          expect(hoveredAppearance.color).toBe(await activeColor());
          expect(
            await markers
              .nth(5)
              .locator(".chat-position-rail__tick")
              .evaluate((element) => getComputedStyle(element).backgroundColor),
          ).toBe(await activeColor());
          await captureUiProof(suite, page, "chat-position-rail", "scroll-follow-hover.png");

          const previewBounds = await preview.boundingBox();
          expect(previewBounds).not.toBeNull();
          await page.mouse.move(
            previewBounds!.x + previewBounds!.width / 2,
            previewBounds!.y + previewBounds!.height / 2,
            { steps: 20 },
          );
          expect(await preview.textContent()).toContain("Transcript checkpoint 31");
          await captureUiProof(suite, page, "chat-position-rail", "hover-reading.png");
          await page.keyboard.press("Escape");
          await expect.poll(() => preview.count()).toBe(0);
          expect(await composer.evaluate((element) => element === document.activeElement)).toBe(
            true,
          );

          await page.mouse.move(600, 100);
          await markers.nth(4).hover();
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 31");
          await page.mouse.move(600, 100);
          await expect.poll(() => preview.count()).toBe(0);
          await expect
            .poll(async () =>
              markers
                .nth(4)
                .locator(".chat-position-rail__tick")
                .evaluate((element) => Number.parseFloat(getComputedStyle(element).width)),
            )
            .toBe(8);
          expect(
            await markers
              .nth(4)
              .locator(".chat-position-rail__tick")
              .evaluate((element) => getComputedStyle(element).backgroundColor),
          ).not.toBe(await activeColor());
          await markers.first().hover();
          const skeleton = rail.locator(".chat-position-rail__preview-skeleton");
          await skeleton.waitFor();
          expect(await skeleton.boundingBox()).not.toBeNull();
          await page.mouse.move(600, 100);
          await markers.nth(5).focus();
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 39");
          await markers.nth(5).press("ArrowDown");
          await expect
            .poll(() =>
              page.evaluate(
                () => document.activeElement?.getAttribute("data-position-marker-id") ?? null,
              ),
            )
            .toBe("position-rail-46");
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 46");
          await markers.nth(6).click();
          const revealed = transcript.locator('.chat-bubble[data-entry-id="position-rail-46"]');
          await expect
            .poll(() =>
              revealed.evaluate((element) => {
                const viewport = element.closest(".chat-thread")!.getBoundingClientRect();
                const bubble = element.getBoundingClientRect();
                return bubble.top >= viewport.top && bubble.bottom <= viewport.bottom;
              }),
            )
            .toBe(true);
          await captureUiProof(suite, page, "chat-position-rail", "keyboard-jump.png");
          await markers.nth(6).press("Escape");
          await expect.poll(() => preview.count()).toBe(0);
          await markers.nth(6).press("Home");
          await expect
            .poll(() => markers.first().evaluate((element) => element === document.activeElement))
            .toBe(true);
          await markers.first().press(" ");
          await expect.poll(currentMarkerIndex).toBe(0);
          await markers.first().press("End");
          await markers.last().press("Enter");
          await expect.poll(currentMarkerIndex).toBe(31);

          // Pane-local width matters even inside an otherwise wide desktop.
          await transcript.evaluate((element) => {
            element.style.width = "800px";
          });
          await markers.first().waitFor({ state: "hidden" });
          await transcript.evaluate((element) => {
            element.style.removeProperty("width");
          });
          await markers.first().waitFor({ state: "visible" });

          await page.setViewportSize({ height: 900, width: 900 });
          await markers.first().waitFor({ state: "hidden" });
          await captureUiProof(suite, page, "chat-position-rail", "narrow-pane.png");
          await page.setViewportSize({ height: 844, width: 390 });
          await markers.first().waitFor({ state: "hidden" });
          await captureUiProof(suite, page, "chat-position-rail", "mobile.png");
          await page.setViewportSize({ height: 900, width: 1440 });
          await markers.first().waitFor({ state: "visible" });
          await page.emulateMedia({ reducedMotion: "reduce" });
          expect(
            await markers
              .first()
              .locator(".chat-position-rail__tick")
              .evaluate((element) =>
                Number.parseFloat(getComputedStyle(element).transitionDuration),
              ),
          ).toBeLessThanOrEqual(0.00001); // Global reduced-motion policy uses 0.01ms.

          // Saved widths can consume the gutter even in a wide desktop pane.
          for (const width of ["100%", "none", "95%", "48rem"]) {
            await page.goto(`${suite.server.baseUrl}settings/appearance#settings-appearance-chat`);
            const widthInput = page.locator("[data-settings-chat-message-width]");
            await widthInput.fill(width);
            await widthInput.press("Tab");
            await expect
              .poll(() =>
                page.evaluate(
                  (key) => JSON.parse(localStorage.getItem(key) ?? "{}").chatMessageMaxWidth,
                  controlUiBundledSettingsStorageKey(suite.server.baseUrl),
                ),
              )
              .toBe(width);
            await page.goto(`${suite.server.baseUrl}chat`);
            await transcript.locator('.chat-bubble[data-entry-id="position-rail-239"]').waitFor();
            await expect
              .poll(() =>
                transcript.evaluate((element) =>
                  getComputedStyle(element).getPropertyValue("--chat-thread-max-width").trim(),
                ),
              )
              .toBe(width);
            await markers.first().waitFor({ state: width === "48rem" ? "visible" : "hidden" });
            if (width === "48rem") {
              const inner = await transcript.locator(".chat-thread-inner").boundingBox();
              const marker = await markers.first().boundingBox();
              expect(inner!.x - (marker!.x + marker!.width)).toBeGreaterThanOrEqual(10);
            }
            await captureUiProof(
              suite,
              page,
              "chat-position-rail",
              `saved-width-${width.replace("%", "percent")}.png`,
            );
          }
          // A foreign-host commit can change the inner column while the pane's
          // own dimensions stay fixed. Exercise that existing event boundary.
          for (const width of ["95%", "48rem"]) {
            await transcript.evaluate(
              (element, { columnWidth, eventName }) => {
                element.style.setProperty("--chat-thread-max-width", columnWidth);
                element.dispatchEvent(
                  new CustomEvent(eventName, {
                    bubbles: true,
                    detail: { widthChanged: false },
                  }),
                );
              },
              { columnWidth: width, eventName: SIDEBAR_GEOMETRY_COMMIT_EVENT },
            );
            await markers.first().waitFor({ state: width === "48rem" ? "visible" : "hidden" });
          }
          await transcript.evaluate((element) =>
            element.style.removeProperty("--chat-thread-max-width"),
          );
          expect(pageErrors).toEqual([]);
        },
      );
    },
  );
});
