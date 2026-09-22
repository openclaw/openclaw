import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
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
  it.each([false, true])(
    "submits an async answer as ordinary chat with an active run=%s",
    async (active) => {
      const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const followUpTitle = "What should I emphasize?";
      const multipleQuestions = {
        ...questionMessage,
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
        __openclaw: { id: "composer-reply-target", seq: 1 },
      };
      const gateway = await installMockGateway(page, {
        historyMessages: [replyMessage, multipleQuestions],
        inFlightRun: { runId: "working-run", startedAt: Date.now(), text: "" },
        sessionInfo: { hasActiveRun: true, activeRunIds: ["working-run"] },
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.locator(".chat-thread").getByText(title, { exact: true }).waitFor();
        const artifactDir = createControlUiE2eArtifactDir(
          `async-question-${active ? "active" : "idle"}`,
        );
        await page.screenshot({
          path: path.join(artifactDir, "initial.png"),
          animations: "disabled",
        });
        const card = page.locator("openclaw-chat-async-question");
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
        if (!active) {
          await gateway.setMethodResponse("chat.history", {
            messages: [replyMessage, multipleQuestions],
            sessionInfo: { hasActiveRun: false, activeRunIds: [] },
          });
          await gateway.emitChatFinal({ runId: "working-run", text: "I finished the draft." });
          await page
            .getByRole("button", { name: "Stop generating" })
            .waitFor({ state: "detached" });
          expect(await freeText.inputValue()).toBe("Include one practical example.");
        }
        await page.screenshot({
          path: path.join(artifactDir, "question.png"),
          animations: "disabled",
        });
        await card.getByRole("button", { name: "Submit", exact: true }).click();
        const request = await gateway.waitForRequest("chat.send");
        const params = requireRecord(request.params);
        expect(params.message).toBe(
          `> ${title}\n\n/stop is an example for the whole team\n\n> ${followUpTitle}\n\nInclude one practical example.`,
        );
        expect(params.queueMode).toBe(active ? "steer" : undefined);
        expect(params).not.toHaveProperty("replyToId");
        expect(await composer.inputValue()).toBe("Keep this separate composer draft.");
        expect(await composerReply.textContent()).toContain(replyMessage.content);
        expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
        expect(await gateway.getRequests("question.resolve")).toHaveLength(0);
        await card.getByRole("status").waitFor();
        await expectRequestCountStable(gateway, "chat.send", 1);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("transfers rejected answers to the existing outbox retry without a second form submission", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { historyMessages: [questionMessage] });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const card = page.locator("openclaw-chat-async-question");
      const custom = card.getByRole("textbox", { name: `Your own answer for ${title}` });
      await custom.fill("The customer support team");
      await gateway.deferNext("chat.send");
      await card.getByRole("button", { name: "Submit", exact: true }).click();
      await gateway.waitForRequest("chat.send");
      await gateway.resolveDeferred("chat.send", {
        __mockError: { code: "UNAVAILABLE", message: "Synthetic send rejection" },
      });
      await card.getByRole("status").waitFor();
      expect(await card.getByRole("button", { name: "Submit", exact: true }).count()).toBe(0);
      expect(await card.getByRole("status").textContent()).toContain("The customer support team");
      const failedSend = page.locator('.chat-send-status[data-send-state="failed"]');
      const retry = failedSend.getByRole("button", { name: "Retry queued message" });
      await retry.waitFor();
      expect(await failedSend.getAttribute("title")).toBe("Synthetic send rejection");
      const queued = await readOutboxQueue(page);
      expect(queued).toHaveLength(1);
      const queueId = queued[0]?.id;
      expect(queueId).toBeTruthy();
      await expectRequestCountStable(gateway, "chat.send", 1);
      await gateway.deferNext("chat.send");
      await retry.click();
      const retried = await gateway.waitForRequest("chat.send", { after: 1 });
      expect(requireRecord(retried.params).message).toBe(`> ${title}\n\nThe customer support team`);
      const userMessages = page.locator(".chat-group.user .chat-bubble");
      expect(await userMessages.count()).toBe(1);
      expect((await readOutboxQueue(page)).map((item) => item.id)).toEqual([queueId]);
      await gateway.resolveDeferred("chat.send");
      await failedSend.waitFor({ state: "detached" });
      expect(await userMessages.count()).toBe(1);
      expect(await card.getByRole("button", { name: "Submit", exact: true }).count()).toBe(0);
      await expectRequestCountStable(gateway, "chat.send", 2);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps every question and option readable when sending is unavailable", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const followUpTitle = "What should I emphasize?";
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          ...questionMessage,
          content: `${questionMessage.content}\n\n${followUpTitle}`,
          openclawAsyncDelivery: {
            ...questionMessage.openclawAsyncDelivery,
            questions: [
              ...questionMessage.openclawAsyncDelivery.questions,
              { title: followUpTitle },
            ],
          },
        },
      ],
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const card = page.locator("openclaw-chat-async-question");
      await card.getByRole("radio", { name: /Engineers/ }).waitFor();
      await gateway.setOnline(false);
      await card.waitFor({ state: "detached" });
      const transcript = page.locator(".chat-text");
      await transcript.getByText(followUpTitle, { exact: true }).waitFor();
      expect(await transcript.textContent()).toContain(title);
      expect(await transcript.textContent()).toContain("Engineers");
      expect(await transcript.textContent()).toContain("Everyone");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps malformed question metadata as the original transcript text", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [{ ...questionMessage, openclawAsyncDelivery: undefined }],
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".chat-text").getByText(title).waitFor();
      const artifactDir = createControlUiE2eArtifactDir("async-question-plain-text");
      await page.screenshot({
        path: path.join(artifactDir, "before-without-metadata.png"),
        animations: "disabled",
      });
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
      await page.locator(".chat-text").getByText(title).waitFor();
      expect(await page.locator("openclaw-chat-async-question").count()).toBe(0);
      expect(await page.locator(".chat-text").textContent()).toContain("Engineers");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
