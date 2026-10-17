import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { assert, expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
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

async function capture(
  page: Page,
  name: string,
  content: Parameters<typeof takeControlUiScreenshotFrame>[2],
) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  const thread = page.locator(".chat-thread");
  const frame = await takeControlUiScreenshotFrame(page, thread, content, {
    animations: "disabled",
    elements: [thread, ...content],
  });
  await fs.writeFile(path.join(suite.artifactDir, name + ".png"), frame.png);
  await fs.writeFile(path.join(suite.artifactDir, name + "-chat.png"), frame.elements[0]!.png);
  for (let index = 1; index < frame.elements.length; index += 1) {
    await fs.writeFile(
      path.join(suite.artifactDir, name + "-element-" + index + ".png"),
      frame.elements[index]!.png,
    );
  }
}

suite.define(() => {
  it("preserves restart partials and a neutral durable recovery notice through reload", async () => {
    await suite.withPage({ viewport: { width: 1160, height: 850 } }, async ({ page }) => {
      // Synthetic Gateway I/O: this proves the UI contract, not an actual Gateway restart.
      const gateway = await installMockGateway(page, { sessionKey });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const prompt = "Review the remaining call sites and summarize the changes.";
      await page.locator(".agent-chat__input textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      const send = await gateway.waitForRequest("chat.send");
      assert(isRecord(send.params) && typeof send.params.idempotencyKey === "string");
      const runId = send.params.idempotencyKey;
      const successorRunId = "restart-recovery-successor";
      const now = Date.now();
      const historyMessages = [
        {
          role: "user",
          content: prompt,
          timestamp: now - 3,
          __openclaw: { id: "restart-input", seq: 1, idempotencyKey: runId + ":user" },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: partial }],
          stopReason: "aborted",
          timestamp: now - 2,
          __openclaw: { id: "restart-partial", seq: 2, runId },
        },
        {
          role: "user",
          content: "[System] Continue the interrupted turn.",
          provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
          timestamp: now - 1,
          __openclaw: {
            id: "restart-recovery-input",
            seq: 3,
            idempotencyKey: successorRunId + ":user",
          },
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "The review is complete. All remaining call sites are covered." },
          ],
          timestamp: now,
          __openclaw: { id: "restart-final", seq: 4, runId: successorRunId },
        },
      ];
      const thread = page.locator(".chat-thread");
      const partialOutput = thread.getByRole("paragraph").filter({ hasText: partial });
      await gateway.emitGatewayEvent("chat", {
        sessionKey,
        runId,
        state: "delta",
        seq: 1,
        message: { role: "assistant", content: [{ type: "text", text: partial }] },
      });
      await partialOutput.waitFor();
      await gateway.setHistoryMessages(historyMessages.slice(0, 2));
      await gateway.emitGatewayEvent("session.message", {
        sessionKey,
        runId,
        clientRunId: runId,
        message: historyMessages[1],
        messageId: "restart-partial",
        messageSeq: 2,
        hasActiveRun: true,
        activeRunIds: [runId],
      });
      await gateway.emitGatewayEvent("chat", {
        sessionKey,
        runId,
        state: "aborted",
        stopReason: "restart",
        seq: 2,
        message: historyMessages[1],
      });
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ state: "hidden" });
      expect(await partialOutput.count()).toBe(1);
      expect(await page.locator(".chat-run-failure, .chat-error").count()).toBe(0);

      // Recovery is admitted by the Gateway's durable system input, never a UI retry/send.
      await gateway.setHistoryMessages(historyMessages.slice(0, 3));
      await gateway.emitGatewayEvent("session.message", {
        sessionKey,
        runId: successorRunId,
        clientRunId: successorRunId,
        message: historyMessages[2],
        messageId: "restart-recovery-input",
        messageSeq: 3,
        hasActiveRun: true,
        activeRunIds: [successorRunId],
      });
      const notice = thread
        .locator(".chat-notice")
        .filter({ hasText: "System · restart recovery" });
      await thread.locator(".chat-system-events__summary").click();
      await notice.waitFor();
      expect(await notice.locator(".chat-notice__body").count()).toBe(0);
      expect(await notice.getAttribute("role")).toBeNull();
      expect(await notice.locator("button").count()).toBe(0);
      await gateway.emitGatewayEvent("chat", {
        sessionKey,
        runId: successorRunId,
        state: "delta",
        seq: 1,
        message: historyMessages[3],
      });
      await gateway.setHistoryMessages(historyMessages);
      await gateway.emitGatewayEvent("chat", {
        sessionKey,
        runId: successorRunId,
        state: "final",
        seq: 2,
        message: historyMessages[3],
      });
      const answer = thread.getByRole("paragraph").filter({ hasText: "The review is complete." });
      await answer.waitFor();
      expect(await partialOutput.count()).toBe(1);
      expect(await notice.count()).toBe(1);
      expect(await page.locator(".chat-run-failure, .chat-error").count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      await capture(page, "restart-recovery-after", [partialOutput, notice, answer]);

      await gateway.setMethodResponse("chat.history", { messages: historyMessages });
      await page.reload();
      await answer.waitFor();
      await thread.locator(".chat-system-events__summary").click();
      await notice.waitFor();
      expect(await partialOutput.count()).toBe(1);
      expect(await notice.count()).toBe(1);
      expect(await notice.locator(".chat-notice__body").count()).toBe(0);
      expect(await page.locator(".chat-run-failure, .chat-error").count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await capture(page, "restart-recovery-after-reload", [partialOutput, notice, answer]);
    });
  });

  it("keeps recovery in the claw row and retires it when the run resumes", async () => {
    await suite.withPage({ viewport: { width: 1160, height: 850 } }, async ({ page }) => {
      await page.clock.install();
      const gateway = await installMockGateway(page, { sessionKey });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await page
        .locator(".agent-chat__input textarea")
        .fill("Review the remaining call sites and summarize the changes.");
      await page.getByRole("button", { name: "Send message" }).click();
      const send = await gateway.waitForRequest("chat.send");
      assert(isRecord(send.params) && typeof send.params.idempotencyKey === "string");
      const runId = send.params.idempotencyKey;
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
      // Agent events publish through the presentation owner’s animation frame.
      await page.clock.runFor(32);
      const status = page.locator(".chat-working-indicator__status");
      await expect.poll(() => status.textContent()).toContain("Retrying in 8s");
      expect(await page.locator(".chat-run-failure, .chat-error").count()).toBe(0);
      expect(await status.locator(".chat-working-indicator__elapsed").count()).toBe(1);
      await capture(page, "retrying", [status]);
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
      await page
        .locator(".chat-thread")
        .getByRole("paragraph")
        .filter({ hasText: "The review is complete." })
        .waitFor();
      expect(await page.locator(".chat-run-failure, .chat-error").count()).toBe(0);
    });
  });

  it("renders one durable terminal notice, preserves partial output and offers safe recovery", async () => {
    await suite.withPage({ viewport: { width: 1160, height: 850 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, { sessionKey });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const prompt = "Review the remaining call sites and summarize the changes.";
      await page.locator(".agent-chat__input textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      const send = await gateway.waitForRequest("chat.send");
      assert(isRecord(send.params) && typeof send.params.idempotencyKey === "string");
      const runId = send.params.idempotencyKey;
      await page.getByRole("button", { name: "Stop generating" }).waitFor();
      const now = Date.now();
      const historyMessages = [
        {
          role: "user",
          content: prompt,
          timestamp: now - 3,
          __openclaw: { id: "input", seq: 1, idempotencyKey: runId + ":user" },
        },
        {
          role: "assistant",
          content: partial,
          timestamp: now - 2,
          __openclaw: { id: "partial", seq: 2, runId },
        },
        {
          role: "custom",
          customType: "run-failed-before-reply",
          content: summary,
          timestamp: now - 1,
          openclawRunError: { runId, summary },
          __openclaw: { id: "failure", seq: 3, runId },
        },
      ];
      await gateway.setHistoryMessages(historyMessages.slice(0, 2));
      await gateway.emitGatewayEvent("session.message", {
        sessionKey,
        runId,
        clientRunId: runId,
        message: historyMessages[1],
        messageId: "partial",
        messageSeq: 2,
        hasActiveRun: true,
        activeRunIds: [runId],
      });
      await page
        .locator(".chat-thread")
        .getByRole("paragraph")
        .filter({ hasText: partial })
        .waitFor();
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
        count: 1,
        path: "",
        ts: now,
        defaults: { model: "gpt-5.5", modelProvider: "openai", contextTokens: null },
      });
      // Failure receipts commit before chat.error; custom reports do not emit session.message.
      await gateway.setHistoryMessages(historyMessages);
      await gateway.emitGatewayEvent("chat", {
        sessionKey,
        runId,
        state: "error",
        errorMessage: summary,
      });
      const notice = page.locator(".chat-run-failure");
      await notice.waitFor();
      expect(await notice.count()).toBe(1);
      expect(await page.locator(".chat-error").count()).toBe(0);
      expect(await notice.textContent()).not.toContain("⚠");
      await page
        .locator(".chat-thread")
        .getByRole("paragraph")
        .filter({ hasText: partial })
        .waitFor();
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
      await capture(page, "after", [
        notice,
        page.locator(".chat-thread").getByRole("paragraph").filter({ hasText: partial }),
      ]);
      await notice.hover();
      await expect.poll(copyOpacity).toBe("1");
      const copyIcon = copy.locator(".chat-copy-btn__icon-copy svg");
      expect(await copyIcon.evaluate((node) => node.getBoundingClientRect().width)).toBe(14);
      expect(await copyIcon.evaluate((node) => node.getBoundingClientRect().height)).toBe(14);
      await capture(page, "after-hover", [notice]);
      await page.mouse.move(0, 0);
      await copy.focus();
      await expect.poll(copyOpacity).toBe("1");
      await copy.evaluate((node) => node.blur());
      await expect.poll(copyOpacity).toBe("0");
      expect(await notice.locator("details").count()).toBe(0);
      expect(await notice.getByRole("button", { name: "Change model", exact: true }).count()).toBe(
        0,
      );
      await notice.getByRole("button", { name: "Copy error", exact: true }).waitFor();
      await page.setViewportSize({ width: 393, height: 852 });
      await expect
        .poll(() => notice.evaluate((node) => node.scrollWidth <= node.clientWidth))
        .toBe(true);
      await capture(page, "after-mobile", [notice]);
      await page.setViewportSize({ width: 1160, height: 850 });
      await page.emulateMedia({ colorScheme: "dark" });
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");
      await capture(page, "after-dark", [notice]);
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
          await capture(touchPage, "after-touch", [touchNotice]);
        },
      );
      // Persist the mock Gateway response, not just its current document state.
      await gateway.setMethodResponse("chat.history", { messages: historyMessages });
      await page.reload();
      await notice.waitFor();
      expect(await notice.count()).toBe(1);
      expect(await page.locator(".chat-error").count()).toBe(0);
      // Model selection stays available at its existing composer control.
      await openChatModelPicker(page);
      await expect
        .poll(() => page.locator(".chat-controls__model-picker").getAttribute("open"))
        .not.toBeNull();
      await capture(page, "model-picker", [page.locator(".agent-chat__input")]);
      const modelSearch = page.locator("[data-chat-model-search]");
      await modelSearch.waitFor({ state: "visible" });
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
