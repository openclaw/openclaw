import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import {
  chatSessionListResponse,
  chatMessage,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  installPlainHttpClipboardCapture,
  copiedViaExec,
} from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import {
  expectAttribute,
  expectCount,
  expectText,
  expectVisible,
  expectFocused,
} from "./session-page.test-support.ts";

const suite = createChatFlowE2eSuite();
const workspace = "/workspace/openclaw";
const draft = "Keep my draft while I inspect Details.";
const scrollText = "Preserve the reading column, independent scrolling, and unsent draft. ".repeat(
  5,
);

function detailsRow(key: string, label: string, cwd: string, branch: string) {
  return {
    key,
    label,
    kind: "direct",
    updatedAt: 1,
    model: "demo-model",
    createdActor: { type: "human", id: "ada", label: "Ada" },
    spawnedCwd: cwd,
    worktree: { id: key, repoRoot: workspace, branch },
  };
}

async function captureDetails(page: Page, details: Locator, name: string, content: Locator[]) {
  const frame = await takeControlUiScreenshotFrame(
    page,
    content.length === 1 ? details : page.locator(".chat").first(),
    content,
    {
      animations: "disabled",
      elements: [details],
    },
  );
  await writeFile(
    path.join(suite.artifactDir, name),
    content.length === 1 ? frame.elements[0]!.png : frame.png,
  );
  if (content.length > 1) {
    await writeFile(path.join(suite.artifactDir, "panel-" + name), frame.elements[0]!.png);
  }
}

suite.define(() => {
  it("reveals Environment copy buttons on row hover, keyboard focus, and touch", async () => {
    const sessionKey = "agent:main:details-copy";
    for (const hasTouch of [false, true]) {
      await suite.withPage(
        { colorScheme: "dark", viewport: { width: 1728, height: 1000 }, hasTouch },
        async ({ page }) => {
          await installPlainHttpClipboardCapture(page);
          await installMockGateway(page, {
            sessionKey,
            agentModel: "example/demo-model",
            models: [{ id: "demo-model", name: "Demo model", provider: "example" }],
            methodResponses: {
              "sessions.list": chatSessionListResponse([
                detailsRow(
                  sessionKey,
                  "Environment copy controls",
                  workspace,
                  "feature/copy-controls",
                ),
              ]),
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          const details = page.locator(".chat-details");
          const environment = details.locator(".chat-details__environment");
          const pathButton = environment.getByRole("button", { name: "Copy path", exact: true });
          const branchButton = environment.getByRole("button", {
            name: "Copy branch name",
            exact: true,
          });
          await pathButton.waitFor();
          const opacity = (button: typeof pathButton) =>
            button.evaluate((el) => getComputedStyle(el).opacity);
          const capture = (name: string) => captureDetails(page, details, name, [environment]);
          if (!hasTouch) {
            await capture("environment-copy-rest.png");
            await expect.poll(() => opacity(pathButton)).toBe("0");
            await expect.poll(() => opacity(branchButton)).toBe("0");
            const restBounds = await pathButton.boundingBox();
            await environment
              .locator(".chat-details__row")
              .filter({ has: page.getByRole("button", { name: "Copy path", exact: true }) })
              .hover();
            await expect.poll(() => opacity(pathButton)).toBe("1");
            expect(await opacity(branchButton)).toBe("0");
            expect(await pathButton.boundingBox()).toEqual(restBounds);
            await capture("environment-copy-hover.png");
            await page.mouse.move(0, 0);
            await expect.poll(() => opacity(pathButton)).toBe("0");
            await environment.locator(":scope > summary").focus();
            await page.keyboard.press("Tab");
            await expectFocused(pathButton);
            expect(await opacity(pathButton)).toBe("1");
            await page.keyboard.press("Tab");
            await expectFocused(branchButton);
            expect(await opacity(branchButton)).toBe("1");
            await page.keyboard.press("Shift+Tab");
            await page.keyboard.press("Enter");
            await branchButton.focus();
            await page.keyboard.press("Enter");
          } else {
            await expect.poll(() => opacity(pathButton)).toBe("1");
            expect(await opacity(branchButton)).toBe("1");
            await pathButton.tap();
            await branchButton.tap();
          }
          await expect
            .poll(() => copiedViaExec(page))
            .toEqual(["/workspace/openclaw", "feature/copy-controls"]);
        },
      );
    }
  });
  it("docks Details in wide conversations and preserves manual intent, drafts, and independent scrolling", async () => {
    const sessionKey = "agent:main:details-progress";
    const progressCard = (
      revision: number,
      markdown: string,
      steps: { step: string; status: string }[],
    ) => ({
      card: { sessionKey, revision, updatedAt: Date.now(), markdown, steps },
    });
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
            chatMessage("user", "Show session context and task progress in Details."),
            chatMessage("assistant", "Session context and task progress remain separate."),
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
                  scheduleKind: "every",
                  schedule: { kind: "every", everyMs: 300_000 },
                },
              ],
              snapshotRevision: "details-1",
              offset: 0,
              limit: 50,
              total: 1,
              hasMore: false,
              nextOffset: null,
            },
            "progressCard.get": progressCard(
              1,
              "Integrating task progress into session Details. The UI is ready for focused interaction checks.",
              [
                { step: "Inspect the existing session owners", status: "completed" },
                { step: "Integrate Details and task progress", status: "completed" },
                { step: "Verify interactions and screenshots", status: "in_progress" },
                { step: "Review and land the change", status: "pending" },
              ],
            ),
            "sessions.list": chatSessionListResponse([
              {
                ...detailsRow(
                  sessionKey,
                  "Session Details and task progress",
                  workspace + "/session-details",
                  "feature/session-details",
                ),
                totalTokens: 64000,
                totalTokensFresh: true,
                contextTokens: 128000,
                inputTokens: 1200,
                outputTokens: 450,
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
                  checks: { state: "passing", passed: 12, failed: 0, skipped: 0, running: 0 },
                },
              ],
            },
          },
        });
        const trigger = page.getByRole("button", { name: "Details", exact: true });
        const details = page.locator(".chat-details");
        const progress = details.locator('[data-progress-card-placement="details"]');
        const progressOptions = progress.getByRole("button", {
          name: "Task progress options",
          exact: true,
        });
        const prGroup = details.locator('[data-details-group="pull-requests"]');
        const composer = page.getByRole("textbox", { name: "Chat composer", exact: true });
        await trigger.waitFor();
        await expectAttribute(details, "role", "complementary");
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");
        expect(await page.locator('[data-progress-card-placement="composer"]').count()).toBe(0);
        expect(await page.locator(".chat-footer .chat-pr").count()).toBe(0);
        await composer.fill(draft);
        await expectVisible(details, true);
        await expectVisible(progress, true);
        await expect.poll(() => prGroup.getAttribute("open")).not.toBeNull();
        const automations = details.locator('[data-details-group="automations"]');
        await expect.poll(() => automations.getAttribute("open")).not.toBeNull();
        expect(await automations.textContent()).toContain("Watch pull request checks");
        const pullRequest = details.locator(".chat-pr").first();
        await pullRequest.waitFor();
        const capture = async (name: string) => {
          expect(
            await details.evaluate((root) =>
              [
                root.querySelector(".session-progress-card")!,
                root.querySelector(".chat-details__group")!,
              ].every((element) => {
                const s = getComputedStyle(element);
                return (
                  s.borderTopStyle === "solid" &&
                  s.borderInlineEndWidth === "0px" &&
                  s.borderRadius === "0px"
                );
              }),
            ),
          ).toBe(true);
          await captureDetails(page, details, name, [details, progress, composer]);
        };

        expect(
          await details
            .locator(
              ".chat-details__toolbar, .chat-details__participants, .chat-details__meta-actions",
            )
            .count(),
        ).toBe(0);
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
        await expectAttribute(trigger, "aria-expanded", "false");
        await trigger.focus();
        await trigger.press("Enter");
        await expectAttribute(details, "role", "dialog");
        await page.keyboard.press("Tab");
        await expectFocused(details.locator(".chat-details__environment > summary"));

        await capture("overlay.png");
        await page.emulateMedia({ colorScheme: "dark" });
        await expectAttribute(page.locator("html"), "data-theme-mode", "dark");
        await capture("dark-overlay.png");
        await page.emulateMedia({ colorScheme: "light" });
        await expectAttribute(page.locator("html"), "data-theme-mode", "light");
        const checks = pullRequest.locator(".chat-pr__checks-pill");
        await checks.click();
        await expectVisible(pullRequest.locator(".chat-pr__checks-menu"), true);
        await page.keyboard.press("Escape");
        await expectVisible(pullRequest.locator(".chat-pr__checks-menu"), false);
        expect(await details.isVisible()).toBe(true);
        await page.keyboard.press("Escape");
        await expectVisible(details, false);
        expect(await trigger.evaluate((el) => el === document.activeElement)).toBe(true);
        expect(await composer.inputValue()).toBe(draft);
        await gateway.setMethodResponse(
          "progressCard.get",
          progressCard(2, "The card changed while Details stayed closed.", [
            { step: "Verify interactions and screenshots", status: "in_progress" },
          ]),
        );
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
        expect(await trigger.getAttribute("aria-expanded")).toBe("false");
        await trigger.click();
        await expectText(progress, "The card changed while Details stayed closed.");
        const menu = progress.locator(".chat-details-progress__menu");
        await progressOptions.click();
        await menu.locator('[data-value="hide"]').waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
        await progressOptions.click();
        await menu.locator('[data-value="hide"]').click();
        await expectCount(progress, 0);
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
        await expectCount(progress, 1);
        // The toast is outside Details; Undo restores the setting without reopening it.
        expect(await trigger.getAttribute("aria-expanded")).toBe("false");
        await trigger.click();
        await expectVisible(progress, true);
        await trigger.click();
        await page.setViewportSize({ width: 1728, height: 1000 });
        expect(await trigger.getAttribute("aria-expanded")).toBe("false");
        await trigger.click();
        await expectAttribute(details, "role", "complementary");

        await openChatSidePanelType(page, "browser");
        await expectAttribute(details, "role", "dialog");
        if ((await trigger.getAttribute("aria-expanded")) !== "true") {
          await trigger.click();
        }

        await capture("with-browser.png");
        await page.keyboard.press("Escape");
        await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
        expect(await trigger.getAttribute("aria-expanded")).toBe("false");
        await page.setViewportSize({ width: 430, height: 900 });
        await trigger.waitFor({ state: "hidden" });
        expect(await details.isVisible()).toBe(false);
        await page.getByRole("button", { name: "Panels", exact: true }).waitFor();
        await openChatDetails(page);
        await expectAttribute(details, "role", "dialog");

        await capture("narrow.png");
        await details.getByRole("button", { name: "Close details", exact: true }).click();
        await page.setViewportSize({ width: 1728, height: 1000 });
        expect(await trigger.getAttribute("aria-expanded")).toBe("false");
        await trigger.click();
        await expectAttribute(details, "role", "complementary");

        await composer.fill(draft);
        await gateway.setMethodResponse(
          "progressCard.get",
          progressCard(
            3,
            "Long task details must scroll independently from the conversation.",
            Array.from({ length: 24 }, (_, index) => ({
              step: `Verification step ${index + 1}: ${scrollText}`,
              status: index < 8 ? "completed" : index === 8 ? "in_progress" : "pending",
            })),
          ),
        );
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 3 });
        await expectText(progress, "Verification step 24");
        await gateway.emitChatFinal({
          runId: "details-long-transcript",
          text: Array.from(
            { length: 20 },
            (_, index) => `Layout check ${index + 1}: ${scrollText}`,
          ).join("\n\n"),
        });
        const thread = page.locator(".chat-thread");
        await expectText(thread, "Layout check 20");
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
        expect(await composer.inputValue()).toBe(draft);

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
        await expectCount(details.locator("[data-details-group=automations]"), 0);
        expect(await details.locator(".chat-pr").count()).toBe(0);
        await details.evaluate((element) => {
          element.scrollTop = 0;
        });
        await capture("empty.png");
        expect(await gateway.getRequests("progressCard.put")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
        await details.getByRole("button", { name: "Show session files", exact: true }).click();
        await gateway.waitForRequest("sessions.files.list");
      },
    );
  });
});
