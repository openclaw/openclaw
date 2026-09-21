import path from "node:path";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  reconnectMockGateway,
  defaultControlUiFeatureMethods,
} from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProof,
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
          const ownFinal = {
            role: "assistant",
            content: "The draft is ready; you can still choose an audience.",
            phase: "final_answer",
            stopReason: "stop",
            __openclaw: {
              id: "draft-ready",
              seq: 3,
              runId: "question-run",
              runTerminal: true,
              mirrorOrigin: "codex-app-server",
            },
          };
          const history = [
            {
              role: "user",
              content: "Prepare a project summary.",
              __openclaw: { id: "initial-request", seq: 1, runId: "question-run" },
            },
            prompt,
            ...(recovery ? [] : [ownFinal]),
          ];
          const gateway = await installMockGateway(page, { historyMessages: history });
          await page.goto(`${suite.server.baseUrl}chat`);
          const dock = page.locator(".agent-chat__question-dock");
          await expectBrowser(dock).toBeVisible();
          const draft = dock.getByRole("textbox", { name: `Your own answer for ${title}` });
          const nextFinal = {
            role: "assistant",
            content: "The summary is finalized and the task is complete.",
            stopReason: "stop",
            __openclaw: {
              id: "summary-finalized",
              seq: 5,
              runId: "finishing-run",
              runTerminal: true,
              mirrorOrigin: "codex-app-server",
            },
          };
          const nextRequest = {
            role: "user",
            content: recovery
              ? "Resume work after the Gateway restart."
              : "Use your best judgment and finalize it.",
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
          await gateway.emitGatewayEvent("session.message", {
            sessionKey: "agent:main:main",
            messageId: "follow-up",
            messageSeq: 4,
            message: nextRequest,
          });
          await expectBrowser(
            page.getByText(recovery ? "System · restart recovery" : nextRequest.content, {
              exact: true,
            }),
          ).toBeVisible();
          await expectBrowser(dock).toBeVisible();
          await gateway.setHistoryMessages(finalHistory);
          await gateway.emitGatewayEvent("session.message", {
            sessionKey: "agent:main:main",
            messageId: "summary-finalized",
            messageSeq: 5,
            message: nextFinal,
          });
          await expectBrowser(dock).toHaveCount(0);
          const summary = page.locator(".chat-question-summary").filter({ hasText: title });
          await expectBrowser(summary).toContainText("No longer pending");
          await summary.getByRole("button", { name: "Answer", exact: true }).click();
          await expectBrowser(dock).toBeVisible();
          await expectBrowser(draft).toHaveValue("");
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          expect(await gateway.getRequests("question.resolve")).toHaveLength(0);

          return finalHistory;
        },
      );

      // A fresh tab reconstructs archival from the saved transcript, not a
      // remembered dismissal or the first tab's reopened draft.
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const gateway = await installMockGateway(page, { historyMessages: completedHistory });
        await page.goto(`${suite.server.baseUrl}chat`);
        const dock = page.locator(".agent-chat__question-dock");
        const summary = page.locator(".chat-question-summary").filter({ hasText: title });
        await expectBrowser(
          page.getByText("The summary is finalized and the task is complete.", { exact: true }),
        ).toBeVisible();
        await expectBrowser(dock).toHaveCount(0);
        await expectBrowser(summary).toContainText("No longer pending");
        await page.reload();
        await expectBrowser(summary).toContainText("No longer pending");
        await expectBrowser(dock).toHaveCount(0);
        await summary.getByRole("button", { name: "Answer", exact: true }).click();
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
      await captureUiProof(
        suite,
        page,
        "async-question-draft-protection",
        "before-later-completion.png",
      );
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
      await expectBrowser(page.getByText("Other work finished.", { exact: true })).toBeVisible();
      await expectBrowser(draft).toHaveValue("New contributors and maintainers");
      // Observe the owning IndexedDB transaction, not a timeout, before simulating a reload.
      await expect
        .poll(() =>
          page.evaluate(async () => {
            if (!(await indexedDB.databases()).some((db) => db.name === "openclaw-control-ui")) {
              return false;
            }
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const request = indexedDB.open("openclaw-control-ui");
              request.addEventListener("success", () => resolve(request.result), { once: true });
              request.addEventListener(
                "error",
                () => reject(request.error ?? new Error("Could not open question draft database")),
                { once: true },
              );
            });
            try {
              const records = await new Promise<
                Array<{ questionDrafts?: Array<{ answers: Array<{ freeText: string }> }> }>
              >((resolve, reject) => {
                const request = db
                  .transaction("composerDrafts", "readonly")
                  .objectStore("composerDrafts")
                  .getAll();
                request.addEventListener("success", () => resolve(request.result), { once: true });
                request.addEventListener(
                  "error",
                  () => reject(request.error ?? new Error("Could not read question drafts")),
                  { once: true },
                );
              });
              return records.some((record) =>
                record.questionDrafts?.some((question) =>
                  question.answers.some(
                    (answer) => answer.freeText === "New contributors and maintainers",
                  ),
                ),
              );
            } finally {
              db.close();
            }
          }),
        )
        .toBe(true);
      await page.reload();
      await expectBrowser(draft).toHaveValue("New contributors and maintainers");
      await reconnectMockGateway(page, gateway, "question-draft-reconnect");
      await expectBrowser(draft).toHaveValue("New contributors and maintainers");
      await captureUiProof(
        suite,
        page,
        "async-question-draft-protection",
        "after-reload-reconnect.png",
      );
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("question.resolve")).toHaveLength(0);
    });
  });

  it("dismisses durably with Undo and reopens after reload without resolving or stopping work", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, { historyMessages: [questionMessage] });
      await page.goto(`${suite.server.baseUrl}chat`);
      const dock = page.locator(".agent-chat__question-dock");
      const draft = dock.getByRole("textbox", { name: `Your own answer for ${title}` });
      await draft.fill("My project team");
      await captureUiProof(suite, page, "async-question-dismissal", "before-dismissal.png");
      await dock.getByRole("button", { name: "Dismiss", exact: true }).click();
      const toast = page.locator(".app-toast");
      await expectBrowser(toast).toContainText("Question dismissed. Work continues.");
      await expectBrowser(dock).toHaveCount(0);
      await captureUiProof(suite, page, "async-question-dismissal", "after-dismissal-undo.png");
      await toast.getByRole("button", { name: "Undo", exact: true }).click();
      await expectBrowser(draft).toHaveValue("My project team");
      // A visible restored answer is a durability boundary, with no intervening write.
      await page.reload();
      await expectBrowser(draft).toHaveValue("My project team");
      await dock.getByRole("button", { name: "Dismiss", exact: true }).click();
      // The toast is published after the durable write settles, so reload exercises stored state.
      await expectBrowser(toast).toContainText("Question dismissed. Work continues.");
      await page.reload();
      const summary = page.locator(".chat-question-summary").filter({ hasText: title });
      await expectBrowser(summary).toContainText("Dismissed");
      await expectBrowser(dock).toHaveCount(0);
      await captureUiProof(suite, page, "async-question-dismissal", "after-reload.png");
      await summary.getByRole("button", { name: "Answer", exact: true }).click();
      await expectBrowser(draft).toHaveValue("My project team");
      // A visible restored answer is a durability boundary, with no intervening write.
      await page.reload();
      await expectBrowser(draft).toHaveValue("My project team");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("question.resolve")).toHaveLength(0);
      expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
    });
  });

  it.each(
    [390, 430].flatMap((width) => (["light", "dark"] as const).map((theme) => ({ width, theme }))),
  )(
    "keeps the docked question and composer within a $width px $theme viewport",
    async ({ width, theme }) => {
      await suite.withPage(
        { viewport: { width: 1440, height: 1200 }, colorScheme: theme, reducedMotion: "reduce" },
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
    },
  );

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
      const gateway = await installMockGateway(page, {
        sessionKey,
        historyMessages: [replyMessage, multipleQuestions],
        inFlightRun: { runId: "working-run", startedAt: Date.now(), text: "" },
        sessionInfo: { hasActiveRun: true, activeRunIds: ["working-run"] },
      });
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.locator(".chat-thread").getByText(title, { exact: true }).waitFor();
        const artifactDir = createControlUiE2eArtifactDir(
          `async-question-${active ? "active" : "idle"}`,
        );
        await page.screenshot({
          path: path.join(artifactDir, "initial.png"),
          animations: "disabled",
        });
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
            __openclaw: { id: "draft-complete", seq: 3 },
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
        await page.screenshot({
          path: path.join(artifactDir, "minimized.png"),
          animations: "disabled",
        });
        await expand.click();
        expect(await freeText.inputValue()).toBe(
          "Include one practical example.\nKeep the next steps separate.",
        );
        await card.getByRole("button", { name: "Back", exact: true }).click();
        expect(await custom.inputValue()).toBe("/stop is an example for the whole team");
        await card.getByRole("button", { name: "Next", exact: true }).click();
        await page.screenshot({
          path: path.join(artifactDir, "question.png"),
          animations: "disabled",
        });
        await card.getByRole("button", { name: "Submit", exact: true }).click();
        const request = await gateway.waitForRequest("chat.send");
        const params = requireRecord(request.params);
        expect(params.message).toBe(
          `> ${title}\n\n/stop is an example for the whole team\n\n> ${followUpTitle}\n\nInclude one practical example.\nKeep the next steps separate.`,
        );
        expect(params.queueMode).toBe(active ? "steer" : undefined);
        expect(params).not.toHaveProperty("replyToId");
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
          await page.screenshot({
            path: path.join(artifactDir, "submitted-after-reload.png"),
            animations: "disabled",
          });
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
      expect(await initialExpand.textContent()).toContain("Optional · work can continue");
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

  it("transfers rejected answers to the existing outbox retry without a second form submission", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { historyMessages: [questionMessage] });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const card = page.locator(".agent-chat__question-dock openclaw-chat-question-panel");
      const custom = card.getByRole("textbox", { name: `Your own answer for ${title}` });
      await custom.fill("The customer support team");
      await gateway.deferNext("chat.send");
      await card.getByRole("button", { name: "Submit", exact: true }).click();
      await gateway.waitForRequest("chat.send");
      await gateway.resolveDeferred("chat.send", {
        __mockError: { code: "UNAVAILABLE", message: "Synthetic send rejection" },
      });
      await card.waitFor({ state: "detached" });
      expect(await card.getByRole("button", { name: "Submit", exact: true }).count()).toBe(0);
      const summary = page
        .locator(".chat-thread .chat-question-summary")
        .filter({ hasText: title });
      await summary.waitFor();
      expect(await summary.textContent()).toContain("The customer support team");
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

  it("does not resurrect a saved async answer after reload or remount", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const sessionKey = "agent:main:dashboard:async-question-answer-persistence";
    const savedQuestion = {
      ...questionMessage,
      __openclaw: { id: "saved-audience-question", seq: 1 },
    };
    const savedAnswer = {
      role: "user",
      content: `> ${title}\n\nEveryone`,
      timestamp: questionMessage.timestamp + 1_000,
      __openclaw: { id: "saved-audience-answer", seq: 2 },
    };
    const gateway = await installMockGateway(page, {
      sessionKey,
      historyMessages: [savedQuestion],
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const card = page.locator(".agent-chat__question-dock openclaw-chat-question-panel");
      await card.getByRole("radio", { name: /Engineers/ }).waitFor();
      await captureUiProof(suite, page, "async-question-answer-persistence", "before-answer.png");

      await gateway.setMethodResponse("chat.history", {
        messages: [savedQuestion, savedAnswer],
        sessionInfo: { hasActiveRun: false, activeRunIds: [] },
      });
      await page.reload();
      await expectBrowser(card).toHaveCount(0);
      const summary = page
        .locator(".chat-thread .chat-question-summary")
        .filter({ hasText: title });
      await summary.waitFor();
      await expectBrowser(summary).toContainText("Everyone");
      await captureUiProof(suite, page, "async-question-answer-persistence", "after-reload.png");

      // A second navigation must derive the same completed state from history rather than
      // relying on the first mount's local draft map.
      await page.reload();
      await expectBrowser(card).toHaveCount(0);
      await expectBrowser(
        page.locator(".chat-thread .chat-question-summary").filter({ hasText: title }),
      ).toContainText("Everyone");
      await captureUiProof(suite, page, "async-question-answer-persistence", "after-remount.png");
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
      const card = page.locator(".agent-chat__question-dock openclaw-chat-question-panel");
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
      expect(await page.locator("openclaw-chat-question-panel").count()).toBe(0);
      expect(await page.locator(".chat-text").textContent()).toContain("Engineers");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
