import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import {
  chatThreadDistanceFromBottom,
  createChatFlowE2eSuite,
  installMockGateway,
  newChatPage,
  requireRecord,
  requireString,
  scrollChatThreadToTop,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import { captureTopVisibleVirtualRow } from "./virtual-row-anchor.test-support.ts";

const suite = createChatFlowE2eSuite();
const scrollTop = (target: Locator) => target.evaluate((element) => element.scrollTop);
const draft = (prefix: string, length: number) =>
  Array.from({ length }, (_, index) => `${prefix} ${index + 1}`).join("\n");
const progressCard = (steps: { step: string; status: string }[], updatedAt: number) => ({
  "progressCard.get": {
    card: { revision: 1, sessionKey: "agent:main:main", updatedAt, steps },
  },
});

function history(prefix: string, baseTs = Date.now() - 100_000) {
  return Array.from({ length: 50 }, (_, index) => ({
    content: [
      { text: prefix + " " + index + "\n" + "extra transcript line\n".repeat(4), type: "text" },
    ],
    role: index % 2 === 0 ? "assistant" : "user",
    timestamp: baseTs + index,
  }));
}

async function openHistory(prefix: string, options: Parameters<typeof installMockGateway>[1] = {}) {
  const page = await newChatPage(suite);
  const gateway = await installMockGateway(page, { historyMessages: history(prefix), ...options });
  await page.goto(`${suite.server.baseUrl}chat`);
  await page.getByText(`${prefix} 49`).waitFor({ timeout: 10_000 });
  return { page, gateway };
}

suite.define(() => {
  it("keeps transcript wheels native while forwarding composer and overlay scrolling", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const baseTs = Date.now() - 100_000;
      const runId = "composer-scroll-run";
      const gateway = await installMockGateway(page, {
        historyMessages: history("Composer wheel history", baseTs),
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "progressCard.get",
          "taskSuggestions.list",
        ],
        methodResponses: {
          "taskSuggestions.list": {
            suggestions: [
              {
                id: "scroll-suggestion",
                title: "Inspect the wheel forwarding",
                prompt: "Inspect transcript and composer scrolling.",
                tldr: "Keep the transcript responsive.",
                cwd: "/projects/example",
                sessionKey: "main",
                agentId: "main",
                createdAt: baseTs,
              },
            ],
          },
        },
        inFlightRun: { runId, text: "Reviewing the workspace." },
        sessionInfo: { key: "agent:main:main", activeRunIds: [runId], hasActiveRun: true },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Composer wheel history 49").waitFor();
      const suggestion = page.locator(".task-suggestion__title");
      await suggestion.waitFor();
      await waitForChatScrollIdle(page);
      const thread = page.locator(".chat-thread");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      const input = page.locator(".agent-chat__input");
      const originalTop = await scrollTop(thread);
      const composerBounds = await input.boundingBox();
      const threadLayout = await thread.boundingBox();
      const latest = page.locator(".chat-scroll-to-bottom");
      expect(await latest.isVisible()).toBe(false);
      expect(await latest.getAttribute("aria-hidden")).toBe("true");
      expect(await latest.evaluate((element: HTMLButtonElement) => element.inert)).toBe(true);

      // Chromium's blocked-input warning must not crash while resolving the
      // conversation's listener. Age trusted input instead of stalling the UI.
      const devtools = await page.context().newCDPSession(page);
      await devtools.send("Log.enable");
      await devtools.send("Log.startViolationsReport", {
        config: [{ name: "blockedEvent", threshold: 1 }],
      });
      const threadBounds = await thread.boundingBox();
      if (!threadBounds) {
        throw new Error("Expected a visible transcript");
      }
      const crash = createDeferred<never>();
      let rendererCrashed = false;
      const onCrash = () => {
        rendererCrashed = true;
        crash.reject(new Error("Renderer crashed on delayed transcript wheel"));
      };
      page.on("crash", onCrash);
      try {
        // A cancel-capable ancestor forces native transcript input through the
        // renderer even when its callback immediately returns. Inspect browser
        // registrations without wrapping the handlers or changing their options.
        const { result, exceptionDetails } = await devtools.send("Runtime.evaluate", {
          expression: `(() => {
            const targets = [document, window];
            for (let node = document.querySelector(".chat-thread"); node; node = node.parentElement) {
              targets.push(node);
            }
            return targets.flatMap(target =>
              (getEventListeners(target).wheel ?? [])
                .filter(listener => !listener.passive)
                .map(() => target.className || target.nodeName || "window")
            );
          })()`,
          includeCommandLineAPI: true,
          returnByValue: true,
        });
        expect(exceptionDetails).toBeUndefined();
        expect(result.value).toEqual([]);

        await page.mouse.move(threadBounds.x + 24, threadBounds.y + threadBounds.height / 2);
        await page.mouse.wheel(0, -120);
        await expect.poll(() => scrollTop(thread)).toBeLessThan(originalTop - 80);
        await waitForChatScrollIdle(page);
        await Promise.race([
          devtools.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: threadBounds.x + threadBounds.width / 2,
            y: threadBounds.y + threadBounds.height / 2,
            deltaX: 0,
            deltaY: -1,
            timestamp: Date.now() / 1_000 - 2,
          }),
          crash.promise,
        ]);
        expect(await thread.evaluate((element) => element.isConnected)).toBe(true);
      } finally {
        page.off("crash", onCrash);
        if (!rendererCrashed) {
          await devtools.detach();
        }
      }

      const beforeComposerWheel = await scrollTop(thread);
      await composer.hover();
      await page.mouse.wheel(0, -300);
      await expect.poll(() => scrollTop(thread)).toBeLessThan(beforeComposerWheel - 100);
      await waitForChatScrollIdle(page);
      expect(await input.boundingBox()).toEqual(composerBounds);
      await page.getByRole("button", { name: "Scroll to latest" }).waitFor();
      expect(await thread.boundingBox()).toEqual(threadLayout);
      expect(await latest.evaluate((element: HTMLButtonElement) => element.inert)).toBe(false);
      const buttonBounds = (await latest.boundingBox())!;
      expect(buttonBounds.y + buttonBounds.height).toBeLessThan(
        (await page.locator(".agent-chat__composer-shell").boundingBox())!.y,
      );

      for (const target of [latest, suggestion]) {
        await target.hover();
        const beforeOverlay = await scrollTop(thread);
        await page.mouse.wheel(0, -120);
        await expect.poll(() => scrollTop(thread)).toBeLessThan(beforeOverlay - 80);
        await waitForChatScrollIdle(page);
      }
      const skipLink = page.locator(".chat-composer-skip-link");
      await skipLink.focus();
      await skipLink.hover();
      const beforeSkipLink = await scrollTop(thread);
      await page.mouse.wheel(0, -120);
      await expect.poll(() => scrollTop(thread)).toBeLessThan(beforeSkipLink - 80);
      await waitForChatScrollIdle(page);

      const footerAnchor = await captureTopVisibleVirtualRow(thread);
      await gateway.emitGatewayEvent("chat", {
        sessionKey: "agent:main:main",
        runId,
        state: "delta",
        message: { role: "assistant", content: "Reviewing the workspace.\n\nAnother finding." },
      });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const pane = document.querySelector<
              HTMLElement & { state: Pick<ChatPageHost, "sessionKey" | "chatRunId" | "chatStream"> }
            >("openclaw-chat-pane.chat-pane-cache__pane--active");
            return {
              sessionKey: pane?.state.sessionKey,
              runId: pane?.state.chatRunId,
              text: pane?.state.chatStream,
            };
          }),
        )
        .toEqual({
          sessionKey: "agent:main:main",
          runId,
          text: "Reviewing the workspace.\n\nAnother finding.",
        });
      await waitForChatScrollIdle(page);
      expect(await captureTopVisibleVirtualRow(thread)).toMatchObject({
        key: footerAnchor.key,
        viewportTop: footerAnchor.viewportTop,
      });
      await page.locator(".agent-chat__composer-footer").hover();
      await page.mouse.wheel(200, 0);
      await waitForChatScrollIdle(page);
      expect(await captureTopVisibleVirtualRow(thread)).toMatchObject({
        key: footerAnchor.key,
        viewportTop: footerAnchor.viewportTop,
      });
      await page.waitForTimeout(201); // Start a second gesture beyond the 200 ms burst window.
      const beforeFooterWheel = await scrollTop(thread);
      await page.mouse.wheel(0, -200);
      await expect.poll(() => scrollTop(thread)).toBeLessThan(beforeFooterWheel - 100);
      await waitForChatScrollIdle(page);

      await composer.fill(draft("Draft line", 30));
      await composer.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await waitForChatScrollIdle(page);
      const draftAnchor = await captureTopVisibleVirtualRow(thread);
      const draftTop = await scrollTop(composer);
      await composer.hover();
      await page.mouse.wheel(0, -200);
      await expect.poll(() => scrollTop(composer)).toBeLessThan(draftTop);
      expect(await captureTopVisibleVirtualRow(thread)).toMatchObject({
        key: draftAnchor.key,
        viewportTop: draftAnchor.viewportTop,
      });
      await composer.evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.mouse.wheel(0, -200);
      await waitForChatScrollIdle(page);
      expect(await captureTopVisibleVirtualRow(thread)).toMatchObject({
        key: draftAnchor.key,
        viewportTop: draftAnchor.viewportTop,
      });
      await page.getByRole("button", { name: "Scroll to latest" }).click();
      await expect.poll(() => chatThreadDistanceFromBottom(page)).toBeLessThanOrEqual(4);
      await thread.getByText("Another finding.", { exact: false }).waitFor({ state: "visible" });
    });
  });

  it("scrolls a delayed pending send while Details progress expands before the ACK resolves", async () => {
    const baseTs = Date.now() - 100_000;
    const { page, gateway } = await openHistory("History message", {
      featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
      historyMessages: history("History message", baseTs),
      methodResponses: progressCard(
        [
          { step: "Inspect the conversation", status: "completed" },
          { step: "Review the requested changes", status: "completed" },
          { step: "Check the latest result", status: "in_progress" },
          { step: "Verify the next reply", status: "pending" },
        ],
        baseTs,
      ),
    });
    const progress = page.locator('[data-progress-card-placement="details"]');
    await openChatDetails(page);
    await expect.poll(() => progress.getAttribute("open")).toBe("");
    await progress.locator("summary").click();
    await expect.poll(() => progress.getAttribute("open")).toBeNull();
    await expect
      .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(4);

    await waitForChatScrollIdle(page);
    await expect
      .poll(
        async () => {
          await scrollChatThreadToTop(page);
          return chatThreadDistanceFromBottom(page);
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(200);

    await gateway.deferNext("chat.send");

    const prompt = `pending send should scroll before ack\n${"visible now\n".repeat(6)}`;
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    await composer.fill(prompt);
    const draftHeight = await composer.evaluate((element) => element.clientHeight);
    // Opening Details must not interfere with submission or the pending-send
    // scroll, even before the delayed ACK resolves.
    await openChatDetails(page);
    await progress.locator("summary").click();
    await composer.press("Enter");

    const sendRequest = await gateway.waitForRequest("chat.send");
    const params = requireRecord(sendRequest.params);
    const runId = requireString(params.idempotencyKey, "chat send idempotency key");

    await expect.poll(() => progress.getAttribute("open")).toBe("");
    await expect.poll(() => composer.inputValue()).toBe("");
    await expect
      .poll(() => composer.evaluate((element) => element.clientHeight))
      .toBeLessThan(draftHeight);
    await page.locator(".chat-thread").getByText("pending send should scroll").waitFor({
      timeout: 10_000,
    });
    await waitForChatScrollIdle(page);
    await expect
      .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(4);

    await gateway.resolveDeferred("chat.send", { runId, status: "started" });
  });
});
