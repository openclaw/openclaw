import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { cronJobsListResponse } from "../lib/cron/cron.test-support.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Details transcript scrollbar",
  // Chromium headless otherwise hides the scrollbar this scenario exercises.
  browserLaunchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
});
const sessionKey = "agent:main:main";

async function geometry(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const { left, right, width } = document.querySelector(selector)!.getBoundingClientRect();
      return { left, right, width };
    };
    return {
      frame: box(".chat-main__conversation-frame"),
      thread: box(".chat-thread"),
      column: box(".chat-thread-inner"),
      composer: box(".agent-chat__composer-shell"),
      details: box(".chat-details"),
    };
  });
}

suite.define(() => {
  it("keeps the scrollbar at the conversation edge while Details leaves messages and the composer clear", async () => {
    await suite.withPage(
      { viewport: { width: 1900, height: 1000 }, colorScheme: "dark" },
      async ({ page }) => {
        await seedChatSettings(page, suite.server.baseUrl, { themeMode: "dark" });
        await installMockGateway(page, {
          sessionKey,
          agentModel: "example/demo-model",
          models: [
            { id: "demo-model", name: "Demo model", provider: "example", contextWindow: 128000 },
          ],
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "cron.list",
            "chat.metadata",
            "chat.startup",
            "progressCard.get",
            "progressCard.refresh",
          ],
          methodResponses: {
            "cron.list": cronJobsListResponse([]),
            "progressCard.get": {
              card: {
                sessionKey,
                revision: 1,
                updatedAt: 1,
                markdown:
                  "Review the release notes and verify the session layout before publication.",
                steps: [
                  { step: "Inspect the proposed release notes", status: "completed" },
                  { step: "Verify the session layout", status: "in_progress" },
                  { step: "Publish the reviewed notes", status: "pending" },
                ],
              },
            },
            "sessions.files.list": {
              sessionKey,
              root: "/workspace/release-review",
              gitCheckout: true,
              files: [],
              browser: { path: "", entries: [] },
            },
          },
          sessions: [
            {
              key: sessionKey,
              sessionId: "details-scrollbar",
              kind: "direct",
              label: "Review release notes",
              spawnedCwd: "/workspace/release-review",
              worktree: { id: "release-review", repoRoot: "/workspace", branch: "release-review" },
              model: "demo-model",
              totalTokens: 32000,
              totalTokensFresh: true,
              contextTokens: 128000,
            },
          ],
          historyMessages: Array.from({ length: 24 }, (_, index) => ({
            role: index % 2 === 0 ? "user" : "assistant",
            content:
              index % 2 === 0
                ? `Review item ${index + 1}: check the next release note.`
                : `### Release review ${index + 1}\n\nThe updated session view keeps the conversation readable while supporting project files and progress details.\n\n- Review the change in context.\n- Verify the result in the application.\n- Record the outcome for the release.`,
          })),
          workspace: "/workspace/release-review",
          workspaceGit: true,
        });
        await page.goto(suite.server.baseUrl + "chat");
        const thread = page.locator(".chat-thread");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor();
        await openChatDetails(page);
        await page.locator(".chat-details-desktop-body").waitFor();
        await composer.fill("Keep this draft while checking the layout.");
        await thread.hover();
        await page.mouse.wheel(0, -450);
        await expect
          .poll(() =>
            thread.evaluate(
              (element) => element.scrollTop + element.clientHeight < element.scrollHeight - 100,
            ),
          )
          .toBe(true);
        const capture = await takeControlUiScreenshotFrame(
          page,
          page.locator(".chat-main__conversation-frame"),
          [page.locator(".chat-details-desktop-body"), composer],
          { animations: "disabled" },
        );
        await writeFile(path.join(suite.artifactDir, "details-wide.png"), capture.png);
        const initial = await geometry(page);
        expect(initial.thread.right).toBeCloseTo(initial.frame.right, 0);
        // A wider box alone is insufficient if an ancestor still clips its scrollbar.
        expect(
          await thread.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return (
              element.ownerDocument.elementFromPoint(box.right - 2, box.top + box.height / 2) ===
              element
            );
          }),
        ).toBe(true);
        expect(initial.column.left + initial.column.width / 2).toBeCloseTo(
          initial.composer.left + initial.composer.width / 2,
          0,
        );
        expect(initial.column.right).toBeLessThan(initial.details.left);
        expect(initial.composer.right).toBeLessThan(initial.details.left);
        const scrollBefore = await thread.evaluate((element) => element.scrollTop);
        await thread.focus();
        await page.keyboard.press("PageUp");
        await expect
          .poll(() => thread.evaluate((element) => element.scrollTop))
          .toBeLessThan(scrollBefore);
        await closeChatDetails(page);
        await openChatDetails(page);
        await expect
          .poll(async () => (await geometry(page)).thread.right)
          .toBeCloseTo(initial.frame.right, 0);
        expect(await composer.inputValue()).toBe("Keep this draft while checking the layout.");
        for (const width of [1510, 1509, 1100, 1900]) {
          await page.setViewportSize({ width, height: 1000 });
          await openChatDetails(page);
          await expect
            .poll(async () => {
              const boxes = await geometry(page);
              return Math.abs(boxes.thread.right - boxes.frame.right);
            })
            .toBeLessThan(1);
        }
        await openChatSidePanelType(page, "Files");
        await page.locator('[data-panel-slot="workspace"]:visible').waitFor();
        await expect
          .poll(async () => {
            const boxes = await geometry(page);
            return Math.abs(boxes.thread.right - boxes.frame.right);
          })
          .toBeLessThan(1);
        const side = await page.locator('[data-region="side"]:visible').boundingBox();
        expect((await geometry(page)).thread.right).toBeLessThanOrEqual(side!.x);
        await composer.click();
        expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);
      },
    );
  });
});
