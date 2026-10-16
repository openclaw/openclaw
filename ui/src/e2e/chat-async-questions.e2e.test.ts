import { type Page, type Locator, expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import {
  type ControlUiMockGatewayScenario,
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
const withPage = <T>(
  run: (fixture: Parameters<Parameters<typeof suite.withPage>[1]>[0]) => Promise<T>,
) => suite.withPage(createControlUiE2eContextOptions(), run);
const questionPanel = (page: Page) =>
  page.locator(".agent-chat__question-dock openclaw-chat-question-panel");
const summaryFor = (page: Page) =>
  page.locator(".chat-thread .chat-question-summary").filter({ hasText: title });
const button = (owner: Locator, name: string) => owner.getByRole("button", { name, exact: true });
type MessageIdentity = { id: string; seq: number };

function emitMessage(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  message: { __openclaw: MessageIdentity },
  fields: Record<string, unknown> = {},
) {
  const { __openclaw: identity } = message;
  return gateway.emitGatewayEvent("session.message", {
    sessionKey: "agent:main:main",
    messageId: identity.id,
    messageSeq: identity.seq,
    message,
    ...fields,
  });
}
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

function withFollowUp(followUpTitle: string) {
  return {
    ...questionMessage,
    content: `${questionMessage.content}\n\n${followUpTitle}`,
    openclawAsyncDelivery: {
      ...questionMessage.openclawAsyncDelivery,
      questions: [...questionMessage.openclawAsyncDelivery.questions, { title: followUpTitle }],
    },
  };
}

function terminalMessage(content: string, id: string, seq: number, runId: string, phase?: string) {
  return {
    role: "assistant",
    content,
    __openclaw: { id, seq, runId, runTerminal: true, mirrorOrigin: "codex-app-server" },
    stopReason: "stop",
    ...(phase ? { phase } : {}),
  };
}

async function openChat(page: Page, options: ControlUiMockGatewayScenario = {}) {
  const gateway = await installMockGateway(page, options);
  await page.goto(
    options.sessionKey
      ? controlUiSessionUrl(suite.server.baseUrl, options.sessionKey)
      : `${suite.server.baseUrl}chat`,
  );
  const card = questionPanel(page);
  return {
    gateway,
    card,
    summary: summaryFor(page),
    composer: page.locator(".agent-chat__composer-combobox textarea"),
    custom: card.getByRole("textbox", { name: `Your own answer for ${title}` }),
  };
}

suite.define(() => {
  it("keeps an admitted optional answer with its original outbox owner after reconnect", async () => {
    await withPage(async ({ page }) => {
      const { gateway, card } = await openChat(page, { historyMessages: [questionMessage] });
      const answer = "The customer support team";
      await card.getByRole("textbox", { name: `Your own answer for ${title}` }).fill(answer);
      await gateway.deferNext("chat.send");
      await button(card, "Submit").click();
      const firstRequest = await gateway.waitForRequest("chat.send");
      const admitted = await readOutboxQueue(page);
      expect(admitted).toHaveLength(1);
      expect(requireRecord(firstRequest.params).message).toBe(`> ${title}\n\n${answer}`);
      await reconnectMockGateway(page, gateway);
      await expect
        .poll(async () => (await readOutboxQueue(page))[0]?.sendState)
        .toBe("unconfirmed");
      await expectBrowser(card).toHaveCount(0);
      const summary = summaryFor(page);
      await expectBrowser(summary).toContainText(answer);
      const unconfirmed = page.locator('.chat-send-status[data-send-state="unconfirmed"]');
      const retry = unconfirmed.getByRole("button", { name: "Retry queued message" });
      await expectBrowser(retry).toBeVisible();
      expect((await readOutboxQueue(page)).map((item) => item.id)).toEqual(
        admitted.map((item) => item.id),
      );
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      await gateway.deferNext("chat.send");
      await retry.click();
      const retried = await gateway.waitForRequest("chat.send", { after: 1 });
      const firstParams = requireRecord(firstRequest.params);
      expect(requireRecord(retried.params)).toMatchObject({
        message: firstParams.message,
        idempotencyKey: firstParams.idempotencyKey,
      });
      expect((await readOutboxQueue(page)).map((item) => item.id)).toEqual(
        admitted.map((item) => item.id),
      );
      await gateway.resolveDeferred("chat.send");
      await expectBrowser(unconfirmed).toHaveCount(0);
      await expectBrowser(card).toHaveCount(0);
      expect(await page.locator(".chat-group.user .chat-bubble").count()).toBe(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(2);
    });
  });

  it.each([false, true])(
    "archives an old reminder after a later completed run and can reopen it (recovery=%s)",
    async (recovery) => {
      const completedHistory = await suite.withPage(
        createControlUiE2eContextOptions(),
        async ({ page }) => {
          const prompt = {
            ...questionMessage,
            ...(recovery ? {} : { runId: "question-run", phase: "final_answer" }),
            __openclaw: {
              id: "audience-prompt",
              seq: 2,
              ...(recovery ? {} : { runId: "question-run" }),
              mirrorOrigin: "codex-app-server",
            },
          };
          const ownFinal = terminalMessage(
            "Draft ready; choose an audience.",
            "draft-ready",
            3,
            "question-run",
            "final_answer",
          );
          const history = [
            {
              role: "user",
              content: "Prepare a project summary.",
              __openclaw: {
                id: "initial-request",
                seq: 1,
                runId: "question-run",
              },
            },
            prompt,
            ...(recovery ? [] : [ownFinal]),
          ];
          const { gateway } = await openChat(page, { historyMessages: history });
          const dock = page.locator(".agent-chat__question-dock");
          await expectBrowser(dock).toBeVisible();
          const draft = dock.getByRole("textbox", { name: `Your own answer for ${title}` });
          const nextFinal = terminalMessage(
            "Summary complete.",
            "summary-finalized",
            5,
            "finishing-run",
          );
          const nextRequest = {
            role: "user",
            content: recovery ? "Resume after restart." : "Finalize the summary.",
            ...(recovery
              ? {
                  provenance: {
                    kind: "internal_system",
                    sourceTool: "main_session_restart_recovery",
                  },
                }
              : {}),
            __openclaw: { id: "follow-up", seq: 4, runId: "finishing-run" },
          };
          const finalHistory = [...history, nextRequest, nextFinal];
          await gateway.setHistoryMessages([...history, nextRequest]);
          await emitMessage(gateway, nextRequest);
          if (recovery) {
            await page.locator(".chat-system-events__summary").click();
          }
          await expectBrowser(
            page
              .locator(".chat-thread-inner")
              .getByText(recovery ? "System · restart recovery" : nextRequest.content, {
                exact: true,
              }),
          ).toBeVisible();
          await expectBrowser(dock).toBeVisible();
          await gateway.setHistoryMessages(finalHistory);
          await emitMessage(gateway, nextFinal);
          await expectBrowser(dock).toHaveCount(0);
          const summary = summaryFor(page);
          await expectBrowser(summary).toContainText("No longer pending");
          await button(summary, "Answer").click();
          await expectBrowser(dock).toBeVisible();
          await expectBrowser(draft).toHaveValue("");
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          expect(await gateway.getRequests("question.resolve")).toHaveLength(0);

          return finalHistory;
        },
      );

      // A fresh tab reconstructs archival from the saved transcript, not a
      // remembered dismissal or the first tab's reopened draft.
      await withPage(async ({ page }) => {
        const { gateway } = await openChat(page, { historyMessages: completedHistory });
        const dock = page.locator(".agent-chat__question-dock");
        const summary = summaryFor(page);
        await expectBrowser(
          page.locator(".chat-thread-inner").getByText("Summary complete.", { exact: true }),
        ).toBeVisible();
        await expectBrowser(dock).toHaveCount(0);
        await expectBrowser(summary).toContainText("No longer pending");
        await page.reload();
        await expectBrowser(summary).toContainText("No longer pending");
        await expectBrowser(dock).toHaveCount(0);
        await button(summary, "Answer").click();
        await expectBrowser(dock).toBeVisible();
        await dock.getByRole("button", { name: "Submit", exact: true }).click();
        const sent = await gateway.waitForRequest("chat.send");
        expect(requireRecord(sent.params).message).toBe(`> ${title}\n\nEngineers`);
        await expectBrowser(dock).toHaveCount(0);
        expect(await gateway.getRequests("question.resolve")).toHaveLength(0);
      });
    },
  );

  it("keeps an unfinished answer through later completion, reload, and reconnect", async () => {
    await withPage(async ({ page }) => {
      const prompt = {
        ...questionMessage,
        runId: "draft-run",
        __openclaw: { id: "draft-question", seq: 1 },
      };
      const history = [prompt];
      const { gateway } = await openChat(page, { historyMessages: history });
      const dock = page.locator(".agent-chat__question-dock");
      const draft = dock.getByRole("textbox", { name: `Your own answer for ${title}` });
      await draft.fill("New contributors and maintainers");
      const ownFinal = {
        role: "assistant",
        content: "Draft ready.",
        __openclaw: { id: "draft-final", seq: 2, runTerminal: true },
        runId: "draft-run",
        phase: "final_answer",
      };
      const laterFinal = {
        role: "assistant",
        content: "Other work finished.",
        __openclaw: { id: "later-final", seq: 3, runTerminal: true },
        runId: "later-run",
        phase: "final_answer",
      };
      await gateway.setHistoryMessages([...history, ownFinal, laterFinal]);
      for (const message of [ownFinal, laterFinal]) {
        await emitMessage(gateway, message);
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
      await withPage(async ({ page }) => {
        const sessionKey = "agent:main:dashboard:async-question-proof";
        const followUpTitle = "What should I emphasize?";
        const multipleQuestions = {
          ...withFollowUp(followUpTitle),
          runId: "working-run",
          __openclaw: { id: "audience-prompt", seq: 2 },
        };
        const replyMessage = {
          role: "user",
          content: "A separate discussion for later.",
          __openclaw: {
            id: "composer-reply-target",
            seq: 1,
            idempotencyKey: "working-run:user",
          },
          timestamp: questionMessage.timestamp - 1_000,
        };
        const { gateway, card, composer, custom, summary } = await openChat(page, {
          sessionKey,
          historyMessages: [replyMessage, multipleQuestions],
          inFlightRun: { runId: "working-run", startedAt: Date.now(), text: "" },
          sessionInfo: { hasActiveRun: true, activeRunIds: ["working-run"] },
        });
        await page.locator(".chat-thread").getByText(title, { exact: true }).waitFor();

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

        await composer.fill("Keep this separate composer draft.");

        await custom.fill("/stop is an example for the whole team");
        expect(
          await card.getByRole("radio", { name: /Engineers/ }).getAttribute("aria-checked"),
        ).toBe("false");
        await button(card, "Next").click();
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
        await button(card, "Collapse question").click();
        const expand = button(card, "Expand question");
        await expand.waitFor();
        expect(await expand.textContent()).toContain(followUpTitle);
        expect(await expand.textContent()).toContain("2 unanswered questions");
        expect(await composer.isVisible()).toBe(true);
        if (!active) {
          const finalMessage = {
            role: "assistant",
            content: "Draft finished.",
            __openclaw: { id: "draft-complete", seq: 3 },
            runId: "working-run",
            phase: "final_answer",
            stopReason: "stop",
            timestamp: questionMessage.timestamp + 1_000,
          };
          await gateway.setMethodResponse("chat.history", {
            messages: [replyMessage, multipleQuestions, finalMessage],
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
          expect(await card.getByRole("textbox").count()).toBe(0);
        }
        await expand.click();
        expect(await freeText.inputValue()).toBe(
          "Include one practical example.\nKeep the next steps separate.",
        );
        await button(card, "Back").click();
        expect(await custom.inputValue()).toBe("/stop is an example for the whole team");
        await button(card, "Next").click();
        await button(card, "Submit").click();
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
      });
    },
  );

  it("keeps async arrivals nonblocking and preserves their queue through a blocking question", async () => {
    await withPage(async ({ page }) => {
      const initial = {
        role: "assistant",
        content: "Ready for summary.",
        __openclaw: { id: "summary-ready", seq: 1 },
        timestamp: questionMessage.timestamp - 1_000,
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
      const { gateway, composer, card, custom } = await openChat(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "question.list", "question.resolve"],
        historyMessages: [initial],
        methodResponses: { "question.list": { questions: [] } },
      });
      await composer.fill("Continue researching while I decide.");

      const messages: unknown[] = [initial];
      const arrive = async (question: typeof questionMessage, seq: number) => {
        const message = {
          ...question,
          __openclaw: { id: question.openclawAsyncDelivery.itemId, seq },
        };
        messages.push(message);
        await gateway.setHistoryMessages(messages);
        await emitMessage(gateway, message);
      };
      await arrive(questionMessage, 2);
      const initialExpand = button(card, "Expand question");
      await initialExpand.waitFor();
      expect(await initialExpand.textContent()).toContain("1 unanswered question");
      expect(await card.getByRole("textbox").count()).toBe(0);
      expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);
      await initialExpand.click();
      await card.getByText(title, { exact: true }).waitFor();
      expect(await composer.inputValue()).toBe("Continue researching while I decide.");

      await custom.fill("Readers new to the project");
      await button(card, "Collapse question").click();
      const expand = button(card, "Expand question");
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
      await button(card, "Next").click();
      await card.getByText(title, { exact: true }).waitFor();
      expect(await custom.inputValue()).toBe("Readers new to the project");
      expect(await composer.isVisible()).toBe(true);
      await button(card, "Previous").click();
      await card.getByText(blockingTitle, { exact: true }).waitFor();
      const answers = { answers: { destination: ["Project notes"] } };
      await gateway.setMethodResponse("question.resolve", { status: "answered", answers });
      await card.getByRole("radio", { name: /Project notes/ }).click();
      await button(card, "Submit").click();
      const request = await gateway.waitForRequest("question.resolve");
      expect(request.params).toEqual({ id: "summary-destination", answers });
      await card.getByText(title, { exact: true }).waitFor();
      expect(await custom.inputValue()).toBe("Readers new to the project");
      await button(card, "Next").click();
      await card.getByText(secondTitle, { exact: true }).waitFor();
      await button(card, "Dismiss").click();
      await card.getByText(title, { exact: true }).waitFor();
      expect(await custom.inputValue()).toBe("Readers new to the project");
      await button(card, "Dismiss").click();
      await card.waitFor({ state: "detached" });
      expect(await composer.inputValue()).toBe("Continue researching while I decide.");
      const skipped = page.locator(".chat-thread .chat-question-summary");
      expect(await skipped.filter({ hasText: title }).textContent()).toContain("Dismissed");
      expect(await skipped.filter({ hasText: secondTitle }).textContent()).toContain("Dismissed");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it.each(["receipt", "reload", "discard", "legacy"] as const)(
    "recovers rejected answers for retry or explicit discard without another submission (%s)",
    async (confirmation) => {
      await withPage(async ({ page }) => {
        const deliveryQuestion = {
          ...questionMessage,
          __openclaw: { id: "delivery-question", seq: 1 },
        };
        const { gateway, card, custom, summary } = await openChat(page, {
          historyMessages: [deliveryQuestion],
        });
        const answer = confirmation === "discard" ? "Engineers" : "The customer support team";

        if (confirmation !== "discard") {
          await custom.fill(answer);
        }
        await gateway.deferNext("chat.send");
        await button(card, "Submit").click();
        const original = await gateway.waitForRequest("chat.send");
        expect(requireRecord(original.params)).toMatchObject({
          message: `> ${title}\n\n${answer}`,
          replyToId: "delivery-question",
        });
        await expectBrowser(summary).toContainText("Sending answer");
        await gateway.resolveDeferred("chat.send", {
          __mockError: { code: "UNAVAILABLE", message: "Synthetic send rejection" },
        });
        await card.waitFor({ state: "detached" });
        expect(await button(card, "Submit").count()).toBe(0);
        await summary.waitFor();
        expect(await summary.textContent()).toContain(answer);
        const failedSend = page.locator('.chat-send-status[data-send-state="failed"]');
        const retry = button(summary, "Retry answer");
        await retry.waitFor();
        await expectBrowser(summary).toContainText("Answer not sent");
        await expectBrowser(summary).toContainText("Synthetic send rejection");
        expect(await failedSend.getAttribute("title")).toBe("Synthetic send rejection");
        const queued = await readOutboxQueue(page);
        expect(queued).toHaveLength(1);
        expect(queued[0]?.asyncQuestionItemId).toBe("audience-question");
        expect(queued[0]?.replyToId).toBe("delivery-question");
        const queueId = queued[0]?.id;
        expect(queueId).toBeTruthy();
        await expectRequestCountStable(gateway, "chat.send", 1);
        if (confirmation === "legacy") {
          // Seed the pre-change row after leaving the app, so no live writer
          // races the old producer. Every other payload/target field is retained.
          await page.route("**/delivery-legacy-seed", (route) =>
            route.fulfill({ contentType: "text/html", body: "Synthetic legacy delivery seed" }),
          );
          await page.goto(`${suite.server.baseUrl}delivery-legacy-seed`);
          await page.evaluate(() => {
            for (const key of Object.keys(sessionStorage)) {
              if (!key.startsWith("openclaw.control.chatComposer.v4:")) {
                continue;
              }
              const stored = JSON.parse(sessionStorage.getItem(key)!) as {
                sessions: Record<string, { queue?: Array<{ asyncQuestionItemId?: string }> }>;
              };
              for (const session of Object.values(stored.sessions)) {
                for (const item of session.queue ?? []) {
                  delete item.asyncQuestionItemId;
                }
              }
              sessionStorage.setItem(key, JSON.stringify(stored));
            }
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await failedSend.waitFor();
          expect((await readOutboxQueue(page))[0]?.asyncQuestionItemId).toBeUndefined();
        } else {
          await page.reload();
          await expectBrowser(summary).toContainText("Answer not sent");
          await expectBrowser(card).toHaveCount(0);
        }
        expect((await readOutboxQueue(page)).map((item) => item.id)).toEqual([queueId]);
        await expectRequestCountStable(gateway, "chat.send", 0);
        if (confirmation === "discard") {
          const laterRequest = {
            role: "user",
            content: "Finish the summary.",
            __openclaw: {
              id: "delivery-follow-up",
              seq: 2,
              runId: "delivery-finishing-run",
            },
          };
          const laterFinal = terminalMessage(
            "Summary finished.",
            "delivery-completed",
            3,
            "delivery-finishing-run",
          );
          await gateway.setHistoryMessages([deliveryQuestion, laterRequest, laterFinal]);
          for (const message of [laterRequest, laterFinal]) {
            await emitMessage(gateway, message);
          }
          await expectBrowser(
            page.locator(".chat-thread-inner").getByText(laterFinal.content, { exact: true }),
          ).toBeVisible();
          await expectBrowser(summary).toContainText("Answer not sent");
          await failedSend.getByRole("button", { name: "Discard", exact: true }).click();
          await expectBrowser(card).toBeVisible();
          await expectBrowser(card.getByRole("radio", { name: /Engineers/ })).toHaveAttribute(
            "aria-checked",
            "true",
          );
          await expectBrowser(custom).toHaveValue("");
          expect(await readOutboxQueue(page)).toEqual([]);
          await expectBrowser(summary).not.toContainText("Awaiting delivery confirmation");
          await page.reload();
          await expectBrowser(card).toBeVisible();
          await expectBrowser(card.getByRole("radio", { name: /Engineers/ })).toHaveAttribute(
            "aria-checked",
            "true",
          );
          await expectBrowser(custom).toHaveValue("");
          expect(await readOutboxQueue(page)).toEqual([]);
          await expectRequestCountStable(gateway, "chat.send", 0);
          return;
        }
        await gateway.deferNext("chat.send");
        await (
          confirmation === "legacy"
            ? failedSend.getByRole("button", { name: "Retry queued message", exact: true })
            : retry
        ).click();
        const retried = await gateway.waitForRequest("chat.send");
        expect(requireRecord(retried.params)).toMatchObject({
          message: requireRecord(original.params).message,
          replyToId: requireRecord(original.params).replyToId,
        });
        const userMessages = page.locator(".chat-group.user .chat-bubble");
        expect(await userMessages.count()).toBe(1);
        expect((await readOutboxQueue(page)).map((item) => item.id)).toEqual([queueId]);
        if (confirmation === "legacy") {
          // Old persisted rows have no question association. Their existing
          // outbox status owns retry until canonical saved history resolves it.
          await expectBrowser(failedSend).toHaveCount(0);
          await expectBrowser(summary).toContainText("Answer above the message box");
          expect((await readOutboxQueue(page))[0]?.asyncQuestionItemId).toBeUndefined();
        } else {
          await expectBrowser(summary).toContainText("Sending answer");
        }
        await gateway.resolveDeferred("chat.send");
        if (confirmation !== "legacy") {
          await expectBrowser(summary).toContainText("Awaiting delivery confirmation");
          await expectBrowser(card).toHaveCount(0);
        }
        if (confirmation === "reload") {
          // A durable row retires on messageSeq only after the Gateway commits
          // canonical source. A missed live receipt must be recovered by startup,
          // with no pane-local submitted marker and no new answer submission.
          expect(await readOutboxQueue(page)).toEqual([]);
          await page.reload();
          await expectBrowser(summary).toContainText("Answer sent");
          await expectBrowser(summary).toContainText("The customer support team");
          await expectBrowser(card).toHaveCount(0);
          expect(await userMessages.count()).toBe(1);
          expect(await readOutboxQueue(page)).toEqual([]);
          await expectRequestCountStable(gateway, "chat.send", 0);
          return;
        }
        const runId = String(requireRecord(retried.params).idempotencyKey);
        // The ACK commits history without emitting a receipt; prove that gap before delivery.
        const savedAnswer = {
          role: "user",
          content: requireRecord(retried.params).message,
          __openclaw: { id: `mock-user:${runId}`, seq: 2, replyToId: "delivery-question" },
          idempotencyKey: `${runId}:user`,
        };
        await emitMessage(gateway, savedAnswer, { clientRunId: runId });
        await expectBrowser(summary).toContainText("Answer sent");
        await failedSend.waitFor({ state: "detached" });
        expect(await userMessages.count()).toBe(1);
        expect(await button(card, "Submit").count()).toBe(0);
        await expectRequestCountStable(gateway, "chat.send", 1);
      });
    },
  );

  it("does not resurrect a saved async answer after reload or remount", async () => {
    await withPage(async ({ page }) => {
      const sessionKey = "agent:main:dashboard:async-question-answer-persistence";
      const savedQuestion = {
        ...questionMessage,
        __openclaw: { id: "saved-audience-question", seq: 1 },
      };
      const savedAnswer = {
        role: "user",
        content: `> ${title}\n\nEveryone`,
        __openclaw: { id: "saved-audience-answer", seq: 2 },
        timestamp: questionMessage.timestamp + 1_000,
      };
      const { gateway, card, summary } = await openChat(page, {
        sessionKey,
        historyMessages: [savedQuestion],
      });
      await card.getByRole("radio", { name: /Engineers/ }).waitFor();
      await gateway.setMethodResponse("chat.history", {
        messages: [savedQuestion, savedAnswer],
        sessionInfo: { hasActiveRun: false, activeRunIds: [] },
      });
      await page.reload();
      await expectBrowser(card).toHaveCount(0);

      await summary.waitFor();
      await expectBrowser(summary).toContainText("Everyone");
      // Remount must derive completion from history, not the prior mount's draft map.
      await page.reload();
      await expectBrowser(card).toHaveCount(0);
      await expectBrowser(summaryFor(page)).toContainText("Everyone");
    });
  });

  it.each(["offline", "malformed"] as const)(
    "keeps the original question transcript readable when %s",
    async (fallback) => {
      await withPage(async ({ page }) => {
        const followUpTitle = "What should I emphasize?";
        const { gateway } = await openChat(page, {
          historyMessages: [
            fallback === "offline"
              ? withFollowUp(followUpTitle)
              : { ...questionMessage, openclawAsyncDelivery: undefined },
          ],
        });
        const transcript = page.locator(".chat-text");
        if (fallback === "offline") {
          const card = questionPanel(page);
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
