import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
  createControlUiMockSameOriginGatewayScript,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([
    { count: 1, direction: "ltr" },
    { count: 2, direction: "ltr" },
    { count: 5, direction: "ltr" },
    { count: 8, direction: "ltr" },
    { count: 80, direction: "ltr" },
    { count: 80, direction: "rtl" },
  ])(
    "keeps the rail anchored as Task progress and the composer grow ($count, $direction messages)",
    async ({ count, direction }) => {
      await suite.withPage(
        { colorScheme: "dark", viewport: { width: 1440, height: 900 } },
        async ({ page }) => {
          const sessionKey = "agent:main:main";
          const runId = "stable-rail-run";
          const sessionInfo = { key: sessionKey, hasActiveRun: true, activeRunIds: [runId] };
          const gateway = await installMockGateway(page, {
            sessionKey,
            sessionInfo,
            sessions: [sessionInfo],
            inFlightRun: { runId, startedAt: Date.now() },
            historyMessages: Array.from({ length: count }, (_, index) => ({
              __openclaw: { id: `stable-rail-${index}`, seq: index + 1 },
              role: index % 2 === 0 ? "user" : "assistant",
              content: [
                {
                  type: "text",
                  text: `${direction === "rtl" ? "راجع الملاحظات. " : ""}Conversation checkpoint ${index + 1}: review the notes and confirm the next step.`,
                },
              ],
            })),
            featureMethods: [...defaultControlUiFeatureMethods, "progressCard.get"],
            methodResponses: {
              "progressCard.get": {
                card: {
                  sessionKey,
                  runId,
                  revision: 1,
                  updatedAt: Date.now(),
                  markdown: "Review the conversation and verify navigation.",
                  steps: [
                    { step: "Read the conversation", status: "completed" },
                    { step: "Verify navigation controls", status: "in_progress" },
                    { step: "Check the final evidence", status: "pending" },
                  ],
                },
              },
            },
          });
          await page.addInitScript(createControlUiMockSameOriginGatewayScript());
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.locator(`.chat-text[dir="${direction}"]`).first().waitFor();
          const card = page.locator(".session-progress-card--composer");
          await card.waitFor();
          // Initial transcript scrolling can still change the automatic disclosure state.
          await waitForChatScrollIdle(page);
          const summary = card.locator("summary");
          if ((await card.getAttribute("open")) !== null) {
            await summary.click();
          }
          await expect
            .poll(() =>
              card.evaluate((element) => getComputedStyle(element, "::details-content").blockSize),
            )
            .toBe("0px");
          const track = page.locator(".chat-position-rail__track");
          const marks = page.locator(".chat-position-rail__marks");
          const composer = page.locator(".agent-chat__composer-shell");
          await track.waitFor();
          const bounds = () =>
            track.evaluate((element) => element.getBoundingClientRect().toJSON());
          const collapsed = await bounds();
          const collapsedComposer = (await composer.boundingBox())!;
          const markers = marks.locator(".chat-position-rail__marker");
          if (count === 80 && direction === "ltr") {
            const transcript = page.locator(".chat-thread");
            await transcript.hover();
            await page.mouse.wheel(0, -4);
            await expect
              .poll(() =>
                transcript.evaluate(
                  (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
                ),
              )
              .toBe(4);
          }
          const anchorIndex = await markers.evaluateAll((elements) => {
            const viewport = elements[0]!
              .closest(".chat-position-rail__marks")!
              .getBoundingClientRect();
            return Math.max(
              0,
              elements.findIndex((element) => {
                const marker = element.getBoundingClientRect();
                return marker.top >= viewport.top + 60 && marker.bottom <= viewport.bottom - 60;
              }),
            );
          });
          const anchorTick = markers.nth(anchorIndex).locator(".chat-position-rail__tick");
          const tickTop = (await anchorTick.boundingBox())!.y;
          const sampleAnchor = () =>
            track.evaluate(async (element, index) => {
              const tick = element.querySelectorAll(".chat-position-rail__tick")[index]!;
              const positions = [];
              for (let frame = 0; frame < 30; frame++) {
                positions.push({
                  track: element.getBoundingClientRect().top,
                  tick: tick.getBoundingClientRect().top,
                });
                await new Promise<void>((resolve) => {
                  requestAnimationFrame(() => resolve());
                });
              }
              return positions;
            }, anchorIndex);
          const assertAnchor = async (samples: ReturnType<typeof sampleAnchor>) => {
            for (const position of await samples) {
              expect(position.track).toBe(collapsed.top);
              expect(position.tick).toBe(tickTop);
            }
          };
          for (const open of [true, false, true, false, true]) {
            const samples = sampleAnchor();
            await summary.click();
            await expect
              .poll(() => card.evaluate((element) => (element as HTMLDetailsElement).open))
              .toBe(open);
            if (open) {
              await expect
                .poll(async () => (await composer.boundingBox())!.height)
                .toBeGreaterThan(collapsedComposer.height + 80);
            } else {
              await expect
                .poll(async () => (await composer.boundingBox())!.height)
                .toBe(collapsedComposer.height);
            }
            await assertAnchor(samples);
            expect((await bounds()).top).toBe(collapsed.top);
            expect((await anchorTick.boundingBox())!.y).toBe(tickTop);
          }
          const expandedHeight = (await marks.boundingBox())!.height;
          const textareaSamples = sampleAnchor();
          await page
            .locator(".agent-chat__composer-combobox textarea")
            .fill(
              Array.from(
                { length: 6 },
                (_, index) => `Review note ${index + 1}: keep navigation visible.`,
              ).join("\n"),
            );
          await expect
            .poll(async () => (await composer.boundingBox())!.height)
            .toBeGreaterThan(collapsedComposer.height + 180);
          await assertAnchor(textareaSamples);
          expect((await bounds()).top).toBe(collapsed.top);
          expect((await anchorTick.boundingBox())!.y).toBe(tickTop);
          if (count === 80) {
            expect((await marks.boundingBox())!.height).toBeLessThan(expandedHeight);
            expect(
              await marks.evaluate((element) => element.scrollHeight > element.clientHeight),
            ).toBe(true);
          }
          if (count === 80 && direction === "ltr") {
            const textarea = page.locator(".agent-chat__composer-combobox textarea");
            const goalSamples = sampleAnchor();
            await textarea.fill("/goal");
            await textarea.press("Enter");
            await page.locator(".agent-chat__goal-mode").waitFor();
            await assertAnchor(goalSamples);
            const cancelSamples = sampleAnchor();
            await textarea.press("Escape");
            await page.locator(".agent-chat__goal-mode").waitFor({ state: "hidden" });
            await assertAnchor(cancelSamples);
            await gateway.setOnline(false);
            await gateway.closeLatest();
            for (const text of ["Review the next checkpoint", "Check the supporting notes"]) {
              const queueSamples = sampleAnchor();
              await textarea.fill(text);
              await textarea.press("Enter");
              await page.locator(".chat-queue__item", { hasText: text }).waitFor();
              await assertAnchor(queueSamples);
            }
          }
          await expect
            .poll(() =>
              marks.evaluate(async (element) => {
                const height = element.getBoundingClientRect().height;
                await new Promise<void>((resolve) => {
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                });
                return height === element.getBoundingClientRect().height;
              }),
            )
            .toBe(true);
          expect(
            await marks.evaluate(
              (element) =>
                element.getBoundingClientRect().height >=
                element.querySelector(".chat-position-rail__marker")!.getBoundingClientRect()
                  .height,
            ),
          ).toBe(true);
          await page.locator(".chat-thread").focus();
          await page.keyboard.press("Tab");
          await page.keyboard.press("Home");
          // Every entry remains reachable above the composer, including both ends.
          for (let index = 0; index < count; index++) {
            if (index > 0) {
              await page.keyboard.press("ArrowDown");
            }
            await expect
              .poll(() =>
                markers.nth(index).evaluate((element) => {
                  const marker = element.getBoundingClientRect();
                  const scroller = element.closest(".chat-position-rail__marks")!;
                  const viewport = scroller.getBoundingClientRect();
                  const composerTop = document
                    .querySelector(".agent-chat__composer-shell")!
                    .getBoundingClientRect().top;
                  return (
                    element === document.activeElement &&
                    marker.top >= viewport.top &&
                    // Scroll ranges round the local height before adding its fractional page position.
                    marker.bottom <= viewport.top + scroller.clientHeight &&
                    marker.bottom < composerTop
                  );
                }),
              )
              .toBe(true);
          }
          const preview = page.locator(".chat-position-rail__preview");
          const previewClearsComposer = () =>
            preview.evaluate(
              (element) =>
                element.getBoundingClientRect().bottom <=
                document.querySelector(".agent-chat__composer-shell")!.getBoundingClientRect().top,
            );
          await expect.poll(() => preview.textContent()).toContain(`checkpoint ${count}:`);
          await expect.poll(previewClearsComposer).toBe(true);
          await markers.last().press("Escape");
          // The button is already visible; avoid locator hover's extra scrollIntoView.
          const point = await markers.last().evaluate((element) => {
            const markerBounds = element.getBoundingClientRect();
            const x = markerBounds.x + markerBounds.width / 2;
            const y = markerBounds.y + markerBounds.height / 2;
            return { x, y, hitsMarker: element.contains(document.elementFromPoint(x, y)) };
          });
          expect(point.hitsMarker).toBe(true);
          await page.mouse.move(point.x, point.y);
          await expect.poll(() => preview.textContent()).toContain(`checkpoint ${count}:`);
          await expect.poll(previewClearsComposer).toBe(true);
          await page.mouse.move(900, 20);
          await markers.last().press("Home");
          await expect
            .poll(() => markers.first().evaluate((element) => element === document.activeElement))
            .toBe(true);
          await markers.first().press("End");
          await expect
            .poll(() => markers.last().evaluate((element) => element === document.activeElement))
            .toBe(true);
          await markers.last().press("Escape");
          if (count === 80 && direction === "ltr") {
            await page.locator(".chat-thread").focus();
            await page.keyboard.press("ControlOrMeta+f");
            await page.locator(".agent-chat__search-bar input").fill("Conversation checkpoint 80:");
            await expect.poll(() => markers.count()).toBe(1);
            await expect
              .poll(() =>
                markers.first().evaluate((element) => {
                  const marker = element.getBoundingClientRect();
                  const scroller = element.closest(".chat-position-rail__marks")!;
                  const viewport = scroller.getBoundingClientRect();
                  return (
                    marker.top >= viewport.top &&
                    marker.bottom <= viewport.top + scroller.clientHeight
                  );
                }),
              )
              .toBe(true);
            await page.locator(".agent-chat__search-bar button").click();
            await expect.poll(() => markers.count()).toBe(count);
          }
          await page.setViewportSize({ width: 390, height: 844 });
          await track.waitFor({ state: "hidden" });
          if (count === 80 && direction === "ltr") {
            const transcript = page.locator(".chat-thread");
            await transcript.hover();
            await page.mouse.wheel(0, -30000);
            await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(0);
            await page.setViewportSize({ width: 1440, height: 1000 });
            await track.waitFor();
            await expect
              .poll(() =>
                marks.locator('[aria-current="true"]').evaluate((element) => {
                  const marker = element.getBoundingClientRect();
                  const scroller = element.closest(".chat-position-rail__marks")!;
                  const viewport = scroller.getBoundingClientRect();
                  return (
                    marker.top >= viewport.top &&
                    marker.bottom <= viewport.top + scroller.clientHeight
                  );
                }),
              )
              .toBe(true);
          }
        },
      );
    },
  );
  it("keeps the rail and its first preview clear in a bottom-docked chat pane", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 1440 }, reducedMotion: "reduce" },
      async ({ page }) => {
        const sessionKey = "agent:main:main";
        await installMockGateway(page, {
          sessionKey,
          historyMessages: Array.from({ length: 80 }, (_, index) => ({
            __openclaw: { id: `docked-rail-${index}`, seq: index + 1 },
            role: index % 2 === 0 ? "user" : "assistant",
            content: [
              { type: "text", text: `Review checkpoint ${index + 1} and its supporting notes.` },
            ],
          })),
        });
        await page.addInitScript(createControlUiMockSameOriginGatewayScript());
        await page.addInitScript(
          ({ key, sessionKey: seededSessionKey }) =>
            localStorage.setItem(
              key,
              JSON.stringify({
                sessionKey: seededSessionKey,
                sidebarSessionLayouts: {
                  [seededSessionKey]: {
                    columns: [
                      {
                        id: "side-panel-column",
                        side: "right",
                        panels: [{ id: "workspace", slot: "workspace" }],
                        activePanelId: "workspace",
                        height: 700,
                        width: 480,
                      },
                    ],
                    dock: "bottom",
                    open: true,
                    expanded: false,
                  },
                },
              }),
            ),
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), sessionKey },
        );
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.locator(".sidebar-region--bottom.sidebar-region--open").waitFor();
        const transcript = page.locator(".chat-thread");
        const track = page.locator(".chat-position-rail__track");
        const marks = page.locator(".chat-position-rail__marks");
        const first = marks.locator(".chat-position-rail__marker").first();
        await first.waitFor();
        await transcript.evaluate((element) => {
          element.scrollTop = 0;
        });
        await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(0);
        await waitForChatScrollIdle(page);
        const top = (await track.boundingBox())!.y;
        await transcript.evaluate((element) => {
          element.scrollTop = 200;
        });
        await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(200);
        expect((await track.boundingBox())!.y).toBe(top);
        await marks.evaluate((element) => {
          element.scrollTop = 0;
        });
        await first.hover();
        const preview = page.locator(".chat-position-rail__preview");
        await preview.waitFor();
        expect((await preview.boundingBox())!.y).toBeGreaterThanOrEqual(
          (await transcript.boundingBox())!.y,
        );
        await page.mouse.move(900, 20);
        await transcript.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Home");
        await expect
          .poll(() => first.evaluate((element) => element === document.activeElement))
          .toBe(true);
        await preview.waitFor();
        expect((await preview.boundingBox())!.y).toBeGreaterThanOrEqual(
          (await transcript.boundingBox())!.y,
        );
      },
    );
  });
});
