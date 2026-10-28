import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import {
  reconnectMockGateway,
  defaultControlUiFeatureMethods,
} from "../test-helpers/control-ui-e2e.ts";
import { readStoredQuestionDrafts } from "./chat-async-questions.test-support.ts";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
} from "./chat-flow.test-support.ts";
import { readOutboxQueue } from "./chat-outbox-payloads.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const title = "Which audience should the summary address?";
const questionMessage = {
  role: "assistant",
  content: `${title}\n\n1. Engineers\n2. Everyone`,
  timestamp: 1_789_000_000_000,
  openclawAsyncDelivery: {
    itemId: "audience-question",
    questions: [{ title, options: ["Engineers", "Everyone"] }],
  },
};

suite.define(() => {
  it("keeps an unfinished answer through later completion, reload, and reconnect", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const prompt = {
        ...questionMessage,
        runId: "draft-run",
        __openclaw: { id: "draft-question", seq: 1 },
      };
      const history = [prompt];
      const gateway = await installMockGateway(page, { historyMessages: history });
      await page.goto(`${suite.server.baseUrl}chat`);
      const dock = page.locator(".agent-chat__question-dock");
      const draft = dock.getByRole("textbox", { name: `Your own answer for ${title}` });
      await draft.fill("New contributors and maintainers");

      const ownFinal = {
        role: "assistant",
        content: "Draft ready.",
        runId: "draft-run",
        phase: "final_answer",
        __openclaw: { id: "draft-final", seq: 2, runTerminal: true },
      };
      const laterFinal = {
        role: "assistant",
        content: "Other work finished.",
        runId: "later-run",
        phase: "final_answer",
        __openclaw: { id: "later-final", seq: 3, runTerminal: true },
      };
      await gateway.setHistoryMessages([...history, ownFinal, laterFinal]);
      for (const message of [ownFinal, laterFinal]) {
        const { __openclaw: identity } = message;
        await gateway.emitGatewayEvent("session.message", {
          sessionKey: "agent:main:main",
          messageId: identity.id,
          messageSeq: identity.seq,
          message,
        });
      }
      await expectBrowser(
        page.locator(".chat-thread-inner").getByText("Other work finished.", { exact: true }),
      ).toBeVisible();
      await expectBrowser(draft).toHaveValue("New contributors and maintainers");
      // Observe the owning IndexedDB transaction, not a timeout, before simulating a reload.
      await expect
        .poll(async () =>
          (await readStoredQuestionDrafts(page)).some((question) =>
            question.answers.some(
              (answer) => answer.freeText === "New contributors and maintainers",
            ),
          ),
        )
        .toBe(true);
      await page.reload();
      await expectBrowser(draft).toHaveValue("New contributors and maintainers");
      await reconnectMockGateway(page, gateway, "question-draft-reconnect");
      await expectBrowser(draft).toHaveValue("New contributors and maintainers");

      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("question.resolve")).toHaveLength(0);
    });
  });

  it("keeps the docked question and composer within a 390 px viewport", async () => {
    const width = 390;
    await suite.withPage(
      { viewport: { width: 1440, height: 1200 }, colorScheme: "dark", reducedMotion: "reduce" },
      async ({ page }) => {
        await installMockGateway(page, { historyMessages: [questionMessage] });
        await page.goto(`${suite.server.baseUrl}chat`);
        const panel = page.locator(".agent-chat__question-dock .chat-question-panel");
        const composer = page.locator(".agent-chat__input");
        await expectBrowser(panel).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        const desktop = await panel.boundingBox();
        expect(desktop).not.toBeNull();
        await page.setViewportSize({ width, height: 844 });
        const assertDock = async () => {
          await expectBrowser(panel).toBeInViewport({ ratio: 1 });
          await expectBrowser(composer).toBeInViewport({ ratio: 1 });
          const questionBox = (await panel.boundingBox())!;
          const composerBox = (await composer.boundingBox())!;
          expect(questionBox.x).toBeCloseTo(composerBox.x, 0);
          expect(questionBox.width).toBeCloseTo(composerBox.width, 0);
          expect(questionBox.y + questionBox.height).toBeLessThanOrEqual(composerBox.y);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(width);
        };
        await assertDock();
        await panel.getByRole("button", { name: "Collapse question" }).click();
        await assertDock();
        await expectBrowser(panel).toContainText("1 unanswered question");
        await panel.getByRole("button", { name: "Expand question" }).click();
        await expectBrowser(panel).not.toHaveClass(/chat-question-panel--collapsed/);
        await assertDock();
        await page.setViewportSize({ width: 1440, height: 1200 });
        await expect
          .poll(async () => {
            const restored = (await panel.boundingBox())!;
            return Math.max(
              ...(["x", "y", "width", "height"] as const).map((key) =>
                Math.abs(restored[key] - desktop![key]),
              ),
            );
          })
          .toBeLessThanOrEqual(0.5);
      },
    );
  });

  it.each([false, true])(
    "submits an async answer as ordinary chat with an active run=%s",
    async (active) => {
      const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const sessionKey = "agent:main:dashboard:async-question-proof";
      const followUpTitle = "What should I emphasize?";
      const multipleQuestions = {
        ...questionMessage,
        runId: "working-run",
        __openclaw: { id: "audience-prompt", seq: 2 },
        content: `${questionMessage.content}\n\n${followUpTitle}`,
        openclawAsyncDelivery: {
          ...questionMessage.openclawAsyncDelivery,
          questions: [...questionMessage.openclawAsyncDelivery.questions, { title: followUpTitle }],
        },
      };
      const replyMessage = {
        role: "user",
        content: "A separate discussion for later.",
        timestamp: questionMessage.timestamp - 1_000,
        __openclaw: {
          id: "composer-reply-target",
          seq: 1,
          idempotencyKey: "working-run:user",
        },
      };
      const completedTool = {
        role: "toolResult",
        toolName: "read",
        toolCallId: "draft-read",
        runId: "working-run",
        content: [{ type: "text", text: "Draft source loaded." }],
        timestamp: questionMessage.timestamp + 500,
        __openclaw: { id: "draft-read-result", seq: 3 },
      };
      const gateway = await installMockGateway(page, {
        sessionKey,
        historyMessages: [replyMessage, multipleQuestions, completedTool],
        inFlightRun: { runId: "working-run", startedAt: Date.now(), text: "" },
        sessionInfo: { hasActiveRun: true, activeRunIds: ["working-run"] },
      });
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.locator(".chat-thread").getByText(title, { exact: true }).waitFor();

        const card = page.locator(".agent-chat__question-dock openclaw-chat-question-panel");
        await expect.poll(() => card.count()).toBe(1);
        await card.getByRole("radio", { name: /Engineers/ }).waitFor();
        expect(
          await card.getByRole("radio", { name: /Engineers/ }).getAttribute("aria-checked"),
        ).toBe("true");
        await expectRequestCountStable(gateway, "chat.send", 0);
        await page.locator(".chat-group.user .chat-bubble").hover();
        await page
          .locator(".chat-group.user")
          .getByRole("button", { name: "Reply to message", exact: true })
          .click();
        const composerReply = page.locator(".chat-reply-preview").filter({
          has: page.getByRole("button", { name: "Cancel reply" }),
        });
        await expect.poll(() => composerReply.textContent()).toContain(replyMessage.content);
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Keep this separate composer draft.");
        const custom = card.getByRole("textbox", { name: `Your own answer for ${title}` });
        await custom.fill("/stop is an example for the whole team");
        expect(
          await card.getByRole("radio", { name: /Engineers/ }).getAttribute("aria-checked"),
        ).toBe("false");
        await card.getByRole("button", { name: "Next", exact: true }).click();
        const freeText = card.getByRole("textbox", { name: "Answer", exact: true });
        await freeText.fill("Include one practical example.");
        await expect
          .poll(() => freeText.evaluate((element) => getComputedStyle(element).overflowY))
          .toBe("hidden");
        const initialAnswerHeight = (await freeText.boundingBox())!.height;
        await freeText.press("End");
        await freeText.press("Enter");
        await freeText.pressSequentially("Keep the next steps separate.");
        await expectBrowser(freeText).toHaveValue(
          "Include one practical example.\nKeep the next steps separate.",
        );
        await expect
          .poll(async () => (await freeText.boundingBox())!.height)
          .toBeGreaterThan(initialAnswerHeight);
        const multilineAnswerHeight = (await freeText.boundingBox())!.height;
        await freeText.fill(
          Array.from({ length: 30 }, (_, index) => `Detail ${index + 1}`).join("\n"),
        );
        await expect.poll(async () => (await freeText.boundingBox())!.height).toBe(160);
        await expect
          .poll(() => freeText.evaluate((element) => element.scrollHeight > element.clientHeight))
          .toBe(true);
        await freeText.fill("Include one practical example.\nKeep the next steps separate.");
        await expect
          .poll(async () => (await freeText.boundingBox())!.height)
          .toBe(multilineAnswerHeight);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await card.getByRole("button", { name: "Collapse question", exact: true }).click();
        const expand = card.getByRole("button", { name: "Expand question", exact: true });
        await expand.waitFor();
        expect(await expand.textContent()).toContain(followUpTitle);
        expect(await expand.textContent()).toContain("2 unanswered questions");
        expect(await composer.isVisible()).toBe(true);
        if (!active) {
          const finalMessage = {
            role: "assistant",
            content: "I finished the draft.",
            runId: "working-run",
            phase: "final_answer",
            stopReason: "stop",
            timestamp: questionMessage.timestamp + 1_000,
            __openclaw: { id: "draft-complete", seq: 4 },
          };
          await gateway.setMethodResponse("chat.history", {
            messages: [replyMessage, multipleQuestions, completedTool, finalMessage],
            sessionInfo: { hasActiveRun: false, activeRunIds: [] },
          });
          await gateway.emitGatewayEvent("chat", {
            sessionKey,
            runId: "working-run",
            state: "final",
            message: finalMessage,
          });
          await page
            .getByRole("button", { name: "Stop generating" })
            .waitFor({ state: "detached" });
          await expect
            .poll(() => page.locator(".chat-work-group button").getAttribute("aria-expanded"))
            .toBe("false");
          expect(await expand.isVisible()).toBe(true);
          expect(await expand.textContent()).toContain(followUpTitle);
          await expectBrowser(
            page.locator(".chat-thread").getByText(title, { exact: true }),
          ).toBeVisible();
          expect(await card.getByRole("textbox").count()).toBe(0);
        }

        await expand.click();
        expect(await freeText.inputValue()).toBe(
          "Include one practical example.\nKeep the next steps separate.",
        );
        await card.getByRole("button", { name: "Back", exact: true }).click();
        expect(await custom.inputValue()).toBe("/stop is an example for the whole team");
        await card.getByRole("button", { name: "Next", exact: true }).click();

        await card.getByRole("button", { name: "Submit", exact: true }).click();
        const request = await gateway.waitForRequest("chat.send");
        const params = requireRecord(request.params);
        expect(params.message).toBe(
          `> ${title}\n\n/stop is an example for the whole team\n\n> ${followUpTitle}\n\nInclude one practical example.\nKeep the next steps separate.`,
        );
        expect(params.queueMode).toBe(active ? "steer" : undefined);
        expect(params.replyToId).toBe("audience-prompt");
        expect(await composer.inputValue()).toBe("Keep this separate composer draft.");
        expect(await composerReply.textContent()).toContain(replyMessage.content);
        expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
        expect(await gateway.getRequests("question.resolve")).toHaveLength(0);
        await card.waitFor({ state: "detached" });
        if (!active) {
          await page.locator(".chat-work-group button").click();
        }
        const summary = page
          .locator(".chat-thread .chat-question-summary")
          .filter({ hasText: title });
        await summary.waitFor();
        expect(await summary.textContent()).toContain("Include one practical example.");
        await expectRequestCountStable(gateway, "chat.send", 1);
        if (!active) {
          // Stop overriding the old run's history: startup must recover the answer
          // committed by the default chat.send boundary, not an injected answer row.
          await gateway.setMethodResponse("chat.history", { cases: [] });
          await page.reload();
          await expectBrowser(summary).toContainText("Include one practical example.");
          await expectBrowser(summary).toContainText("/stop is an example for the whole team");
          await expectBrowser(card).toHaveCount(0);
          await expectBrowser(
            page.locator(".chat-group.user .chat-bubble").filter({
              hasText: "/stop is an example for the whole team",
            }),
          ).toHaveCount(1);
          await expectRequestCountStable(gateway, "chat.send", 0);
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("keeps async arrivals nonblocking and preserves their queue through a blocking question", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const initial = {
      role: "assistant",
      content: "Ready to prepare the summary.",
      timestamp: questionMessage.timestamp - 1_000,
      __openclaw: { id: "summary-ready", seq: 1 },
    };
    const secondTitle = "How detailed should the summary be?";
    const secondQuestion = {
      ...questionMessage,
      content: secondTitle,
      timestamp: questionMessage.timestamp + 1_000,
      openclawAsyncDelivery: {
        itemId: "detail-question",
        questions: [{ title: secondTitle, options: ["Concise", "Detailed"] }],
      },
    };
    const gateway = await installMockGateway(page, {
      featureMethods: [...defaultControlUiFeatureMethods, "question.list", "question.resolve"],
      historyMessages: [initial],
      methodResponses: { "question.list": { questions: [] } },
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Continue researching while I decide.");
      const card = page.locator(".agent-chat__question-dock openclaw-chat-question-panel");
      const messages: unknown[] = [initial];
      const arrive = async (question: typeof questionMessage, seq: number) => {
        const message = {
          ...question,
          __openclaw: { id: question.openclawAsyncDelivery.itemId, seq },
        };
        messages.push(message);
        await gateway.setHistoryMessages(messages);
        await gateway.emitGatewayEvent("session.message", {
          sessionKey: "agent:main:main",
          messageId: message["__openclaw"].id,
          messageSeq: seq,
          message,
        });
      };
      await arrive(questionMessage, 2);
      const initialExpand = card.getByRole("button", { name: "Expand question", exact: true });
      await initialExpand.waitFor();
      expect(await initialExpand.textContent()).toContain("1 unanswered question");
      expect(await card.getByRole("textbox").count()).toBe(0);
      expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);
      await initialExpand.click();
      await card.getByText(title, { exact: true }).waitFor();
      expect(await composer.inputValue()).toBe("Continue researching while I decide.");
      const custom = card.getByRole("textbox", { name: `Your own answer for ${title}` });
      await custom.fill("Readers new to the project");
      await card.getByRole("button", { name: "Collapse question", exact: true }).click();
      const expand = card.getByRole("button", { name: "Expand question", exact: true });
      await expectBrowser(composer).toBeFocused();
      await arrive(secondQuestion, 3);
      await expect.poll(() => expand.textContent()).toContain("2 unanswered questions");
      expect(await expand.textContent()).toContain(title);
      expect(await card.getByRole("textbox").count()).toBe(0);
      expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);

      const blockingTitle = "Where should I save the completed summary?";
      const createdAtMs = Date.now();
      await gateway.emitGatewayEvent("question.requested", {
        id: "summary-destination",
        agentId: "main",
        sessionKey: "agent:main:main",
        status: "pending",
        createdAtMs,
        expiresAtMs: createdAtMs + 60_000,
        questions: [
          {
            questionId: "destination",
            header: "Destination",
            question: blockingTitle,
            options: [{ label: "Project notes" }, { label: "Team folder" }],
            isOther: false,
          },
        ],
      });
      await card.getByText(blockingTitle, { exact: true }).waitFor();
      expect(await card.textContent()).toContain("Waiting for your answer");
      expect(await composer.count()).toBe(0);
      await card.getByRole("button", { name: "Next", exact: true }).click();
      await card.getByText(title, { exact: true }).waitFor();
      expect(await custom.inputValue()).toBe("Readers new to the project");
      expect(await composer.isVisible()).toBe(true);
      await card.getByRole("button", { name: "Previous", exact: true }).click();
      await card.getByText(blockingTitle, { exact: true }).waitFor();
      const answers = { answers: { destination: ["Project notes"] } };
      await gateway.setMethodResponse("question.resolve", { status: "answered", answers });
      await card.getByRole("radio", { name: /Project notes/ }).click();
      await card.getByRole("button", { name: "Submit", exact: true }).click();
      const request = await gateway.waitForRequest("question.resolve");
      expect(request.params).toEqual({ id: "summary-destination", answers });
      await card.getByText(title, { exact: true }).waitFor();
      expect(await custom.inputValue()).toBe("Readers new to the project");
      await card.getByRole("button", { name: "Next", exact: true }).click();
      await card.getByText(secondTitle, { exact: true }).waitFor();
      await card.getByRole("button", { name: "Dismiss", exact: true }).click();
      await card.getByText(title, { exact: true }).waitFor();
      expect(await custom.inputValue()).toBe("Readers new to the project");
      await card.getByRole("button", { name: "Dismiss", exact: true }).click();
      await card.waitFor({ state: "detached" });
      expect(await composer.inputValue()).toBe("Continue researching while I decide.");
      const skipped = page.locator(".chat-thread .chat-question-summary");
      expect(await skipped.filter({ hasText: title }).textContent()).toContain("Dismissed");
      expect(await skipped.filter({ hasText: secondTitle }).textContent()).toContain("Dismissed");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("retries a rejected answer through the original outbox and confirms its canonical receipt", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        historyMessages: [{ ...questionMessage, __openclaw: { id: "delivery-question", seq: 1 } }],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const card = page.locator(".agent-chat__question-dock openclaw-chat-question-panel");
      const summary = page
        .locator(".chat-thread .chat-question-summary")
        .filter({ hasText: title });
      const answer = "The customer support team";
      await card.getByRole("textbox", { name: `Your own answer for ${title}` }).fill(answer);
      await gateway.deferNext("chat.send");
      await card.getByRole("button", { name: "Submit", exact: true }).click();
      const original = await gateway.waitForRequest("chat.send");
      expect(requireRecord(original.params)).toMatchObject({
        message: `> ${title}\n\n${answer}`,
        replyToId: "delivery-question",
      });
      await expectBrowser(summary).toContainText("Sending answer");
      await gateway.resolveDeferred("chat.send", {
        __mockError: { code: "UNAVAILABLE", message: "Synthetic send rejection" },
      });
      await expectBrowser(card).toHaveCount(0);
      await expectBrowser(summary).toContainText("Answer not sent");
      await expectBrowser(summary).toContainText("Synthetic send rejection");
      const failedSend = page.locator('.chat-send-status[data-send-state="failed"]');
      await expectBrowser(failedSend).toHaveAttribute("title", "Synthetic send rejection");
      const queued = await readOutboxQueue(page);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        asyncQuestionItemId: "audience-question",
        replyToId: "delivery-question",
      });
      const queueId = queued[0]!.id;
      expect(queueId).toEqual(expect.any(String));
      expect(queueId).not.toBe("");
      await expectRequestCountStable(gateway, "chat.send", 1);
      await page.reload();
      await expectBrowser(summary).toContainText("Answer not sent");
      await expectBrowser(card).toHaveCount(0);
      expect((await readOutboxQueue(page)).map((item) => item.id)).toEqual([queueId]);
      await expectRequestCountStable(gateway, "chat.send", 0);
      await gateway.deferNext("chat.send");
      await summary.getByRole("button", { name: "Retry answer", exact: true }).click();
      const retried = await gateway.waitForRequest("chat.send");
      expect(requireRecord(retried.params)).toMatchObject({
        message: requireRecord(original.params).message,
        replyToId: requireRecord(original.params).replyToId,
      });
      const userMessages = page.locator(".chat-group.user .chat-bubble");
      await expectBrowser(userMessages).toHaveCount(1);
      expect((await readOutboxQueue(page)).map((item) => item.id)).toEqual([queueId]);
      await expectBrowser(summary).toContainText("Sending answer");
      await gateway.resolveDeferred("chat.send");
      await expectBrowser(summary).toContainText("Awaiting delivery confirmation");
      await expectBrowser(card).toHaveCount(0);
      const runId = String(requireRecord(retried.params).idempotencyKey);
      await gateway.emitGatewayEvent("session.message", {
        sessionKey: "agent:main:main",
        clientRunId: runId,
        messageId: `mock-user:${runId}`,
        messageSeq: 2,
        message: {
          role: "user",
          content: requireRecord(retried.params).message,
          idempotencyKey: `${runId}:user`,
          __openclaw: { id: `mock-user:${runId}`, seq: 2, replyToId: "delivery-question" },
        },
      });
      await expectBrowser(summary).toContainText("Answer sent");
      await expectBrowser(summary).toContainText(answer);
      await expectBrowser(failedSend).toHaveCount(0);
      await expectBrowser(userMessages).toHaveCount(1);
      await expectBrowser(card).toHaveCount(0);
      await expectRequestCountStable(gateway, "chat.send", 1);
    });
  });

  it.each(["offline", "malformed"] as const)(
    "keeps the original question transcript readable when %s",
    async (fallback) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const followUpTitle = "What should I emphasize?";
        const gateway = await installMockGateway(page, {
          historyMessages: [
            fallback === "offline"
              ? {
                  ...questionMessage,
                  content: `${questionMessage.content}\n\n${followUpTitle}`,
                  openclawAsyncDelivery: {
                    ...questionMessage.openclawAsyncDelivery,
                    questions: [
                      ...questionMessage.openclawAsyncDelivery.questions,
                      { title: followUpTitle },
                    ],
                  },
                }
              : { ...questionMessage, openclawAsyncDelivery: undefined },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const transcript = page.locator(".chat-text");
        if (fallback === "offline") {
          const card = page.locator(".agent-chat__question-dock openclaw-chat-question-panel");
          await card.getByRole("radio", { name: /Engineers/ }).waitFor();
          await gateway.setOnline(false);
          await card.waitFor({ state: "detached" });
          await transcript.getByText(followUpTitle, { exact: true }).waitFor();
          expect(await transcript.textContent()).toContain(title);
          expect(await transcript.textContent()).toContain("Everyone");
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        } else {
          await transcript.getByText(title).waitFor();

          await gateway.setHistoryMessages([
            {
              ...questionMessage,
              openclawAsyncDelivery: {
                ...questionMessage.openclawAsyncDelivery,
                questions: [{ title, options: ["One", "Two", "Three", "Four", "Five"] }],
              },
            },
          ]);
          await page.reload();
          await transcript.getByText(title).waitFor();
          expect(await page.locator("openclaw-chat-question-panel").count()).toBe(0);
        }
        expect(await transcript.textContent()).toContain("Engineers");
      });
    },
  );
});
