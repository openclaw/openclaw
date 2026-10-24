import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import {
  polledAttribute,
  polledCount,
  polledText,
  polledVisible,
} from "./chat-presentation.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("opens inactive split-pane Details on the first click", async () => {
    const sessionKey = "agent:main:details-first-click";
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        sessionKey,
        historyMessages: [
          { role: "assistant", content: [{ type: "text", text: "Details first-click fixture." }] },
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await page.getByText("Details first-click fixture.", { exact: true }).waitFor();
      await selectChatLayoutAction(page, "Open split view");
      const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
      await polledCount(panes).toBe(2);
      const left = panes.first();
      await expect
        .poll(() =>
          left.evaluate((element) => element.classList.contains("chat-pane-cache__pane--active")),
        )
        .toBe(false);
      const details = left.locator(".chat-details");
      const neighborDetails = panes.last().locator(".chat-details");
      expect(await neighborDetails.isVisible()).toBe(false);
      await polledVisible(details).toBe(false);
      await left.getByRole("button", { name: "Details", exact: true }).click();
      await polledVisible(details).toBe(true);
      expect(await details.evaluate((element) => element.hasAttribute("inert"))).toBe(false);
      expect(await neighborDetails.isVisible()).toBe(false);
      await expect
        .poll(async () => Math.round((await details.boundingBox())?.width ?? 0))
        .toBe(300);
    });
  });

  it("docks Details in wide conversations and preserves manual intent, drafts, and independent scrolling", async () => {
    const sessionKey = "agent:main:details-progress";
    await suite.withPage(
      { colorScheme: "light", locale: "en-US", viewport: { width: 1728, height: 1000 } },
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
          ],
          historyMessages: [{ role: "assistant", content: "Session context and task progress." }],
          methodResponses: {
            "browser.request": {
              cases: [
                { match: { method: "GET", path: "/tabs" }, response: { running: false, tabs: [] } },
              ],
            },
            "sessions.files.list": {
              sessionKey,
              root: "/workspace/openclaw/session-details",
              gitCheckout: true,
              files: [],
              browser: { path: "", entries: [] },
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
                createdActor: { type: "human", id: "ada", label: "Ada" },
                spawnedCwd: "/workspace/openclaw/session-details",
                worktree: {
                  id: "details-tree",
                  repoRoot: "/workspace/openclaw",
                  branch: "feature/session-details",
                },
                model: "demo-model",
                totalTokens: 64000,
                totalTokensFresh: true,
                contextTokens: 128000,
                inputTokens: 1200,
                outputTokens: 450,
                updatedAt: 1,
              },
            ]),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const trigger = page
          .getByRole("button", { name: "Details", exact: true })
          .and(page.locator(".chat-details-toggle"));
        const details = page.locator(".chat-details:not(.chat-mobile-host .chat-details)");
        const detailsScroll = details.locator(".chat-details-desktop-body");
        const progress = details.locator('[data-progress-card-placement="details"]');
        const progressToggle = progress.locator(":scope > summary");
        const composer = page.getByRole("textbox", { name: "Chat composer", exact: true });
        await trigger.waitFor();
        await polledAttribute(details, "role").toBe("complementary");
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");
        expect(await page.locator('[data-progress-card-placement="composer"]').count()).toBe(0);
        expect(await page.locator(".chat-footer .chat-pr").count()).toBe(0);
        await composer.fill("Keep my draft while I inspect Details.");
        await polledVisible(details).toBe(true);
        await polledVisible(progress).toBe(true);
        const waitForLayoutToSettle = async (surface: Locator) => {
          // Surface motion and the desktop/mobile conversation reservation settle separately.
          await expect
            .poll(() =>
              surface.evaluate((panel) => {
                const measured = [
                  panel,
                  ...document.querySelectorAll(
                    ".chat-main__conversation-frame, .chat-main__conversation, .chat-footer, .agent-chat__input--chat",
                  ),
                ];
                const layout = new Set<Element>();
                for (const measuredElement of measured) {
                  for (
                    let element: Element | null = measuredElement;
                    element;
                    element = element.parentElement
                  ) {
                    layout.add(element);
                  }
                }
                return [...layout].every((element) =>
                  element
                    .getAnimations()
                    .every(
                      (animation) =>
                        !Number.isFinite(animation.effect?.getComputedTiming().endTime) ||
                        animation.playState === "finished",
                    ),
                );
              }),
            )
            .toBe(true);
        };
        const environment = details.locator('[data-details-group="environment"]');
        expect(await environment.textContent()).toContain("feature/session-details");
        expect(await environment.textContent()).not.toContain(
          "/workspace/openclaw/session-details",
        );
        const context = details.locator('[data-details-group="context"]');
        expect(await context.locator("summary").textContent()).toContain("50%");
        await context.locator("summary").click();
        expect(await context.textContent()).toContain("64k / 128k");
        await context.locator("summary").click();
        // A dock is nonmodal: composing, including Escape, must not close it.
        await composer.click();
        await page.keyboard.press("Escape");
        expect(await details.isVisible()).toBe(true);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await polledAttribute(trigger, "aria-expanded").toBe("false");
        await trigger.focus();
        await trigger.press("Enter");
        await polledAttribute(details, "role").toBe("dialog");
        // Desktop Details is nonmodal; verify Tab between its native sections.
        await details.locator('[data-details-group="people"] > summary').focus();
        await page.keyboard.press("Tab");
        await expect
          .poll(() =>
            environment.locator(":scope > summary").evaluate((el) => el === document.activeElement),
          )
          .toBe(true);
        await page.keyboard.press("Tab");
        await expect
          .poll(() =>
            context.locator(":scope > summary").evaluate((el) => el === document.activeElement),
          )
          .toBe(true);
        await page.emulateMedia({ colorScheme: "dark" });
        await polledAttribute(page.locator("html"), "data-theme-mode").toBe("dark");
        await page.emulateMedia({ colorScheme: "light" });
        await polledAttribute(page.locator("html"), "data-theme-mode").toBe("light");
        expect(await progress.getAttribute("open")).not.toBeNull();
        await progressToggle.click();
        await polledAttribute(progress, "open").toBeNull();
        expect(
          await progress
            .getByRole("button", { name: "Task progress options", exact: true })
            .isVisible(),
        ).toBe(true);
        await progressToggle.click();
        await page.keyboard.press("Escape");
        await polledVisible(details).toBe(false);
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
        await polledText(progress).toContain("The card changed while Details stayed closed.");
        const menu = progress.locator(".chat-details-progress__menu");
        expect(await menu.locator('[role^="menuitem"]:visible').count()).toBe(0);
        await progress.getByRole("button", { name: "Task progress options", exact: true }).click();
        await menu.locator('[data-value="hide"]').waitFor({ state: "visible" });
        expect(await menu.locator('[role^="menuitem"]').count()).toBe(6);
        await page.keyboard.press("Escape");
        await polledCount(menu.locator('[role^="menuitem"]')).toBe(0);
        await progress.getByRole("button", { name: "Task progress options", exact: true }).click();
        await menu.locator('[data-value="hide"]').click();
        await polledCount(progress).toBe(1);
        expect(await details.isVisible()).toBe(false);
        const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
        const showSetting = () =>
          page.evaluate(
            (key) => JSON.parse(localStorage.getItem(key) ?? "{}").chatShowTaskProgress,
            settingsKey,
          );
        await expect.poll(showSetting).toBe(false);
        await page.getByRole("button", { name: "Undo", exact: true }).click();
        await expect.poll(showSetting).not.toBe(false);
        await polledCount(progress).toBe(1);
        // The toast is outside Details; Undo restores the setting without reopening it.
        expect(await trigger.getAttribute("aria-expanded")).toBe("false");
        await trigger.click();
        await polledVisible(progress).toBe(true);
        await progress.getByRole("button", { name: "Task progress options", exact: true }).click();
        await menu.locator('[data-value="collapse"]').click();
        expect(await progress.getAttribute("open")).not.toBeNull();
        await progress.getByRole("button", { name: "Task progress options", exact: true }).click();
        await menu.locator('[data-value="hide"]').click();
        await expect.poll(showSetting).toBe(false);
        await page.reload();
        await trigger.waitFor();
        await trigger.click();
        await polledCount(progress).toBe(1);
        expect(await page.locator('[data-progress-card-placement="composer"]').count()).toBe(0);
        await gateway.waitForRequest("progressCard.get");
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
        await expect.poll(showSetting).not.toBe(false);
        await polledVisible(progress).toBe(true);
        await polledAttribute(progress, "open").toBeNull();
        await settingsPage.close();
        await progressToggle.click();
        await trigger.click();
        await page.setViewportSize({ width: 1728, height: 1000 });
        expect(await trigger.getAttribute("aria-expanded")).toBe("false");
        await trigger.click();
        await polledAttribute(details, "role").toBe("complementary");
        await openChatSidePanelType(page, "browser");
        await polledAttribute(details, "role").toBe("dialog");
        if ((await trigger.getAttribute("aria-expanded")) !== "true") {
          await trigger.click();
        }
        await page.keyboard.press("Escape");
        await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
        expect(await trigger.getAttribute("aria-expanded")).toBe("false");
        await page.setViewportSize({ width: 430, height: 900 });
        await trigger.waitFor({ state: "hidden" });
        expect(await details.isVisible()).toBe(false);
        const mobileDetails = await openChatDetails(page);
        const mobileProgress = mobileDetails.locator('[data-details-destination="task-progress"]');
        await mobileProgress.waitFor();
        expect(await mobileDetails.getAttribute("data-mode")).toBe("dock");
        await waitForLayoutToSettle(mobileDetails);
        const mobileBounds = await mobileDetails.boundingBox();
        const mobileComposer = await page.locator(".agent-chat__input--chat").boundingBox();
        expect(mobileBounds).toBeTruthy();
        expect(mobileComposer).toBeTruthy();
        expect(mobileBounds!.x).toBeGreaterThanOrEqual(0);
        expect(mobileBounds!.x + mobileBounds!.width).toBeLessThanOrEqual(430);
        expect(mobileBounds!.y).toBeGreaterThanOrEqual(
          mobileComposer!.y + mobileComposer!.height - 1,
        );
        expect(mobileBounds!.y + mobileBounds!.height).toBeLessThanOrEqual(900);
        expect(await mobileDetails.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(await composer.inputValue()).toBe("Keep my draft while I inspect Details.");
        await mobileProgress.click();
        await mobileDetails.getByRole("button", { name: "Back", exact: true }).waitFor();
        await closeChatDetails(page);
        await expect
          .poll(() =>
            page
              .locator(".mobile-header__title")
              .evaluate((element) => element === document.activeElement),
          )
          .toBe(true);
        await page.setViewportSize({ width: 1728, height: 1000 });
        expect(await trigger.getAttribute("aria-expanded")).toBe("false");
        await trigger.click();
        await polledAttribute(details, "role").toBe("complementary");
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
        await polledText(progress).toContain("Verification step 24");
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
        await polledText(thread).toContain("Layout check 20");
        await thread.hover();
        await page.mouse.wheel(0, 10000);
        await expect
          .poll(() => thread.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
          .toBeLessThan(2);
        const threadTop = await thread.evaluate((el) => el.scrollTop);
        expect(threadTop).toBeGreaterThan(0);
        await detailsScroll.hover();
        await page.mouse.wheel(0, 600);
        await expect.poll(() => detailsScroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        expect(await thread.evaluate((el) => el.scrollTop)).toBe(threadTop);
        expect(await composer.inputValue()).toBe("Keep my draft while I inspect Details.");
        const detailsTop = await detailsScroll.evaluate((el) => el.scrollTop);
        await thread.hover();
        await page.mouse.wheel(0, -600);
        await expect.poll(() => thread.evaluate((el) => el.scrollTop)).toBeLessThan(threadTop);
        expect(await detailsScroll.evaluate((el) => el.scrollTop)).toBe(detailsTop);
        expect(await gateway.getRequests("progressCard.put")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
        await openChatSidePanelType(page, "Files");
        await gateway.waitForRequest("sessions.files.list");
      },
    );
  });
});
