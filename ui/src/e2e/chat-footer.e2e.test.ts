import path from "node:path";
import type { CDPSession, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { CHAT_TRANSCRIPT_END_THRESHOLD_PX } from "../pages/chat/scroll.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails, openDetailsPullRequests } from "./chat-details.test-support.ts";
import {
  captureUiProofEnabled,
  chatThreadDistanceFromBottom,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { waitForWatchedSessionKey } from "./chat-github-publication.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat footer layout" });
const sessionKey = "agent:main:main";
const runId = "footer-verification";
const checksMethod = "controlUi.sessionPullRequests.checks";
const queuedMessages = ["Review the desktop", "Review the phone", "Record the result"];

async function activate(control: Locator, touch: boolean) {
  if (touch) {
    await control.tap();
  } else {
    await control.press("Enter");
  }
}

async function scrollDown(page: Page, point: { x: number; y: number }, client?: CDPSession) {
  if (!client) {
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, 160);
    return;
  }
  const distance = Math.min(160, point.y - 12);
  const contact = { ...point, id: 1 };
  const timestamp = Date.now() / 1000;
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [contact],
    timestamp,
  });
  for (let step = 1; step <= 7; step++) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ ...contact, y: point.y - (step * distance) / 7 }],
      timestamp: timestamp + step * 0.008,
    });
  }
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
    timestamp: timestamp + 0.057,
  });
}

async function expectInputReachable(page: Page) {
  const geometry = await page.locator(".agent-chat__input").evaluate((input) => {
    const bounds = input.getBoundingClientRect();
    const actions = [...input.querySelectorAll<HTMLElement>(".chat-send-btn")].filter(
      (action) => action.getClientRects().length > 0,
    );
    return {
      top: bounds.top,
      bottom: bounds.bottom,
      viewportHeight: innerHeight,
      actionsReachable:
        actions.length > 0 &&
        actions.every((action) => {
          const button = action.getBoundingClientRect();
          return action.contains(
            document.elementFromPoint(
              button.left + button.width / 2,
              button.top + button.height / 2,
            ),
          );
        }),
    };
  });
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.actionsReachable).toBe(true);
}

suite.define(() => {
  it.each([
    { label: "desktop", width: 1280, height: 900, touch: false },
    { label: "phone", width: 390, height: 568, touch: true },
  ])(
    "keeps PRs, run notices, dense context, and the input usable on $label",
    async ({ label, width, height, touch }) => {
      const proofDir = captureUiProofEnabled
        ? createControlUiE2eArtifactDir("chat-footer-" + label)
        : null;
      await suite.withPage(
        {
          ...createControlUiE2eContextOptions(),
          viewport: { width, height },
          hasTouch: touch,
          isMobile: touch,
        },
        async ({ page }) => {
          const touchClient = touch ? await page.context().newCDPSession(page) : undefined;
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          const capture = async (stage: string) => {
            if (proofDir) {
              await page.screenshot({
                path: path.join(proofDir, stage + ".png"),
                animations: "disabled",
              });
            }
          };
          const gateway = await installMockGateway(page, {
            sessionKey,
            featureMethods: [
              "chat.metadata",
              "chat.startup",
              "progressCard.get",
              SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
              checksMethod,
            ],
            historyMessages: Array.from({ length: 30 }, (_, index) => ({
              role: index % 2 ? "user" : "assistant",
              content: [
                {
                  type: "text",
                  text:
                    "Project verification " +
                    index +
                    ".\n\nThe workspace has been reviewed and the checks are complete.",
                },
              ],
              timestamp: index + 1,
            })),
            sessionInfo: { key: sessionKey, activeRunIds: [runId], hasActiveRun: true },
            inFlightRun: { runId, text: "Checking one more detail." },
            methodResponses: {
              [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
              "progressCard.get": { card: null },
              [checksMethod]: {
                owner: "example",
                repo: "demo",
                number: 42,
                headSha: "a".repeat(40),
                checks: [],
                rateLimited: false,
                status: "ready",
              },
            },
          });
          await page.goto(suite.server.baseUrl + "chat");
          const watchedKey = await waitForWatchedSessionKey(gateway);
          await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
            sessions: {
              [watchedKey]: {
                pullRequests: [
                  {
                    number: 42,
                    owner: "example",
                    repo: "demo",
                    branch: "fix/footer-layout",
                    title: "Improve chat layout",
                    url: "https://github.com/example/demo/pull/42",
                    state: "open",
                    headSha: "a".repeat(40),
                    checks: { state: "passing", passed: 12, failed: 0, skipped: 0, running: 0 },
                  },
                ],
                rateLimited: false,
                status: "ready",
              },
            },
          });
          const pullRequest = page.locator(".chat-pr");
          await openDetailsPullRequests(page);
          await pullRequest.waitFor();
          const thread = page.locator(".chat-thread");
          await page.getByText("Project verification 29.", { exact: false }).waitFor();
          await waitForChatScrollIdle(page);
          const readerAnchor = () =>
            thread.evaluate((element) => {
              const viewport = element.getBoundingClientRect();
              const first = [...element.querySelectorAll<HTMLElement>(".chat-virtual-row")].find(
                (row) => {
                  const bounds = row.getBoundingClientRect();
                  return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
                },
              );
              return {
                scrollTop: element.scrollTop,
                key: first?.dataset.virtualRowKey,
                offset: first ? first.getBoundingClientRect().top - viewport.top : null,
              };
            });
          await thread.press("Home");
          await waitForChatScrollIdle(page);
          const beforeNotice = await readerAnchor();
          expect(beforeNotice.key).toBeTruthy();
          expect(await chatThreadDistanceFromBottom(page)).toBeGreaterThan(
            CHAT_TRANSCRIPT_END_THRESHOLD_PX,
          );
          await gateway.emitGatewayEvent("chat", {
            sessionKey,
            runId,
            state: "error",
            errorMessage: "The verification run failed. Please try again.",
          });
          await page.locator(".chat-error").waitFor();
          await waitForChatScrollIdle(page);
          await capture("01-pr-and-error");

          // Details must keep PR actions outside the notice/input footer.
          const overlap = await pullRequest.evaluate((element) => {
            const row = element.getBoundingClientRect();
            const notice = document.querySelector(".chat-error")!.getBoundingClientRect();
            return Math.max(0, Math.min(row.bottom, notice.bottom) - Math.max(row.top, notice.top));
          });
          expect(overlap).toBe(0);
          await pullRequest.locator(".chat-pr__link").click({ trial: true });
          expect(await readerAnchor()).toEqual(beforeNotice);

          if (!touch) {
            const row = (await pullRequest.boundingBox())!;
            await scrollDown(page, { x: row.x + 8, y: row.y + 8 });
            await waitForChatScrollIdle(page);
            await expect
              .poll(() => thread.evaluate((element) => element.scrollTop))
              .toBe(beforeNotice.scrollTop);
          }

          const latest = page.locator('.chat-scroll-to-bottom[data-visible="true"]');
          await page.getByRole("button", { name: "Close details", exact: true }).click();
          await activate(latest, touch);
          await expect
            .poll(() => chatThreadDistanceFromBottom(page))
            .toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
          await waitForChatScrollIdle(page);
          const boundary = await thread.evaluate((element) => ({
            transcriptBottom: element.getBoundingClientRect().bottom,
            footerTop: document.querySelector(".chat-footer")!.getBoundingClientRect().top,
          }));
          expect(boundary.transcriptBottom).toBeLessThanOrEqual(boundary.footerTop);
          await expectInputReachable(page);
          await capture("02-latest-with-notice");

          await openDetailsPullRequests(page);
          await activate(pullRequest.locator(".chat-pr__checks-pill"), touch);
          await gateway.waitForRequest(checksMethod);
          const menu = page.locator(".chat-pr__checks-menu");
          await menu.waitFor({ state: "visible" });
          const menuBounds = (await menu.boundingBox())!;
          const contextBounds = (await page.locator(".chat-footer__context").boundingBox())!;
          expect(menuBounds.y).toBeLessThan(contextBounds.y);
          expect(menuBounds.y).toBeGreaterThanOrEqual(0);
          expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(height);
          await menu.getByRole("link", { name: "Open checks on GitHub" }).click({ trial: true });
          await capture("03-checks-menu");
          await page.keyboard.press("Escape");
          await expect.poll(() => menu.isVisible()).toBe(false);

          await gateway.setMethodResponse("progressCard.get", {
            card: {
              sessionKey,
              revision: 1,
              updatedAt: Date.now(),
              markdown:
                "Reviewing the project.\n\n" +
                "- Inspect the result and record the verification outcome.\n".repeat(16),
              steps: [
                { step: "Inspect the project", status: "completed" },
                { step: "Verify the changes", status: "in_progress" },
                { step: "Record the result", status: "pending" },
              ],
            },
          });
          await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 1 });
          const progress = page.locator('[data-progress-card-placement="details"]');
          await openChatDetails(page);
          await progress.waitFor();
          if ((await progress.getAttribute("open")) === null) {
            await activate(progress.locator("summary"), touch);
          }
          await progress.locator(".session-progress-card__body").waitFor({ state: "visible" });

          // Use the normal offline queue owner so nothing drains during the layout proof.
          await gateway.setOnline(false);
          await gateway.closeLatest();
          await page.locator(".agent-chat__input--offline").waitFor();
          const composer = page.locator(".agent-chat__composer-combobox textarea");
          for (const message of queuedMessages) {
            await composer.fill(message);
            await composer.press("Enter");
            await page.locator(".chat-queue__item", { hasText: message }).waitFor();
          }
          const draft = "Keep every control reachable while reviewing this long draft.\n".repeat(
            12,
          );
          await composer.fill(draft);
          const persistentContext = page.locator(".chat-footer__context");
          expect(await persistentContext.locator(".chat-queue__item").count()).toBe(3);
          await expectInputReachable(page);
          await capture("04-dense-context");

          // Progress scrolls inside Details rather than chaining into the queue.
          await openChatDetails(page);
          const details = page.locator('.chat-details[role="dialog"]');
          const body = progress.locator(".session-progress-card__body");
          await body.scrollIntoViewIfNeeded();
          await waitForChatScrollIdle(page);
          const beforeDetailsScroll = await thread.evaluate((element) => element.scrollTop);
          const bounds = (await details.boundingBox())!;
          const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
          await scrollDown(page, point, touchClient);
          await expect
            .poll(() => details.evaluate((element) => element.scrollTop))
            .toBeGreaterThan(0);
          await progress.locator(".session-progress-card__step").last().scrollIntoViewIfNeeded();
          await expectInputReachable(page);
          expect(await thread.evaluate((element) => element.scrollTop)).toBe(beforeDetailsScroll);
          expect(await persistentContext.locator(".session-progress-card, .chat-pr").count()).toBe(
            0,
          );
          await page.keyboard.press("Escape");
          const remove = page
            .locator(".chat-queue__item", { hasText: queuedMessages[2] })
            .locator(".chat-queue__remove");
          await activate(remove, touch);
          await expect.poll(() => page.locator(".chat-queue__item").count()).toBe(2);
          expect(await composer.inputValue()).toBe(draft);
          await expectInputReachable(page);
          await capture("05-context-scrolled");
          await waitForChatScrollIdle(page);
          if (!touch) {
            await persistentContext.evaluate((element) => {
              element.scrollTop = 0;
            });
            const visibleContext = (await persistentContext.boundingBox())!;
            await page.mouse.move(
              visibleContext.x + visibleContext.width / 2,
              visibleContext.y + 8,
            );
            await page.mouse.wheel(0, -160);
            await expect
              .poll(() => chatThreadDistanceFromBottom(page))
              .toBeGreaterThan(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
            await activate(latest, false);
            await waitForChatScrollIdle(page);
            // PRs/progress no longer create footer overflow. Queue enough real
            // messages to preserve the short-pane scroll/reachability contract.
            for (const message of ["Review narrow footer", "Check short canvas"]) {
              await composer.fill(message);
              await composer.press("Enter");
              await page.locator(".chat-queue__item", { hasText: message }).waitFor();
            }
            await composer.fill(draft);
            for (const paneHeight of [248, 200]) {
              await page.setViewportSize({ width, height: paneHeight });
              await waitForChatScrollIdle(page);
              await expectInputReachable(page);
              expect(
                await thread.evaluate((element) => element.clientHeight),
              ).toBeGreaterThanOrEqual(24);
              const contextHeight = await persistentContext.evaluate((element) => ({
                visible: element.clientHeight,
                content: element.scrollHeight,
              }));
              expect(contextHeight.visible).toBeGreaterThan(0);
              expect(contextHeight.content).toBeGreaterThan(contextHeight.visible);
              await capture("06-short-pane-" + paneHeight);
            }
          }
          expect(pageErrors).toEqual([]);
        },
      );
    },
  );
});
