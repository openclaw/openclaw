import { expect, it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

declare global {
  interface Window {
    composerWidthFrames: number[];
  }
}

const suite = createControlUiE2eSuite({ name: "Composer border width preference" });

suite.define(() => {
  it.each([1440, 1600])(
    "aligns New Session placement with saved and dragged widths at %ipx",
    async (viewportWidth) => {
      await suite.withPage(
        { viewport: { width: viewportWidth, height: 900 } },
        async ({ page }) => {
          await installMockGateway(page);
          await page.goto(`${suite.server.baseUrl}new`);
          const shell = page.locator(".agent-chat__composer-shell");
          const triggers = page.locator(".new-session-page__triggers");
          const edge = page.getByRole("separator", { name: "Resize message width", exact: true });
          await edge.waitFor();
          const width = () =>
            shell.evaluate((element) => Math.round(element.getBoundingClientRect().width));
          const alignment = () =>
            triggers.evaluate((element) =>
              Math.abs(
                element.getBoundingClientRect().left -
                  document.querySelector(".agent-chat__composer-shell")!.getBoundingClientRect()
                    .left,
              ),
            );
          const dragTo = async (target: number) => {
            const box = await edge.boundingBox();
            if (!box) {
              throw new Error("Expected a visible composer border");
            }
            const start = box.x + box.width / 2;
            await page.mouse.move(start, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(start + ((await width()) - target) / 2, box.y + box.height / 2, {
              steps: 5,
            });
            await expect.poll(width).toBe(target);
          };
          await dragTo(600);
          await page.mouse.up();
          await expect
            .poll(() =>
              page
                .locator(".new-session-page")
                .evaluate((element) => element.style.getPropertyValue("--chat-thread-max-width")),
            )
            .toBe("600px");
          expect.soft(await alignment(), "saved 600px placement alignment").toBeLessThanOrEqual(1);
          await dragTo(480);
          expect(
            await page
              .locator(".new-session-page")
              .evaluate((element) => element.style.getPropertyValue("--chat-thread-max-width")),
          ).toBe("480px");
          expect
            .soft(await alignment(), "active 480px drag placement alignment")
            .toBeLessThanOrEqual(1);
          await page.mouse.up();

          await page.setViewportSize({ width: 390, height: 844 });
          await page.locator(".shell--mobile-nav").waitFor();
          const mobileTriggers = triggers.locator("button:visible");
          expect(await mobileTriggers.count()).toBeGreaterThanOrEqual(2);
          for (const trigger of await mobileTriggers.all()) {
            const box = await trigger.boundingBox();
            expect(box!.x).toBeGreaterThanOrEqual(0);
            expect(box!.x + box!.width).toBeLessThanOrEqual(390);
            expect(box!.height).toBeGreaterThanOrEqual(44);
            await trigger.click({ trial: true });
          }
        },
      );
    },
  );

  it("shares width with chat and resets to the current preference after reopening New Session", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await installMockGateway(page);
      const shell = page.locator(".agent-chat__composer-shell");
      const edge = page.getByRole("separator", { name: "Resize message width", exact: true });
      const width = () =>
        shell.evaluate((element) => Math.round(element.getBoundingClientRect().width));
      await page.goto(`${suite.server.baseUrl}new`);
      await edge.waitFor();
      const initial = await width();
      await edge.press("ArrowRight");
      await expect.poll(width).toBe(initial - 20);

      await page.goto(`${suite.server.baseUrl}chat`);
      await edge.waitFor();
      await expect.poll(width).toBe(initial - 20);
      await edge.press("ArrowRight");
      await expect.poll(width).toBe(initial - 40);

      await page.goto(`${suite.server.baseUrl}new`);
      await edge.waitFor();
      await expect.poll(width).toBe(initial - 40);
      await edge.dblclick();
      await expect.poll(width).toBe(initial - 40);
      await edge.press("ArrowLeft");
      await expect.poll(width).toBe(initial - 20);
      await edge.press("Enter");
      await expect.poll(width).toBe(initial - 40);

      const box = await edge.boundingBox();
      if (!box) {
        throw new Error("Expected a visible composer border");
      }
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 35, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
      await expect.poll(width).toBe(initial + 30);
      await edge.dblclick();
      await expect.poll(width).toBe(initial - 40);
      const resetBox = await edge.boundingBox();
      if (!resetBox) {
        throw new Error("Expected the restored border");
      }
      const savedWidth = () =>
        page
          .locator(".new-session-page")
          .evaluate((element) => element.style.getPropertyValue("--chat-thread-max-width"));
      const saved = await savedWidth();
      await page.mouse.move(resetBox.x + 4, resetBox.y + resetBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(resetBox.x - 25, resetBox.y + resetBox.height / 2);
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.mouse.up();
      await expect.poll(width).toBe(initial - 40);
      expect(await savedWidth()).toBe(saved);
      await page.reload();
      await edge.waitFor();
      await expect.poll(width).toBe(initial - 40);
    });
  });
  it.each([
    ["docked Details", 1600, "details"],
    ["a side panel", 1440, "files"],
    ["floating Details", 1100, "floating"],
  ] as const)(
    "keeps the widest composer inside the transcript column beside %s",
    async (_label, viewportWidth, panel) => {
      await suite.withPage(
        { viewport: { width: viewportWidth, height: 900 } },
        async ({ page }) => {
          const sessionKey = "agent:main:composer-width-panels";
          await installMockGateway(page, {
            sessionKey,
            historyMessages: [{ role: "assistant", content: "Panels keep their space." }],
            workspace: "/workspace/openclaw",
            workspaceGit: true,
            methodResponses: {
              "sessions.files.list": {
                browser: { path: "", entries: [] },
                files: [],
                root: "/workspace/openclaw",
                sessionKey,
              },
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await page.getByText("Panels keep their space.").waitFor();
          if (panel === "details") {
            await openChatDetails(page);
            await page.locator(".chat-details--docked").waitFor();
          } else if (panel === "files") {
            await openChatSidePanelType(page, "Files");
          }
          const edge = page.getByRole("separator", { name: "Resize message width", exact: true });
          await edge.waitFor();
          const box = (await edge.boundingBox())!;
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await page.mouse.move(box.x - 3000, box.y + box.height / 2, { steps: 8 });
          await page.mouse.up();
          const bounds = (selector: string) =>
            page
              .locator(selector)
              .filter({ visible: true })
              .first()
              .evaluate((element) => {
                const rect = element.getBoundingClientRect();
                return {
                  left: rect.left,
                  right: rect.right,
                  top: rect.top,
                  bottom: rect.bottom,
                  width: rect.width,
                };
              });
          // The actual reading column excludes Details, scrollbars, and transcript gutters.
          // Comparing against .chat or even .chat-main__conversation misses all three.
          await expect
            .poll(async () => {
              const transcript = await bounds(".chat-thread-inner");
              const composer = await bounds(".agent-chat__composer-shell");
              return Math.max(transcript.left - composer.left, composer.right - transcript.right);
            })
            .toBeLessThanOrEqual(1);
          const composer = await bounds(".agent-chat__composer-shell");
          expect(composer.width).toBeGreaterThan(0);
          if (panel === "details") {
            expect((await bounds(".chat-details--docked")).left).toBeGreaterThanOrEqual(
              composer.right,
            );
          } else if (panel === "floating") {
            // Opening the floating inspector after resizing keeps the real outside-click
            // dismissal behavior, while proving its existing footer reservation still fits.
            const details = await openChatDetails(page);
            expect(await details.getAttribute("class")).not.toContain("chat-details--docked");
            await expect
              .poll(
                async () =>
                  (await bounds(".chat-details")).bottom - (await bounds(".agent-chat__input")).top,
              )
              .toBeLessThanOrEqual(0);
          }
        },
      );
    },
  );

  it.each(["chat", "new"] as const)(
    "restores saved %s width at the first visible frame",
    async (route) => {
      await suite.withPage({ viewport: { width: 1600, height: 900 } }, async ({ page }) => {
        const sessionKey = "agent:main:composer-width-reload";
        await seedChatSettings(page, suite.server.baseUrl, { chatMessageMaxWidth: "1000px" });
        await installMockGateway(page, {
          sessionKey,
          historyMessages: [{ role: "assistant", content: "Reload keeps the composer still." }],
        });
        await page.goto(
          route === "chat"
            ? controlUiSessionUrl(suite.server.baseUrl, sessionKey)
            : suite.server.baseUrl + "new",
        );
        const edge = page.getByRole("separator", { name: "Resize message width", exact: true });
        await edge.waitFor();
        await waitForLayoutSettled(page, ".agent-chat__composer-shell");
        const expectedWidth = await page
          .locator(".agent-chat__composer-shell")
          .evaluate((element) => Math.round(element.getBoundingClientRect().width));
        expect(expectedWidth).toBeGreaterThan(0);
        expect(expectedWidth).toBeLessThanOrEqual(1000);
        await page.addInitScript(() => {
          window.composerWidthFrames = [];
          const tick = () => {
            const shell = document.querySelector(".agent-chat__composer-shell");
            const rect = shell?.getBoundingClientRect();
            if (rect && rect.width > 0 && rect.height > 0) {
              window.composerWidthFrames.push(Math.round(rect.width));
            }
            if (window.composerWidthFrames.length < 30) {
              requestAnimationFrame(tick);
            }
          };
          requestAnimationFrame(tick);
        });
        await page.reload();
        await expect.poll(() => page.evaluate(() => window.composerWidthFrames.length)).toBe(30);
        const frames = await page.evaluate(() => window.composerWidthFrames);
        expect(new Set(frames), frames.join(", ")).toEqual(new Set([expectedWidth]));
      });
    },
  );
});
