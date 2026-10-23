import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import {
  acceptedQuestionInput,
  sharedQuestionHistory,
  sharedQuestion as questionMessage,
} from "./chat-async-questions.test-support.ts";
import {
  captureUiProof,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { readOutboxQueue } from "./chat-outbox-payloads.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const sharedChanged = { sessionKey: "agent:main:main", agentId: "main", reason: "send" };
const sharedDock = ".agent-chat__question-dock";

suite.define(() => {
  it("shares acceptance and reopens only after confirmed withdrawal in both mounted viewers", async () => {
    const contexts = await Promise.all(
      [0, 1].map(() => suite.newBrowserContext(createControlUiE2eContextOptions())),
    );
    try {
      const pages = await Promise.all(contexts.map((context) => context.newPage()));
      const gateways = await Promise.all(
        pages.map((page) => installMockGateway(page, { historyMessages: [questionMessage] })),
      );
      await Promise.all(pages.map((page) => page.goto(suite.server.baseUrl + "chat")));
      const cards = pages.map((page) => page.locator(sharedDock + " openclaw-chat-question-panel"));
      await Promise.all(cards.map((card) => expectBrowser(card).toBeVisible()));
      const submitter = gateways[0]!;
      await submitter.deferNext("chat.send");
      await cards[0]!.getByRole("button", { name: "Submit", exact: true }).click();
      const first = await submitter.waitForRequest("chat.send");
      const runId = requireString(requireRecord(first.params).idempotencyKey, "submitted run ID");
      const input = acceptedQuestionInput(runId);
      const history = sharedQuestionHistory(input);
      await Promise.all(
        gateways.map((gateway) => gateway.setMethodResponse("chat.history", history)),
      );
      await submitter.resolveDeferred("chat.send", { runId, status: "queued" });
      await Promise.all(
        gateways.map((gateway) => gateway.emitGatewayEvent("sessions.changed", sharedChanged)),
      );
      for (const page of pages) {
        await expectBrowser(page.locator(".chat-question-summary")).toContainText("Answer queued");
        await expectBrowser(page.locator(sharedDock)).toHaveCount(0);
      }
      await submitter.deferNext("chat.abort");
      await pages[0]!
        .locator(".chat-queue__item")
        .getByRole("button", { name: "Remove queued message" })
        .click();
      expect((await submitter.waitForRequest("chat.abort")).params).toMatchObject({
        runId,
        discardPendingInput: true,
      });
      // Clicking remove isn't acceptance of withdrawal; both panes must stay resolved.
      await Promise.all(cards.map((card) => expectBrowser(card).toHaveCount(0)));
      const cancelled = {
        ...history,
        pendingInputs: {
          items: [
            {
              ...input,
              state: "cancelled",
              queued: undefined,
              message: {
                role: "user",
                content: [],
                display: false,
                __openclaw: { id: "pending:shared-answer" },
              },
            },
          ],
          total: 1,
          queuedCount: 0,
        },
        inputReceipts: [{ runId, state: "pending", cancelled: true }],
      };
      await Promise.all(
        gateways.map((gateway) => gateway.setMethodResponse("chat.history", cancelled)),
      );
      await submitter.resolveDeferred("chat.abort", { aborted: true, runIds: [runId] });
      await gateways[1]!.emitGatewayEvent("sessions.changed", sharedChanged);
      for (const page of pages) {
        await expectBrowser(page.locator(".chat-queue__item")).toHaveCount(0);
      }
      await Promise.all(cards.map((card) => expectBrowser(card).toBeVisible()));
      expect(await submitter.getRequests("chat.send")).toHaveLength(1);
      expect(await gateways[1]!.getRequests("chat.send")).toHaveLength(0);
    } finally {
      await Promise.all(contexts.map((context) => suite.closeBrowserContext(context)));
    }
  });

  it("retires a stale loser's bytes, hydrates the winner through reload and confirms the canonical answer", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, { historyMessages: [questionMessage] });
      await page.goto(suite.server.baseUrl + "chat");
      const card = page.locator(sharedDock + " openclaw-chat-question-panel");
      await gateway.deferNext("chat.send");
      await card.getByRole("button", { name: "Submit", exact: true }).click();
      expect((await gateway.waitForRequest("chat.send")).params).toMatchObject({
        replyToId: "audience-prompt",
        asyncQuestionItemId: "audience-question",
      });
      // Legacy accepted inputs have replyToId but no optional-question metadata.
      const pending = acceptedQuestionInput("other-viewer", "Everyone", true);
      const history = sharedQuestionHistory(pending);
      await gateway.setMethodResponse("chat.history", history);
      await gateway.setMethodResponse("chat.startup", history);
      await gateway.rejectDeferred("chat.send", {
        code: "INVALID_REQUEST",
        message: "This question already has an accepted answer.",
        details: { reason: "async-question-already-answered" },
      });
      const summary = page.locator(".chat-question-summary");
      await expectBrowser(summary).toContainText("Everyone");
      await expectBrowser(summary).toContainText("Answer queued");
      await expectBrowser(card).toHaveCount(0);
      await expect.poll(async () => await readOutboxQueue(page)).toHaveLength(0);
      await expectBrowser(
        page.locator(".chat-group.user").filter({ hasText: "Engineers" }),
      ).toHaveCount(0);
      await expectBrowser(
        page.locator(".chat-queue__item").filter({ hasText: "Everyone" }),
      ).toBeVisible();
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      await captureUiProof(suite, page, "shared-async-answer", "shared-queued.png");
      await page.reload();
      await expectBrowser(summary).toContainText("Everyone");
      await expectBrowser(summary).toContainText("Answer queued");
      await expectBrowser(card).toHaveCount(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await readOutboxQueue(page)).toHaveLength(0);
      await gateway.emitGatewayEvent("session.message", {
        sessionKey: "agent:main:main",
        messageId: "canonical-answer",
        messageSeq: 2,
        message: {
          ...pending.message,
          __openclaw: { ...pending.message["__openclaw"], id: "canonical-answer", seq: 2 },
        },
      });
      await expectBrowser(summary).toContainText("Answer sent");
      await expectBrowser(card).toHaveCount(0);
    });
  });
});
