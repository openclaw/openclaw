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
  it("keeps session context and progress in user-opened Details without composer duplicates", async () => {
    const sessionKey = "agent:main:details-progress";
    await suite.withPage(
      { colorScheme: "dark", locale: "en-US", viewport: { width: 1440, height: 1000 } },
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
        const details = page.locator('.chat-details[role="dialog"]');
        const progress = details.locator('[data-progress-card-placement="details"]');
        const session = details.locator(".chat-details-session");
        const progressToggle = progress.locator(":scope > summary");
        const prGroup = details.locator('[data-details-group="pull-requests"]');
        const composer = page.getByRole("textbox", { name: "Chat composer", exact: true });
        await trigger.waitFor();
        expect(await trigger.getAttribute("aria-expanded")).toBe("false");
        expect(await page.locator('[data-progress-card-placement="composer"]').count()).toBe(0);
        expect(await page.locator(".chat-footer .chat-pr").count()).toBe(0);
        await composer.fill("Keep my draft while I inspect Details.");
        await trigger.click();
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
        await capture("after.png");
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
        const geometry = async () => {
          const bounds = await details.boundingBox();
          const conversation = await page.locator(".chat-main__conversation-frame").boundingBox();
          const footer = await page.locator(".chat-footer").boundingBox();
          expect(bounds).toBeTruthy();
          expect(conversation).toBeTruthy();
          expect(footer).toBeTruthy();
          expect(bounds!.x).toBeGreaterThanOrEqual(conversation!.x);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
            conversation!.x + conversation!.width,
          );
          expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(footer!.y);
        };
        await geometry();
        await details.getByRole("button", { name: "Close details", exact: true }).click();
        await openChatSidePanelType(page, "browser");
        await trigger.click();
        await geometry();
        await capture("with-browser.png");
        await page.keyboard.press("Escape");
        await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
        await trigger.click();
        await page.setViewportSize({ width: 430, height: 900 });
        await geometry();
        await capture("narrow.png");
        expect(await gateway.getRequests("progressCard.put")).toHaveLength(0);
      },
    );
  });
});
