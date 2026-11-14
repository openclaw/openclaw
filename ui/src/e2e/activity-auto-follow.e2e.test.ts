import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Activity scroll ownership",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it.each([
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 932, height: 430 },
    { width: 1440, height: 844 },
  ])(
    "follows, pauses, and resumes in the scrolling layout at $width × $height",
    async ({ width, height }) => {
      await suite.withPage({ viewport: { width, height } }, async ({ page }) => {
        await page.clock.setFixedTime(new Date("2026-01-15T12:00:00Z"));
        const sessionKey = "agent:main:fixture";
        const gateway = await installMockGateway(page, {
          sessionKey,
          methodResponses: {
            "sessions.list": chatSessionListResponse([
              {
                key: sessionKey,
                kind: "direct",
                label: "Fixture session",
                updatedAt: Date.now(),
                hasActiveRun: true,
                activeRunIds: ["fixture-run"],
                status: "running",
              },
            ]),
          },
        });
        await page.goto(`${suite.server.baseUrl}activity?view=live`);
        await waitForControlUiRoute(page, { pathname: "/activity", routeId: "activity" });
        await page.locator(".activity-current-work__row").waitFor();
        await gateway.waitForRequest("sessions.messages.subscribe");
        // The route mounts its event projection after the subscription and first paint.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        const stream = page.locator(".activity-stream");
        const scroller = page.locator(
          width <= 768 || height <= 500 ? "main.content" : ".activity-stream",
        );
        const entries = stream.locator(".activity-entry");
        const append = async (start: number, count: number) => {
          for (let index = start; index < start + count; index++) {
            await gateway.emitGatewayEvent("session.tool", {
              stream: "tool",
              runId: "fixture-run",
              sessionKey,
              data: {
                toolCallId: `fixture-tool-${index}`,
                name: "read",
                phase: "result",
                args: { path: `fixture/record-${index}.txt` },
                result: { text: `Inspection result ${index}` },
              },
            });
            await expect.poll(() => entries.count()).toBe(index + 1);
          }
        };
        const bottomGap = () =>
          scroller.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          );
        await append(0, 30);
        await expect.poll(bottomGap).toBeLessThan(2);
        await scroller.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await expect.poll(bottomGap).toBeLessThan(2);
        // Let the native scroll event settle before the next simulated server update.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            }),
        );
        await append(30, 4);
        await expect.poll(bottomGap).toBeLessThan(2);

        await scroller.hover();
        await page.mouse.wheel(0, -500);
        await expect.poll(bottomGap).toBeGreaterThan(200);
        const pausedTop = await scroller.evaluate((element) => element.scrollTop);
        await append(34, 4);
        expect(await scroller.evaluate((element) => element.scrollTop)).toBeCloseTo(pausedTop, 0);

        if (width <= 640) {
          await page.locator("#activity-live-filter-trigger").click();
        }
        const toggle = page.getByRole("switch", { name: "Auto-follow" });
        await toggle.click();
        await toggle.click();
        await page.keyboard.press("Escape");
        await expect.poll(bottomGap).toBeLessThan(2);
        // Let the native scroll event settle before the next simulated server update.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            }),
        );
        await append(38, 4);
        await expect.poll(bottomGap).toBeLessThan(2);
      });
    },
  );
});
