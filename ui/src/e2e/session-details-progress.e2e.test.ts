import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
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
      await expect.poll(() => panes.count()).toBe(2);
      const left = panes.first();
      await expect
        .poll(() =>
          left.evaluate((element) => element.classList.contains("chat-pane-cache__pane--active")),
        )
        .toBe(false);
      const details = left.locator(".chat-details");
      const neighborDetails = panes.last().locator(".chat-details");
      expect(await neighborDetails.isVisible()).toBe(false);
      await expect.poll(() => details.isVisible()).toBe(false);
      await left.getByRole("button", { name: "Details", exact: true }).click();
      await expect.poll(() => details.isVisible()).toBe(true);
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
            "sessions.files.list": {
              sessionKey,
              root: "/workspace/openclaw/session-details",
              gitCheckout: true,
              files: [],
              browser: { path: "", entries: [] },
            },
            "cron.list": {
              jobs: [
                {
                  id: "details-watcher",
                  name: "Watch pull request checks",
                  agentId: "main",
                  enabled: true,
                  updatedAtMs: 1,
                  nextRunAt: null,
                  nextRunAtMs: null,
                  scheduleKind: "every",
                  schedule: { kind: "every", everyMs: 300_000 },
                  lastRunAt: null,
                  lastRunAtMs: null,
                  lastRunStatus: null,
                  lastRunError: null,
                },
              ],
              snapshotRevision: "details-1",
              offset: 0,
              limit: 50,
              total: 1,
              hasMore: false,
              nextOffset: null,
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
        const trigger = page
          .getByRole("button", { name: "Details", exact: true })
          .and(page.locator(".chat-details-toggle"));
        const details = page.locator(".chat-details:not(.chat-mobile-host .chat-details)");
        const detailsScroll = details.locator(".chat-details-desktop-body");
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
        await expect.poll(() => prGroup.getAttribute("open")).not.toBeNull();
        const automations = details.locator('[data-details-group="automations"]');
        await expect.poll(() => automations.getAttribute("open")).not.toBeNull();
        expect(await automations.textContent()).toContain("Watch pull request checks");
        const pullRequest = details.locator(".chat-pr").first();
        await pullRequest.waitFor();
        const capture = async (
          name: string,
          visibleDetails = details,
          visibleProgress = progress,
        ) => {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".chat").first(),
            [visibleDetails, visibleProgress, composer],
            { animations: "disabled", elements: [visibleDetails] },
          );
          await writeFile(path.join(suite.artifactDir, name), frame.png);
          await writeFile(path.join(suite.artifactDir, "panel-" + name), frame.elements[0]!.png);
        };
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
        const geometry = async (docked: boolean) => {
          await expect.poll(() => details.getAttribute("data-open")).not.toBeNull();
          await waitForLayoutToSettle(details);
          const { bounds, frame, conversation, footer, input, contained } = await details.evaluate(
            (element) => {
              const document = element.ownerDocument;
              const box = (node: Element | null) => {
                if (!node) {
                  return null;
                }
                const { x, y, width, height } = node.getBoundingClientRect();
                return { x, y, width, height };
              };
              return {
                bounds: box(element),
                frame: box(document.querySelector(".chat-main__conversation-frame")),
                conversation: box(document.querySelector(".chat-main__conversation")),
                footer: box(document.querySelector(".chat-footer")),
                input: box(document.querySelector(".agent-chat__input--chat")),
                contained: element.scrollWidth <= element.clientWidth,
              };
            },
          );
          expect(bounds).toBeTruthy();
          expect(frame).toBeTruthy();
          expect(conversation).toBeTruthy();
          expect(footer).toBeTruthy();
          expect(input).toBeTruthy();
          expect(bounds!.x).toBeGreaterThanOrEqual(frame!.x);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 1);
          expect(bounds!.width).toBe(300);
          // Both desktop presentations hug content within the conversation frame.
          expect(Math.abs(bounds!.y - (frame!.y + 8))).toBeLessThanOrEqual(1);
          expect(
            Math.abs(bounds!.x + bounds!.width - (frame!.x + frame!.width - 13)),
          ).toBeLessThanOrEqual(1);
          expect(bounds!.height).toBeLessThanOrEqual(frame!.height - 16 + 1);
          expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(frame!.y + frame!.height - 8 + 1);
          expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(input!.y + input!.height + 1);
          if (docked) {
            expect(conversation!.x + conversation!.width).toBeLessThanOrEqual(bounds!.x + 1);
            expect(footer!.x + footer!.width).toBeLessThanOrEqual(bounds!.x + 1);
          }
          expect(contained).toBe(true);
        };
        await geometry(true);
        expect(await details.locator(".chat-details__toolbar").count()).toBe(0);
        expect(await details.locator(".chat-details__participants").count()).toBe(0);
        expect(await details.locator(".chat-details__meta-actions").count()).toBe(0);
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
        await geometry(false);
        await capture("overlay.png");
        await page.emulateMedia({ colorScheme: "dark" });
        await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");
        await capture("dark-overlay.png");
        await page.emulateMedia({ colorScheme: "light" });
        await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("light");
        expect(await session.locator(":scope > summary").count()).toBe(0);
        expect(await progress.getAttribute("open")).not.toBeNull();
        await progressToggle.click();
        await expect.poll(() => progress.getAttribute("open")).toBeNull();
        expect(
          await progress
            .getByRole("button", { name: "Task progress options", exact: true })
            .isVisible(),
        ).toBe(true);
        expect(await session.isVisible()).toBe(true);
        await progressToggle.click();
        await pullRequest.locator(".chat-pr__actions-trigger").click();
        const prMenu = pullRequest.locator('.chat-pr__actions [role="menu"]').first();
        await prMenu.locator('[data-value="checks"]').click();
        const checksPage = prMenu.locator('.chat-pr-menu__page[aria-label="Checks"]');
        await expect.poll(() => checksPage.isVisible()).toBe(true);
        await page.keyboard.press("Escape");
        await expect.poll(() => checksPage.isVisible()).toBe(false);
        expect(await prMenu.isVisible()).toBe(true);
        expect(await details.isVisible()).toBe(true);
        await page.keyboard.press("Escape");
        await expect.poll(() => prMenu.isVisible()).toBe(false);
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
        expect(await menu.locator('[role^="menuitem"]:visible').count()).toBe(0);
        await progress.getByRole("button", { name: "Task progress options", exact: true }).click();
        await menu.locator('[data-value="hide"]').waitFor({ state: "visible" });
        expect(await menu.locator('[role^="menuitem"]').count()).toBe(6);
        await page.keyboard.press("Escape");
        await expect.poll(() => menu.locator('[role^="menuitem"]').count()).toBe(0);
        await progress.getByRole("button", { name: "Task progress options", exact: true }).click();
        await menu.locator('[data-value="hide"]').click();
        await expect.poll(() => progress.count()).toBe(1);
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
        await expect.poll(() => progress.count()).toBe(1);
        // The toast is outside Details; Undo restores the setting without reopening it.
        expect(await trigger.getAttribute("aria-expanded")).toBe("false");
        await trigger.click();
        await expect.poll(() => progress.isVisible()).toBe(true);
        await progress.getByRole("button", { name: "Task progress options", exact: true }).click();
        await menu.locator('[data-value="collapse"]').click();
        expect(await progress.getAttribute("open")).not.toBeNull();
        await progress.getByRole("button", { name: "Task progress options", exact: true }).click();
        await menu.locator('[data-value="hide"]').click();
        await expect.poll(showSetting).toBe(false);
        await page.reload();
        await trigger.waitFor();
        await trigger.click();
        await expect.poll(() => progress.count()).toBe(1);
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
        await expect.poll(() => progress.isVisible()).toBe(true);
        await expect.poll(() => progress.getAttribute("open")).toBeNull();
        await settingsPage.close();
        await progressToggle.click();
        await geometry(false);
        await trigger.click();
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
        await capture("narrow.png", mobileDetails, mobileProgress);
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
        await detailsScroll.hover();
        await page.mouse.wheel(0, 600);
        await expect.poll(() => detailsScroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        expect(await thread.evaluate((el) => el.scrollTop)).toBe(threadTop);
        expect(await composer.inputValue()).toBe("Keep my draft while I inspect Details.");
        await geometry(true);
        await capture("long-details.png");
        const detailsTop = await detailsScroll.evaluate((el) => el.scrollTop);
        await thread.hover();
        await page.mouse.wheel(0, -600);
        await expect.poll(() => thread.evaluate((el) => el.scrollTop)).toBeLessThan(threadTop);
        expect(await detailsScroll.evaluate((el) => el.scrollTop)).toBe(detailsTop);
        await gateway.setMethodResponse("cron.list", {
          jobs: [],
          snapshotRevision: "details-empty",
          offset: 0,
          limit: 50,
          total: 0,
          hasMore: false,
          nextOffset: null,
        });
        await gateway.emitGatewayEvent("cron", { action: "removed" });
        await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
          sessions: { [sessionKey]: { pullRequests: [] } },
        });
        await expect
          .poll(() => details.locator("[data-details-group=automations]").count())
          .toBe(0);
        expect(await details.locator(".chat-pr").count()).toBe(0);
        await detailsScroll.evaluate((element) => {
          element.scrollTop = 0;
        });
        await capture("empty.png");
        expect(await gateway.getRequests("progressCard.put")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
        await openChatSidePanelType(page, "Files");
        await gateway.waitForRequest("sessions.files.list");
      },
    );
  });
});
