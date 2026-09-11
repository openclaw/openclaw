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
                : [
                    {
                      text:
                        index === 1
                          ? "![Preview](data:image/gif;base64,R0lGODlhAAQABIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)"
                          : `Transcript **checkpoint ${index}** with \`code\` and *emphasis*.`,
                      type: "text",
                    },
                  ],
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
            .getByText("Transcript checkpoint 239 with code and emphasis.", { exact: true })
            .waitFor();

          const rail = page.locator(".chat-position-rail");
          const markers = rail.locator(".chat-position-rail__marker");
          const preview = rail.locator(".chat-position-rail__preview-copy");
          await markers.first().waitFor();
          await expect.poll(() => markers.count()).toBe(240);
          const track = rail.locator(".chat-position-rail__track");
          const trackBounds = (await track.boundingBox())!;
          const transcriptBounds = (await transcript.boundingBox())!;
          const contentBounds = (await transcript.locator(".chat-thread-inner").boundingBox())!;
          expect(trackBounds.x).toBeGreaterThanOrEqual(transcriptBounds.x);
          expect(trackBounds.x + trackBounds.width).toBeLessThan(contentBounds.x);
          expect(trackBounds.height).toBeCloseTo(900 * 0.45, 2);
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
          expect(Math.min(...markBounds.map((bounds) => bounds.width))).toBeGreaterThanOrEqual(44);
          for (let index = 1; index < markBounds.length; index++) {
            expect(markBounds[index]!.y - markBounds[index - 1]!.y).toBeCloseTo(12, 2);
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
          const scroller = rail.locator(".chat-position-rail__marks");
          const fades = () =>
            scroller.evaluate((element) => ({
              top: element.hasAttribute("data-overflow-top"),
              bottom: element.hasAttribute("data-overflow-bottom"),
            }));
          const currentIsVisible = () =>
            scroller.evaluate((element) => {
              const current = element
                .querySelector('[aria-current="true"]')!
                .getBoundingClientRect();
              const viewport = element.getBoundingClientRect();
              return current.top >= viewport.top && current.bottom <= viewport.bottom;
            });
          const strokeSizes = () =>
            markers.evaluateAll((items) => [
              ...new Set(
                items.map((item) => {
                  const style = getComputedStyle(item.querySelector(".chat-position-rail__tick")!);
                  return `${style.width} × ${style.height}`;
                }),
              ),
            ]);
          await page.mouse.move(700, 80);
          await expect.poll(strokeSizes).toEqual(["8px × 2px"]);
          const colors = await rail.evaluate((element) => {
            const probe = document.createElement("span");
            element.append(probe);
            probe.style.color = "var(--muted)";
            const muted = getComputedStyle(probe).color;
            probe.style.color = "var(--text)";
            const text = getComputedStyle(probe).color;
            probe.remove();
            return { muted, text };
          });
          const strokeColor = (index: number) =>
            markers
              .nth(index)
              .locator(".chat-position-rail__tick")
              .evaluate((element) => getComputedStyle(element).backgroundColor);
          const visibilityMatchesViewport = () =>
            transcript.evaluate((element) => {
              const viewport = element.getBoundingClientRect();
              const covered =
                Number.parseFloat(
                  getComputedStyle(element).getPropertyValue("--chat-transcript-composer-underlap"),
                ) || 0;
              const marks = [
                ...element.querySelectorAll<HTMLElement>(".chat-position-rail__marker"),
              ];
              const ids = new Set(marks.map((mark) => mark.dataset.positionMarkerId));
              const expected = [
                ...element.querySelectorAll<HTMLElement>(".chat-bubble[data-entry-id]"),
              ]
                .filter((bubble) => {
                  const rect = bubble.getBoundingClientRect();
                  return (
                    ids.has(bubble.dataset.entryId) &&
                    rect.height > 0 &&
                    rect.bottom > viewport.top &&
                    rect.top < viewport.bottom - covered
                  );
                })
                .map((bubble) => bubble.dataset.entryId);
              const actual = new Set(
                marks
                  .filter((mark) => mark.hasAttribute("data-visible"))
                  .map((mark) => mark.dataset.positionMarkerId),
              );
              return (
                expected.length > 1 &&
                expected.length === actual.size &&
                expected.every((id) => actual.has(id))
              );
            });
          await expect.poll(visibilityMatchesViewport).toBe(true);
          const firstMarkerNode = await markers.first().elementHandle();
          await expect.poll(currentMarkerIndex).toBe(239);
          expect(await strokeColor(0)).toMatch(/\/ 0\.4\)$/);
          expect(await strokeColor(239)).toBe(colors.muted);
          await expect.poll(fades).toEqual({ top: true, bottom: false });
          await expect.poll(currentIsVisible).toBe(true);
          await transcript.evaluate((element) => {
            element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) / 2);
          });
          await expect.poll(currentMarkerIndex).toBeGreaterThan(50);
          await expect.poll(currentMarkerIndex).toBeLessThan(200);
          await expect.poll(fades).toEqual({ top: true, bottom: true });
          await expect.poll(visibilityMatchesViewport).toBe(true);
          expect(await firstMarkerNode!.evaluate((element) => element.isConnected)).toBe(true);
          await expect.poll(currentIsVisible).toBe(true);
          await captureUiProof(suite, page, "chat-position-rail", "stress-both-fades.png");

          // Crossing the midpoint can change the anchor while the visible cohort stays fixed.
          const crossingOffset = await transcript.evaluate((element) => {
            const row = element
              .querySelector('[data-entry-id="position-rail-121"]')!
              .closest(".chat-virtual-row")!;
            return (
              element.scrollTop +
              row.getBoundingClientRect().top -
              element.getBoundingClientRect().top -
              element.clientHeight / 2
            );
          });
          const visibleMarkerIds = () =>
            markers.evaluateAll((items) =>
              items
                .filter((item) => item.hasAttribute("data-visible"))
                .map((item) => item.getAttribute("data-position-marker-id")),
            );
          await transcript.evaluate((element, offset) => {
            element.scrollTop = offset - 2;
          }, crossingOffset);
          await expect.poll(currentMarkerIndex).toBe(120);
          await expect.poll(visibilityMatchesViewport).toBe(true);
          const cohort = await visibleMarkerIds();
          await transcript.evaluate((element, offset) => {
            element.scrollTop = offset + 2;
          }, crossingOffset);
          await expect.poll(currentMarkerIndex).toBe(121);
          expect(await visibleMarkerIds()).toEqual(cohort);
          await transcript.evaluate((element, offset) => {
            element.scrollTop = offset - 2;
          }, crossingOffset);
          await expect.poll(currentMarkerIndex).toBe(120);
          expect(await visibleMarkerIds()).toEqual(cohort);

          // Wheel exploration stays within the rail and does not snap back to the active mark.
          const readerOffset = await transcript.evaluate((element) => element.scrollTop);
          await scroller.hover();
          await page.mouse.wheel(0, -6000);
          await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
          await expect.poll(fades).toEqual({ top: false, bottom: true });
          await markers.nth(1).hover();
          const previewImage = preview.locator("img");
          await expect
            .poll(() => previewImage.evaluate((image: HTMLImageElement) => image.naturalHeight))
            .toBe(1024);
          expect(
            await preview.evaluate(
              (element) =>
                element.getBoundingClientRect().height /
                Number.parseFloat(getComputedStyle(element).lineHeight),
            ),
          ).toBeLessThanOrEqual(3.01);
          await page.mouse.move(600, 100);

          await markers.nth(4).hover();
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 4");
          expect(await preview.locator("strong").textContent()).toBe("checkpoint 4");
          expect(await preview.locator("code").textContent()).toBe("code");
          expect(await preview.locator("em").textContent()).toBe("emphasis");
          expect(await transcript.evaluate((element) => element.scrollTop)).toBe(readerOffset);
          expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
          // Pointer focus must not move an edge mark before its click completes.
          await scroller.evaluate((element) => {
            element.scrollTop = element.querySelector<HTMLElement>(
              '[data-position-marker-id="position-rail-60"]',
            )!.offsetTop;
          });
          const edgeBounds = (await markers.nth(60).boundingBox())!;
          await page.mouse.move(edgeBounds.x + 5, edgeBounds.y + edgeBounds.height / 2);
          await page.mouse.down();
          const pressedBounds = (await markers.nth(60).boundingBox())!;
          await page.mouse.up();
          expect(pressedBounds.y).toBeCloseTo(edgeBounds.y, 2);
          const edgeTarget = transcript.locator('.chat-bubble[data-entry-id="position-rail-60"]');
          await expect
            .poll(() =>
              edgeTarget.evaluate((element) => {
                const viewport = element.closest(".chat-thread")!.getBoundingClientRect();
                const bubble = element.getBoundingClientRect();
                return bubble.top >= viewport.top && bubble.bottom <= viewport.bottom;
              }),
            )
            .toBe(true);
          await page.mouse.move(700, 80);
          await transcript.evaluate((element) => {
            element.scrollTop = 0;
          });
          await expect.poll(currentMarkerIndex).toBeLessThan(10);
          await expect.poll(currentIsVisible).toBe(true);

          const composer = page.locator(".agent-chat__composer-combobox textarea");
          await composer.focus();
          const strokeColors = () =>
            markers.evaluateAll((items) =>
              items.map(
                (item) =>
                  getComputedStyle(item.querySelector(".chat-position-rail__tick")!)
                    .backgroundColor,
              ),
            );
          const restingColors = await strokeColors();
          await markers.nth(4).hover();
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 4");
          await expect
            .poll(() =>
              markers.evaluateAll((items) =>
                items
                  .slice(0, 9)
                  .map((item) =>
                    Number.parseFloat(
                      getComputedStyle(item.querySelector(".chat-position-rail__tick")!).width,
                    ),
                  ),
              ),
            )
            .toEqual([8, 12, 16, 24, 32, 24, 16, 12, 8]);
          await expect
            .poll(strokeColors)
            .toEqual(restingColors.map((color, index) => (index === 4 ? colors.text : color)));
          await captureUiProof(suite, page, "chat-position-rail", "scroll-follow-hover.png");

          const previewBounds = await preview.boundingBox();
          expect(previewBounds).not.toBeNull();
          await page.mouse.move(
            previewBounds!.x + previewBounds!.width / 2,
            previewBounds!.y + previewBounds!.height / 2,
            { steps: 20 },
          );
          expect(await preview.textContent()).toContain("Transcript checkpoint 4");
          await captureUiProof(suite, page, "chat-position-rail", "hover-reading.png");
          await page.keyboard.press("Escape");
          await expect.poll(() => preview.count()).toBe(0);
          expect(await composer.evaluate((element) => element === document.activeElement)).toBe(
            true,
          );

          await page.mouse.move(600, 100);
          await markers.nth(4).hover();
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 4");
          await page.mouse.move(600, 100);
          await expect.poll(() => preview.count()).toBe(0);
          await expect.poll(strokeSizes).toEqual(["8px × 2px"]);
          await expect.poll(visibilityMatchesViewport).toBe(true);
          await markers.first().hover();
          await expect
            .poll(async () => (await preview.textContent())?.trim())
            .toBe("Preview unavailable");
          expect(await preview.boundingBox()).not.toBeNull();
          await page.mouse.move(600, 100);
          await markers.nth(5).focus();
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 5");
          await markers.nth(5).press("ArrowDown");
          await expect
            .poll(() =>
              page.evaluate(
                () => document.activeElement?.getAttribute("data-position-marker-id") ?? null,
              ),
            )
            .toBe("position-rail-6");
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 6");
          expect(
            await markers
              .nth(6)
              .locator(".chat-position-rail__tick")
              .evaluate((element) => getComputedStyle(element).width),
          ).toBe("8px");
          await markers.nth(120).focus();
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 120");
          expect(await transcript.evaluate((element) => element.scrollTop)).toBe(0);
          const focusedBounds = (await markers.nth(120).boundingBox())!;
          const scrollBounds = (await scroller.boundingBox())!;
          expect(focusedBounds.y).toBeGreaterThan(scrollBounds.y + 60);
          expect(focusedBounds.y + focusedBounds.height).toBeLessThan(
            scrollBounds.y + scrollBounds.height - 60,
          );
          const flashPaint = (index: number) =>
            transcript
              .locator(`.chat-bubble[data-entry-id="position-rail-${index}"]`)
              .evaluate((element) => {
                const overlay = getComputedStyle(element, "::after");
                return {
                  visible: overlay.content !== "none" && Number.parseFloat(overlay.opacity) > 0,
                  animated: overlay.animationName !== "none",
                  outline: getComputedStyle(element).outlineStyle,
                };
              });
          for (const index of [120, 121]) {
            await markers.nth(index).click();
            const revealed = transcript.locator(
              `.chat-bubble[data-entry-id="position-rail-${index}"]`,
            );
            await expect
              .poll(() =>
                revealed.evaluate((element) => {
                  const viewport = element.closest(".chat-thread")!.getBoundingClientRect();
                  const bubble = element.getBoundingClientRect();
                  return bubble.top >= viewport.top && bubble.bottom <= viewport.bottom;
                }),
              )
              .toBe(true);
            await expect
              .poll(() => flashPaint(index))
              .toEqual({ visible: true, animated: true, outline: "none" });
            await captureUiProof(suite, page, "chat-position-rail", `jump-flash-${index}.png`);
            await expect.poll(async () => (await flashPaint(index)).visible).toBe(false);
          }
          await markers.nth(120).press("Escape");
          await expect.poll(() => preview.count()).toBe(0);
          await markers.nth(120).press("Home");
          await expect
            .poll(() => markers.first().evaluate((element) => element === document.activeElement))
            .toBe(true);
          await markers.first().press(" ");
          await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(0);
          await markers.first().press("End");
          await markers.last().press("Enter");
          await expect.poll(currentMarkerIndex).toBe(239);

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

          await markers.last().click();
          await expect
            .poll(() => flashPaint(239))
            .toEqual({ visible: true, animated: false, outline: "none" });
          await expect.poll(async () => (await flashPaint(239)).visible).toBe(false);

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
