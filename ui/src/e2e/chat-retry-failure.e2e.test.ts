import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { assert, expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatModelPicker } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI retry and terminal failure" });
const sessionKey = "agent:main:main";
const summary = "⚠️ The AI service needs a short break. Please try again in a few minutes.";
const partial = "I found the relevant code. I’m checking the remaining call sites.";

type Gateway = Awaited<ReturnType<typeof installMockGateway>>;
type Payload = Record<string, unknown>;
const prompt = "Review the remaining call sites and summarize the changes.";
const textContent = (text: string) => [{ type: "text", text }];
function message(
  role: string,
  content: unknown,
  timestamp: number,
  [id, seq, runId]: [string, number, string],
  extra: Payload = {},
) {
  const identity = role === "user" ? { idempotencyKey: runId + ":user" } : { runId };
  return { role, content, timestamp, __openclaw: { id, seq, ...identity }, ...extra };
}
function chat(gateway: Gateway, runId: string, state: string, payload: Payload) {
  return gateway.emitGatewayEvent("chat", { sessionKey, runId, state, ...payload });
}
function paragraph(page: Page, text: string) {
  return page.locator(".chat-thread").getByRole("paragraph").filter({ hasText: text });
}
async function openRun(page: Page) {
  const gateway = await installMockGateway(page, { sessionKey });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  await page.locator(".agent-chat__input textarea").fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  const send = await gateway.waitForRequest("chat.send");
  assert(isRecord(send.params) && typeof send.params.idempotencyKey === "string");
  return { gateway, runId: send.params.idempotencyKey };
}
async function receipt(
  gateway: Gateway,
  runId: string,
  entry: unknown,
  messageId: string,
  messageSeq: number,
) {
  await gateway.emitGatewayEvent("session.message", {
    sessionKey,
    runId,
    clientRunId: runId,
    message: entry,
    messageId,
    messageSeq,
    hasActiveRun: true,
    activeRunIds: [runId],
  });
}

suite.define(() => {
  it("preserves restart partials and a neutral durable recovery notice through reload", async () => {
    await suite.withPage({ viewport: { width: 1160, height: 850 } }, async ({ page }) => {
      // Synthetic Gateway I/O: this proves the UI contract, not an actual Gateway restart.
      const { gateway, runId } = await openRun(page);
      const successorRunId = "restart-recovery-successor";
      const now = Date.now();
      const historyMessages = [
        message("user", prompt, now - 3, ["restart-input", 1, runId]),
        message("assistant", textContent(partial), now - 2, ["restart-partial", 2, runId], {
          stopReason: "aborted",
        }),
        message(
          "user",
          "[System] Continue the interrupted turn.",
          now - 1,
          ["restart-recovery-input", 3, successorRunId],
          { provenance: { kind: "internal_system", sourceTool: "system-event" } },
        ),
        message("assistant", textContent("The review is complete."), now, [
          "restart-final",
          4,
          successorRunId,
        ]),
      ];
      const thread = page.locator(".chat-thread");
      const partialOutput = thread.getByRole("paragraph").filter({ hasText: partial });
      await chat(gateway, runId, "delta", {
        seq: 1,
        message: { role: "assistant", content: textContent(partial) },
      });
      await partialOutput.waitFor();
      await gateway.setHistoryMessages(historyMessages.slice(0, 2));
      await receipt(gateway, runId, historyMessages[1], "restart-partial", 2);
      await chat(gateway, runId, "aborted", {
        stopReason: "restart",
        seq: 2,
        message: historyMessages[1],
      });
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ state: "hidden" });
      expect(await partialOutput.count()).toBe(1);
      expect(await page.locator(".chat-run-failure, .chat-error").count()).toBe(0);

      // Recovery is admitted by the Gateway's durable system input, never a UI retry/send.
      await gateway.setHistoryMessages(historyMessages.slice(0, 3));
      await receipt(gateway, successorRunId, historyMessages[2], "restart-recovery-input", 3);
      const notice = thread.locator(".chat-notice", { hasText: "System · restart recovery" });
      await notice.waitFor();
      expect(await notice.locator(".chat-notice__body").count()).toBe(0);
      expect(await notice.getAttribute("role")).toBeNull();
      expect(await notice.locator("button").count()).toBe(0);
      await chat(gateway, successorRunId, "delta", {
        seq: 1,
        message: historyMessages[3],
      });
      await gateway.setHistoryMessages(historyMessages);
      await chat(gateway, successorRunId, "final", {
        seq: 2,
        message: historyMessages[3],
      });
      const answer = thread.getByRole("paragraph").filter({ hasText: "The review is complete." });
      await answer.waitFor();
      expect(await partialOutput.count()).toBe(1);
      expect(await notice.count()).toBe(1);
      expect(await page.locator(".chat-run-failure, .chat-error").count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);

      await gateway.setMethodResponse("chat.history", { messages: historyMessages });
      await page.reload();
      await answer.waitFor();
      await notice.waitFor();
      expect(await partialOutput.count()).toBe(1);
      expect(await notice.locator(".chat-notice__body").count()).toBe(0);
      expect(await page.locator(".chat-run-failure, .chat-error").count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it("keeps recovery in the claw row and retires it when the run resumes", async () => {
    await suite.withPage({ viewport: { width: 1160, height: 850 } }, async ({ page }) => {
      await page.clock.install();
      const { gateway, runId } = await openRun(page);
      await page.getByRole("button", { name: "Stop generating" }).waitFor();
      await pauseVirtualClock(page);
      const now = await page.evaluate(() => Date.now());
      await gateway.emitGatewayEvent("agent", {
        runId,
        sessionKey,
        stream: "run_status",
        seq: 10,
        ts: now,
        data: {
          phase: "retrying",
          message: "Rate limited. Retrying in 8 seconds (attempt 2/8).",
          retryAt: now + 8_000,
        },
      });
      const status = page.locator(".chat-working-indicator__status");
      // The first live event can load its owner before scheduling the presentation frame.
      await expect
        .poll(async () => {
          await page.clock.runFor(32);
          return status.textContent();
        })
        .toContain("Retrying in 8s");
      expect(await page.locator(".chat-run-failure, .chat-error").count()).toBe(0);
      expect(await status.locator(".chat-working-indicator__elapsed").count()).toBe(1);
      await page.clock.runFor(8_000);
      await expect.poll(() => status.textContent()).toContain("Retrying…");
      await gateway.emitGatewayEvent("agent", {
        runId,
        sessionKey,
        stream: "lifecycle",
        seq: 11,
        ts: now + 8_000,
        data: {
          phase: "fallback_step",
          fallbackStepFromModel: "example/primary",
          fallbackStepToModel: "example/fallback",
          fallbackStepFinalOutcome: "next_fallback",
        },
      });
      await page.clock.runFor(32);
      await expect.poll(() => status.textContent()).toContain("Trying fallback model…");
      await gateway.emitGatewayEvent("agent", {
        runId,
        sessionKey,
        stream: "assistant",
        seq: 12,
        ts: now + 8_001,
        data: { text: "Continuing the review." },
      });
      await page.clock.runFor(32);
      await expect.poll(() => status.count()).toBe(0);
      await page.getByRole("button", { name: "Stop generating" }).waitFor();
      await gateway.emitChatFinal({ runId, text: "The review is complete." });
      await page.clock.runFor(32);
      await paragraph(page, "The review is complete.").waitFor();
      expect(await page.locator(".chat-run-failure, .chat-error").count()).toBe(0);
    });
  });

  it("renders one durable terminal notice, preserves partial output and offers safe recovery", async () => {
    await suite.withPage({ viewport: { width: 1160, height: 850 } }, async ({ page }) => {
      const { gateway, runId } = await openRun(page);
      await page.getByRole("button", { name: "Stop generating" }).waitFor();
      const now = Date.now();
      const historyMessages = [
        message("user", prompt, now - 3, ["input", 1, runId]),
        message("assistant", partial, now - 2, ["partial", 2, runId]),
        message("custom", summary, now - 1, ["failure", 3, runId], {
          customType: "run-failed-before-reply",
          openclawRunError: { runId, summary },
        }),
      ];
      await gateway.setHistoryMessages(historyMessages.slice(0, 2));
      await receipt(gateway, runId, historyMessages[1], "partial", 2);
      await paragraph(page, partial).waitFor();
      expect(await page.locator(".chat-run-failure").count()).toBe(0);
      await gateway.setSessionsListResponse({
        sessions: [
          {
            key: sessionKey,
            kind: "direct",
            updatedAt: now,
            endedAt: now,
            status: "failed",
            hasActiveRun: false,
            activeRunIds: [],
            lastRunId: runId,
            lastRunError: summary,
          },
        ],
      });
      // Failure receipts commit before chat.error; custom reports do not emit session.message.
      await gateway.setHistoryMessages(historyMessages);
      await chat(gateway, runId, "error", { errorMessage: summary });
      const notice = page.locator(".chat-run-failure");
      await notice.waitFor();
      expect(await page.locator(".chat-error").count()).toBe(0);
      expect(await notice.textContent()).not.toContain("⚠");
      await paragraph(page, partial).waitFor();
      const copy = notice.getByRole("button", { name: "Copy error", exact: true });
      const retryButton = notice.getByRole("button", { name: "Try again", exact: true });
      const copyOpacity = () => copy.evaluate((node) => getComputedStyle(node).opacity);
      await page.mouse.move(0, 0);
      await expect.poll(copyOpacity).toBe("0");
      const titleBox = await notice.locator(".chat-run-failure__title").boundingBox();
      const retryBox = await retryButton.boundingBox();
      const contentBox = await notice.locator(".chat-run-failure__content").boundingBox();
      assert(titleBox && retryBox && contentBox);
      expect(Math.abs(retryBox.x + retryBox.width - contentBox.x - contentBox.width)).toBeLessThan(
        1,
      );
      expect(
        Math.abs(titleBox.y + titleBox.height / 2 - retryBox.y - retryBox.height / 2),
      ).toBeLessThan(1);
      await notice.hover();
      await expect.poll(copyOpacity).toBe("1");
      const copyIcon = copy.locator(".chat-copy-btn__icon-copy svg");
      expect(await copyIcon.boundingBox()).toMatchObject({ width: 14, height: 14 });
      await page.mouse.move(0, 0);
      await copy.focus();
      await expect.poll(copyOpacity).toBe("1");
      await copy.evaluate((node) => node.blur());
      await expect.poll(copyOpacity).toBe("0");
      expect(await notice.locator("details").count()).toBe(0);
      expect(await notice.getByRole("button", { name: "Change model", exact: true }).count()).toBe(
        0,
      );
      await page.setViewportSize({ width: 393, height: 852 });
      await expect
        .poll(() => notice.evaluate((node) => node.scrollWidth <= node.clientWidth))
        .toBe(true);
      await page.setViewportSize({ width: 1160, height: 850 });
      await page.emulateMedia({ colorScheme: "dark" });
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");
      await suite.withPage(
        { viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true },
        async ({ page: touchPage }) => {
          await installMockGateway(touchPage, { sessionKey, historyMessages });
          await touchPage.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          const touchNotice = touchPage.locator(".chat-run-failure");
          const touchCopy = touchNotice.getByRole("button", { name: "Copy error", exact: true });
          await touchCopy.waitFor();
          expect(await touchPage.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
          expect(await touchCopy.evaluate((node) => getComputedStyle(node).opacity)).toBe("1");
          expect(await touchCopy.evaluate((node) => node.getBoundingClientRect().width)).toBe(32);
        },
      );
      // Persist the mock Gateway response, not just its current document state.
      await gateway.setMethodResponse("chat.history", { messages: historyMessages });
      await page.reload();
      await notice.waitFor();
      expect(await page.locator(".chat-error").count()).toBe(0);
      await openChatModelPicker(page);
      await expect
        .poll(() => page.locator(".chat-controls__model-picker").getAttribute("open"))
        .not.toBeNull();
      const modelSearch = page.locator("[data-chat-model-search]");
      await expect
        .poll(() => modelSearch.evaluate((node) => node === document.activeElement))
        .toBe(true);
      await page.keyboard.press("Escape");
      const draft = page.locator(".agent-chat__input textarea");
      await draft.fill("Keep this unsent draft");
      await notice.getByRole("button", { name: "Try again", exact: true }).click();
      const retry = await gateway.waitForRequest("chat.send");
      expect(retry.params).toMatchObject({
        message:
          "Continue from where you stopped. Check which actions already completed before retrying anything.",
      });
      expect(await draft.inputValue()).toBe("Keep this unsent draft");
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
    });
  });
});
