import type { CDPSession, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { CHAT_TRANSCRIPT_END_THRESHOLD_PX } from "../pages/chat/scroll.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatTaskProgress } from "./chat-details.test-support.ts";
import {
  chatMessage,
  chatThreadDistanceFromBottom,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat footer layout" });
const sessionKey = "agent:main:main";
const runId = "footer-verification";
const queuedMessages = ["Review the desktop", "Review the phone", "Record the result"];
const activate = (control: Locator, touch: boolean) =>
  touch ? control.tap() : control.press("Enter");

async function scrollDown(page: Page, point: { x: number; y: number }, client?: CDPSession) {
  if (!client) {
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, 160);
    return;
  }
  const distance = Math.min(160, point.y - 12);
  const contact = { ...point, id: 1 };
  const timestamp = Date.now() / 1000;
  const dispatch = (
    type: "touchStart" | "touchMove" | "touchEnd",
    touchPoints: (typeof contact)[],
    elapsed: number,
  ) =>
    client.send("Input.dispatchTouchEvent", { type, touchPoints, timestamp: timestamp + elapsed });
  await dispatch("touchStart", [contact], 0);
  for (let step = 1; step <= 7; step++) {
    await dispatch("touchMove", [{ ...contact, y: point.y - (step * distance) / 7 }], step * 0.008);
  }
  await dispatch("touchEnd", [], 0.057);
}

async function expectInputReachable(page: Page) {
  const geometry = await page.locator(".agent-chat__input").evaluate((input) => {
    const bounds = input.getBoundingClientRect();
    const actions = [...input.querySelectorAll<HTMLElement>(".chat-send-btn")].filter(
      (action) => action.getClientRects().length > 0,
    );
    return {
      inViewport: bounds.top >= 0 && bounds.bottom <= innerHeight,
      actionsReachable:
        actions.length > 0 &&
        actions.every((action) => {
          const box = action.getBoundingClientRect();
          return action.contains(
            document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
          );
        }),
    };
  });
  expect(geometry).toEqual({ inViewport: true, actionsReachable: true });
}

async function verifyFooter(page: Page, width: number, height: number, touch: boolean) {
  const touchClient = touch ? await page.context().newCDPSession(page) : undefined;
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const gateway = await installMockGateway(page, {
    sessionKey,
    featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
    historyMessages: Array.from({ length: 30 }, (_, index) =>
      chatMessage(
        index % 2 ? "user" : "assistant",
        `Project verification ${index}.\n\nThe workspace has been reviewed and the checks are complete.`,
        { timestamp: index + 1 },
      ),
    ),
    sessionInfo: { key: sessionKey, activeRunIds: [runId], hasActiveRun: true },
    inFlightRun: { runId, text: "Checking one more detail." },
    methodResponses: {
      "progressCard.get": {
        card: {
          sessionKey,
          revision: 1,
          updatedAt: Date.now(),
          markdown:
            "Reviewing the project.\n\n" +
            "- Inspect the result and record the verification outcome.\n".repeat(16),
          steps: [
            { step: "Inspect the project", status: "completed" },
            { step: "Record the result", status: "pending" },
          ],
        },
      },
    },
  });
  await page.goto(suite.server.baseUrl + "chat");
  const thread = page.locator(".chat-thread");
  await page.getByText("Project verification 29.", { exact: false }).waitFor();
  await waitForChatScrollIdle(page);
  const progress = await openChatTaskProgress(page);
  if (!touch && (await progress.getAttribute("open")) === null) {
    await activate(progress.locator("summary"), touch);
  }
  const details = page
    .locator(touch ? ".chat-mobile-host" : ".chat-details")
    .filter({ visible: true });
  const body = progress.locator(".task-progress-details__plan");
  await body.waitFor({ state: "visible" });
  await waitForLayoutSettled(page, touch ? ".chat-mobile-host" : ".chat-details");
  await waitForChatScrollIdle(page);
  const readerAnchor = () =>
    thread.evaluate((element) => {
      const viewport = element.getBoundingClientRect();
      const first = [...element.querySelectorAll<HTMLElement>(".chat-virtual-row")].find((row) => {
        const bounds = row.getBoundingClientRect();
        return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
      });
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
  const notice = page.locator(".chat-error");
  await notice.waitFor();
  await waitForChatScrollIdle(page);
  const detailsBounds = (await details.boundingBox())!;
  const noticeBounds = (await notice.boundingBox())!;
  if (touch) {
    expect(noticeBounds.y + noticeBounds.height).toBeLessThanOrEqual(detailsBounds.y);
    expect(detailsBounds.y + detailsBounds.height).toBeLessThanOrEqual(height);
  } else {
    expect(detailsBounds.y + detailsBounds.height).toBeLessThanOrEqual(noticeBounds.y);
  }
  expect(await readerAnchor()).toEqual(beforeNotice);
  await closeChatDetails(page);
  const latest = page.locator('.chat-scroll-to-bottom[data-visible="true"]');
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

  await gateway.setOnline(false);
  await gateway.closeLatest();
  await page.locator(".agent-chat__input--offline").waitFor();
  const composer = page.locator(".agent-chat__composer-combobox textarea");
  const queue = async (messages: readonly string[]) => {
    for (const message of messages) {
      await composer.fill(message);
      await composer.press("Enter");
      await page.locator(".chat-queue__item", { hasText: message }).waitFor();
    }
  };
  await queue(queuedMessages);
  const draft = "Keep every control reachable while reviewing this long draft.\n".repeat(12);
  await composer.fill(draft);
  const persistentContext = page.locator(
    touch ? ".agent-chat__composer-shell" : ".chat-footer__context",
  );
  expect(await persistentContext.locator(".chat-queue__item").count()).toBe(3);
  await expectInputReachable(page);
  await openChatTaskProgress(page);
  await body.scrollIntoViewIfNeeded();
  await waitForChatScrollIdle(page);
  const beforeDetailsScroll = await thread.evaluate((element) => element.scrollTop);
  const scrollport = touch
    ? progress.locator(".chat-mobile-details-page__body")
    : details.locator(".chat-details-desktop-body");
  const bounds = (await scrollport.boundingBox())!;
  await scrollDown(
    page,
    { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
    touchClient,
  );
  await expect.poll(() => scrollport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expectInputReachable(page);
  expect(await thread.evaluate((element) => element.scrollTop)).toBe(beforeDetailsScroll);
  expect(await persistentContext.locator(".session-progress-card, .chat-pr").count()).toBe(0);
  await closeChatDetails(page);
  await activate(
    page
      .locator(".chat-queue__item", { hasText: queuedMessages[2] })
      .locator(".chat-queue__remove"),
    touch,
  );
  await expect.poll(() => page.locator(".chat-queue__item").count()).toBe(2);
  expect(await composer.inputValue()).toBe(draft);
  await expectInputReachable(page);
  if (!touch) {
    await persistentContext.evaluate((element) => {
      element.scrollTop = 0;
    });
    const box = (await persistentContext.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 8);
    await page.mouse.wheel(0, -160);
    await expect
      .poll(() => chatThreadDistanceFromBottom(page))
      .toBeGreaterThan(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
    await activate(latest, false);
    await waitForChatScrollIdle(page);
    await queue(["Review narrow footer", "Check short canvas"]);
    await composer.fill(draft);
    for (const paneHeight of [248, 200]) {
      await page.setViewportSize({ width, height: paneHeight });
      await waitForChatScrollIdle(page);
      await expectInputReachable(page);
      expect(await thread.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(24);
      const sizes = await persistentContext.evaluate((element) => [
        element.clientHeight,
        element.scrollHeight,
      ]);
      expect(sizes[0]).toBeGreaterThan(0);
      expect(sizes[1]).toBeGreaterThan(sizes[0]!);
    }
  }
  expect(pageErrors).toEqual([]);
}

suite.define(() => {
  it.each([
    { label: "desktop", width: 1280, height: 900, touch: false },
    { label: "phone", width: 390, height: 568, touch: true },
  ])(
    "keeps run notices, scrolling Details and queued input usable on $label",
    ({ width, height, touch }) =>
      suite.withPage(
        {
          ...createControlUiE2eContextOptions(),
          viewport: { width, height },
          hasTouch: touch,
          isMobile: touch,
        },
        ({ page }) => verifyFooter(page, width, height, touch),
      ),
  );
});
