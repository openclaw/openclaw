import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("docks Details in wide conversations and preserves manual intent, drafts, and independent scrolling", async () => {
    const sessionKey = "agent:main:details-progress";
    await suite.withPage(
      { colorScheme: "dark", locale: "en-US", viewport: { width: 1728, height: 1000 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey,
          agentModel: "example/demo-model",
          models: [
            { id: "demo-model", name: "Demo model", provider: "example", contextWindow: 128000 },
          ],
          featureMethods: [
            "browser.request",
            "chat.metadata",
            "chat.startup",
            "progressCard.get",
            "progressCard.put",
            "progressCard.refresh",
            SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
          ],
          historyMessages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Put session context and task progress in Details, and remove the duplicate bars.",
                },
              ],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: [
                    "I am bringing related session information together without mixing it into the conversation.",
                    "### Session context",
                    "The worktree, pull requests, people, active helpers, and automations belong to this session. Each entry should keep its existing action and source of truth.",
                    "### Task progress",
                    "The checklist describes the job currently underway. It remains independent from session context, with its own disclosure state and display preference.",
                    "### Verification",
                    "I will check the Details control, keyboard navigation, updates, and narrow layouts. The final result should leave no duplicate pull request or progress bars above the composer.",
                  ].join("\n\n"),
                },
              ],
            },
          ],
          methodResponses: {
            [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
            "browser.request": {
              cases: [
                { match: { method: "GET", path: "/tabs" }, response: { running: false, tabs: [] } },
              ],
            },
            "progressCard.get": {
              card: {
                sessionKey,
                revision: 1,
                updatedAt: Date.now(),
                markdown:
                  "Integrating task progress into session Details. The UI is ready for focused interaction checks.",
                steps: [
                  { step: "Inspect the existing session owners", status: "completed" },
                  { step: "Integrate Details and task progress", status: "completed" },
                  { step: "Verify interactions and screenshots", status: "in_progress" },
                  { step: "Review and land the change", status: "pending" },
                ],
              },
            },
            "sessions.list": chatSessionListResponse([
              {
                key: sessionKey,
                kind: "direct",
                label: "Session Details and task progress",
                updatedAt: 1,
              },
            ]),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await gateway.waitForRequest(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD);
        await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
          sessions: {
            [sessionKey]: {
              pullRequests: [
                {
                  number: 161674,
                  owner: "openclaw",
                  repo: "openclaw",
                  branch: "openclaw/session-details",
                  title: "Session details and task progress",
                  url: "https://github.com/openclaw/openclaw/pull/161674",
                  state: "open",
                  isDraft: true,
                  additions: 84,
                  deletions: 41,
                  checks: { state: "passing", passed: 12, failed: 0, skipped: 0, running: 0 },
                },
              ],
            },
          },
        });
        const trigger = page.getByRole("button", { name: "Details", exact: true });
        const details = page.locator(".chat-details");
        const progress = details.locator('[data-progress-card-placement="details"]');
        const session = details.locator(".chat-details-session");
        const progressToggle = progress.locator(":scope > summary");
        const prGroup = details.locator('[data-details-group="pull-requests"]');
        const composer = page.getByRole("textbox", { name: "Chat composer", exact: true });
        await trigger.waitFor();
        await expect.poll(() => details.getAttribute("role")).toBe("complementary");
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");
        expect(await page.locator('[data-progress-card-placement="composer"]').count()).toBe(0);
        expect(await page.locator(".chat-footer .chat-pr").count()).toBe(0);
        await composer.fill("Keep my draft while I inspect Details.");
        await expect.poll(() => details.isVisible()).toBe(true);
        await expect.poll(() => progress.isVisible()).toBe(true);
        expect(await prGroup.getAttribute("open")).toBeNull();
        await prGroup.locator(":scope > summary").click();
        const pullRequest = details.locator(".chat-pr").first();
        await pullRequest.waitFor();
        const capture = async (name: string) => {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".chat").first(),
            [details, progress, composer],
            { animations: "disabled" },
          );
          await writeFile(path.join(suite.artifactDir, name), frame.png);
        };
        const geometry = async (docked: boolean) => {
          const bounds = await details.boundingBox();
          const frame = await page.locator(".chat-main__conversation-frame").boundingBox();
          const conversation = await page.locator(".chat-main__conversation").boundingBox();
          const footer = await page.locator(".chat-footer").boundingBox();
          expect(bounds).toBeTruthy();
          expect(frame).toBeTruthy();
          expect(conversation).toBeTruthy();
          expect(footer).toBeTruthy();
          expect(bounds!.x).toBeGreaterThanOrEqual(frame!.x);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 1);
          if (docked) {
            expect(bounds!.width).toBe(352);
            expect(Math.abs(bounds!.height - frame!.height)).toBeLessThanOrEqual(1);
            expect(conversation!.x + conversation!.width).toBeLessThanOrEqual(bounds!.x + 1);
            expect(footer!.x + footer!.width).toBeLessThanOrEqual(bounds!.x + 1);
          } else {
            expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(footer!.y);
          }
          expect(await details.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        };
        await geometry(true);
        await capture("after.png");
        // A dock is nonmodal: composing, including Escape, must not close it.
        await composer.click();
        await page.keyboard.press("Escape");
        expect(await details.isVisible()).toBe(true);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
        await trigger.focus();
        await trigger.press("Enter");
        await expect.poll(() => details.getAttribute("role")).toBe("dialog");
        await page.keyboard.press("Tab");
        await expect
          .poll(() =>
            details
              .getByRole("button", { name: "Close details", exact: true })
              .evaluate((el) => el === document.activeElement),
          )
          .toBe(true);
        await geometry(false);
        await capture("overlay.png");
        await session.locator(":scope > summary").click();
        await expect.poll(() => session.getAttribute("open")).toBeNull();
        expect(await progress.getAttribute("open")).not.toBeNull();
        await progressToggle.click();
        await expect.poll(() => progress.getAttribute("open")).toBeNull();
        expect(
          await progress
            .getByRole("button", { name: "Task progress options", exact: true })
            .isVisible(),
        ).toBe(false);
        await session.locator(":scope > summary").click();
        expect(await progress.getAttribute("open")).toBeNull();
        await progressToggle.click();
        const checks = pullRequest.locator(".chat-pr__checks-pill");
        await checks.click();
        await expect
          .poll(() => pullRequest.locator(".chat-pr__checks-menu").isVisible())
          .toBe(true);
        await page.keyboard.press("Escape");
        await expect
          .poll(() => pullRequest.locator(".chat-pr__checks-menu").isVisible())
          .toBe(false);
        expect(await details.isVisible()).toBe(true);
        await page.keyboard.press("Escape");
        await expect.poll(() => details.isVisible()).toBe(false);
        expect(await trigger.evaluate((el) => el === document.activeElement)).toBe(true);
        expect(await composer.inputValue()).toBe("Keep my draft while I inspect Details.");
        await gateway.setMethodResponse("progressCard.get", {
          card: {
            sessionKey,
            revision: 2,
            updatedAt: Date.now(),
            markdown: "The card changed while Details stayed closed.",
            steps: [{ step: "Verify interactions and screenshots", status: "in_progress" }],
          },
        });
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
        expect(await trigger.getAttribute("aria-expanded")).toBe("false");
        await trigger.click();
        await expect
          .poll(() => progress.textContent())
          .toContain("The card changed while Details stayed closed.");
        const menu = progress.locator(".chat-details-progress__menu");
        expect(await menu.locator("wa-dropdown-item").count()).toBe(0);
        await progress.getByRole("button", { name: "Task progress options", exact: true }).click();
        await menu.locator('wa-dropdown-item[value="hide"]').waitFor({ state: "visible" });
        expect(await menu.locator("wa-dropdown-item").count()).toBe(4);
        await page.keyboard.press("Escape");
        expect(await menu.locator("wa-dropdown-item").count()).toBe(4);
        await progress.getByRole("button", { name: "Task progress options", exact: true }).click();
        await menu.locator('wa-dropdown-item[value="hide"]').click();
        await expect.poll(() => progress.count()).toBe(0);
        expect(await session.isVisible()).toBe(true);
        const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
        const showSetting = () =>
          page.evaluate(
            (key) => JSON.parse(localStorage.getItem(key) ?? "{}").chatShowTaskProgress,
            settingsKey,
          );
        await expect.poll(showSetting).toBe(false);
        await page.getByRole("button", { name: "Undo", exact: true }).click();
        await expect.poll(showSetting).not.toBe(false);
        await expect.poll(() => progress.count()).toBe(1);
        // The toast is outside Details; Undo restores the setting without reopening it.
        expect(await trigger.getAttribute("aria-expanded")).toBe("false");
        await trigger.click();
        await expect.poll(() => progress.isVisible()).toBe(true);
        await progress.getByRole("button", { name: "Task progress options", exact: true }).click();
        await menu.locator('wa-dropdown-item[value="collapse"]').click();
        expect(await progress.getAttribute("open")).not.toBeNull();
        await progress.getByRole("button", { name: "Task progress options", exact: true }).click();
        await menu.locator('wa-dropdown-item[value="hide"]').click();
        await expect.poll(showSetting).toBe(false);
        await page.reload();
        await trigger.waitFor();
        await trigger.click();
        expect(await progress.count()).toBe(0);
        expect(await gateway.getRequests("progressCard.get")).toHaveLength(0);
        const settingsPage = await page.context().newPage();
        await installMockGateway(settingsPage, { sessionKey });
        await settingsPage.goto(
          suite.server.baseUrl +
            "settings/appearance?section=__appearance__#settings-appearance-chat",
        );
        const showRow = settingsPage
          .locator(".settings-row")
          .filter({
            has: settingsPage.locator(".settings-row__title", {
              hasText: "Show task progress cards",
            }),
          })
          .first();
        await showRow.click();
        await expect.poll(() => progress.isVisible()).toBe(true);
        await expect.poll(() => progress.getAttribute("open")).toBeNull();
        await settingsPage.close();
        await progressToggle.click();
        await geometry(false);
        await details.getByRole("button", { name: "Close details", exact: true }).click();
        await page.setViewportSize({ width: 1728, height: 1000 });
        expect(await trigger.getAttribute("aria-expanded")).toBe("false");
        await trigger.click();
        await expect.poll(() => details.getAttribute("role")).toBe("complementary");
        await geometry(true);
        await openChatSidePanelType(page, "browser");
        await expect.poll(() => details.getAttribute("role")).toBe("dialog");
        if ((await trigger.getAttribute("aria-expanded")) !== "true") {
          await trigger.click();
        }
        await geometry(false);
        await capture("with-browser.png");
        await page.keyboard.press("Escape");
        await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
        expect(await trigger.getAttribute("aria-expanded")).toBe("false");
        await page.setViewportSize({ width: 430, height: 900 });
        expect(await trigger.getAttribute("aria-expanded")).toBe("false");
        await trigger.click();
        await expect.poll(() => details.getAttribute("role")).toBe("dialog");
        await geometry(false);
        await capture("narrow.png");
        await details.getByRole("button", { name: "Close details", exact: true }).click();
        await page.setViewportSize({ width: 1728, height: 1000 });
        expect(await trigger.getAttribute("aria-expanded")).toBe("false");
        await trigger.click();
        await expect.poll(() => details.getAttribute("role")).toBe("complementary");
        await geometry(true);
        await composer.fill("Keep my draft while I inspect Details.");
        await gateway.setMethodResponse("progressCard.get", {
          card: {
            sessionKey,
            revision: 3,
            updatedAt: Date.now(),
            markdown: "Long task details must scroll independently from the conversation.",
            steps: Array.from({ length: 24 }, (_, index) => ({
              step:
                "Verification step " +
                (index + 1) +
                ": retain readable conversation text and an independently scrolling details rail for long-running work.",
              status: index < 8 ? "completed" : index === 8 ? "in_progress" : "pending",
            })),
          },
        });
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 3 });
        await expect.poll(() => progress.textContent()).toContain("Verification step 24");
        await gateway.emitChatFinal({
          runId: "details-long-transcript",
          text: Array.from(
            { length: 20 },
            (_, index) =>
              "Layout check " +
              (index + 1) +
              ": preserve the reading column and unsent draft while Details adapts to the available conversation width. The transcript and task checklist must remain independently scrollable.",
          ).join("\n\n"),
        });
        const thread = page.locator(".chat-thread");
        await expect.poll(() => thread.textContent()).toContain("Layout check 20");
        await thread.hover();
        await page.mouse.wheel(0, 10000);
        await expect
          .poll(() => thread.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
          .toBeLessThan(2);
        const threadTop = await thread.evaluate((el) => el.scrollTop);
        expect(threadTop).toBeGreaterThan(0);
        await details.hover();
        await page.mouse.wheel(0, 600);
        await expect.poll(() => details.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        expect(await thread.evaluate((el) => el.scrollTop)).toBe(threadTop);
        expect(await composer.inputValue()).toBe("Keep my draft while I inspect Details.");
        await geometry(true);
        await capture("long-details.png");
        const detailsTop = await details.evaluate((el) => el.scrollTop);
        await thread.hover();
        await page.mouse.wheel(0, -600);
        await expect.poll(() => thread.evaluate((el) => el.scrollTop)).toBeLessThan(threadTop);
        expect(await details.evaluate((el) => el.scrollTop)).toBe(detailsTop);
        expect(await gateway.getRequests("progressCard.put")).toHaveLength(0);
      },
    );
  });
});
