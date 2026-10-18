import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
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
        await expect.poll(() => prGroup.getAttribute("open")).not.toBeNull();
        const automations = details.locator('[data-details-group="automations"]');
        await expect.poll(() => automations.getAttribute("open")).not.toBeNull();
        expect(await automations.textContent()).toContain("Watch pull request checks");
        const pullRequest = details.locator(".chat-pr").first();
        await pullRequest.waitFor();
        const capture = async (name: string) => {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".chat").first(),
            [details, progress, composer],
            { animations: "disabled", elements: [details] },
          );
          expect(
            await details.evaluate((root) => {
              const card = root.querySelector('[data-progress-card-placement="details"]')!;
              const group = root.querySelector(".chat-details__group")!;
              return [card, group].every((element) => {
                const style = getComputedStyle(element);
                return (
                  style.borderTopWidth === (element === card ? "0px" : "1px") &&
                  (element === card || style.borderTopStyle === "solid") &&
                  style.borderInlineStartWidth === "0px" &&
                  style.borderBottomWidth === "0px" &&
                  style.borderInlineEndWidth === "0px" &&
                  style.borderRadius === "0px"
                );
              });
            }),
          ).toBe(true);
          await writeFile(path.join(suite.artifactDir, name), frame.png);
          await writeFile(path.join(suite.artifactDir, "panel-" + name), frame.elements[0]!.png);
        };
        const geometry = async (docked: boolean) => {
          const { bounds, frame, conversation, footer, contained } = await details.evaluate(
            async (element) => {
              const document = element.ownerDocument;
              const frameElement = document.querySelector(".chat-main__conversation-frame");
              const conversationElement = document.querySelector(".chat-main__conversation");
              const footerElement = document.querySelector(".chat-footer");
              // Role/visibility commit before the desktop inset and frame transitions finish.
              const animations = [
                element,
                frameElement,
                conversationElement,
                footerElement,
                frameElement?.closest(".sidebar-region"),
              ]
                .flatMap((node) => node?.getAnimations() ?? [])
                .filter((animation) =>
                  Number.isFinite(animation.effect?.getComputedTiming().endTime),
                );
              await Promise.allSettled(animations.map((animation) => animation.finished));
              const box = (node: Element | null) => {
                if (!node) {
                  return null;
                }
                const { x, y, width, height } = node.getBoundingClientRect();
                return { x, y, width, height };
              };
              return {
                bounds: box(element),
                frame: box(frameElement),
                conversation: box(conversationElement),
                footer: box(footerElement),
                contained: element.scrollWidth <= element.clientWidth,
              };
            },
          );
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
        const context = details.locator(".chat-details__context");
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
        expect(await details.locator(".chat-details__participants").count()).toBe(0);
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
        expect(await menu.locator('[role^="menuitem"]').count()).toBe(6);
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
        expect(await progress.count()).toBe(1);
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
        await page.getByRole("button", { name: "Panels", exact: true }).waitFor();
        await openChatDetails(page);
        await expect.poll(() => details.getAttribute("role")).toBe("dialog");
        const mobileHost = page.locator(".chat-mobile-host");
        expect(await mobileHost.getAttribute("data-mode")).toBe("dock");
        const mobileGeometry = await mobileHost.evaluate(async (element) => {
          const input = element.ownerDocument.querySelector(".agent-chat__input--chat");
          const animations = [element, element.closest(".sidebar-region"), input]
            .flatMap((node) => node?.getAnimations() ?? [])
            .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime));
          await Promise.allSettled(animations.map((animation) => animation.finished));
          const bounds = element.getBoundingClientRect();
          return {
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
            bottom: bounds.bottom,
            composerBottom: input?.getBoundingClientRect().bottom,
            contained: element.scrollWidth <= element.clientWidth,
          };
        });
        expect(mobileGeometry.composerBottom).toBeDefined();
        expect(mobileGeometry.left).toBeGreaterThanOrEqual(0);
        expect(mobileGeometry.right).toBeLessThanOrEqual(430);
        expect(mobileGeometry.top).toBeGreaterThanOrEqual(mobileGeometry.composerBottom! - 1);
        expect(mobileGeometry.bottom).toBeLessThanOrEqual(900);
        expect(mobileGeometry.contained).toBe(true);
        expect(await details.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(await composer.inputValue()).toBe("Keep my draft while I inspect Details.");
        await capture("narrow.png");
        await mobileHost.getByRole("button", { name: "Close", exact: true }).click();
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
        await details.evaluate((element) => {
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
