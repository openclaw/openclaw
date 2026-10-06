import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { CHAT_TRANSCRIPT_END_THRESHOLD_PX } from "../pages/chat/scroll.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  chatThreadDistanceFromBottom,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
  scrollChatThreadToTop,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("scrolls the transcript over the pinned composer while preserving nested scrolling", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const baseTs = Date.now() - 100_000;
      const runId = "composer-scroll-run";
      const gateway = await installMockGateway(page, {
        historyMessages: Array.from({ length: 50 }, (_, index) => ({
          role: index % 2 === 0 ? "assistant" : "user",
          content: `Composer wheel history ${index}\n${"Transcript detail\n".repeat(4)}`,
          timestamp: baseTs + index,
        })),
        featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
        inFlightRun: { runId, text: "Reviewing the workspace." },
        sessionInfo: { key: "agent:main:main", activeRunIds: [runId], hasActiveRun: true },
        methodResponses: {
          "progressCard.get": {
            card: {
              revision: 1,
              sessionKey: "agent:main:main",
              updatedAt: baseTs,
              steps: Array.from({ length: 30 }, (_, index) => ({
                step: `Review item ${index + 1}`,
                status: index === 0 ? "in_progress" : "pending",
              })),
            },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Composer wheel history 49").waitFor();
      await waitForChatScrollIdle(page);
      const thread = page.locator(".chat-thread");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      const input = page.locator(".agent-chat__input");
      const originalTop = await thread.evaluate((element) => element.scrollTop);
      const composerBounds = await input.boundingBox();

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

      await composer.hover();
      await page.mouse.wheel(0, -300);
      await expect
        .poll(() => thread.evaluate((element) => element.scrollTop))
        .toBeLessThan(originalTop - 100);
      await waitForChatScrollIdle(page);
      expect(await input.boundingBox()).toEqual(composerBounds);
      await page.getByRole("button", { name: "Scroll to latest" }).waitFor();

      const beforeFooter = await thread.evaluate((element) => element.scrollTop);
      await gateway.emitGatewayEvent("chat", {
        sessionKey: "agent:main:main",
        runId,
        state: "delta",
        message: { role: "assistant", content: "Reviewing the workspace.\n\nAnother finding." },
      });
      await expect.poll(() => thread.textContent()).toContain("Another finding.");
      await waitForChatScrollIdle(page);
      expect(await thread.evaluate((element) => element.scrollTop)).toBe(beforeFooter);
      await page.locator(".agent-chat__composer-footer").hover();
      await page.mouse.wheel(200, 0);
      await waitForChatScrollIdle(page);
      expect(await thread.evaluate((element) => element.scrollTop)).toBe(beforeFooter);
      await page.waitForTimeout(201); // Start a second gesture beyond the 200 ms burst window.
      await page.mouse.wheel(0, -200);
      await expect
        .poll(() => thread.evaluate((element) => element.scrollTop))
        .toBeLessThan(beforeFooter - 100);
      await waitForChatScrollIdle(page);

      const progress = page.locator(
        ".session-progress-card--composer .session-progress-card__body",
      );
      await expect
        .poll(() => page.locator(".session-progress-card--composer").getAttribute("open"))
        .toBeNull();
      await page.locator(".session-progress-card--composer > summary").click();
      await progress.waitFor();
      await waitForChatScrollIdle(page);
      const beforeProgress = await thread.evaluate((element) => element.scrollTop);
      await progress.hover();
      await page.mouse.wheel(0, 250);
      await expect.poll(() => progress.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      expect(await thread.evaluate((element) => element.scrollTop)).toBe(beforeProgress);

      await composer.fill(
        Array.from({ length: 30 }, (_, index) => `Draft line ${index}`).join("\n"),
      );
      await composer.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await waitForChatScrollIdle(page);
      const beforeDraft = await thread.evaluate((element) => element.scrollTop);
      const draftTop = await composer.evaluate((element) => element.scrollTop);
      await composer.hover();
      await page.mouse.wheel(0, -200);
      await expect
        .poll(() => composer.evaluate((element) => element.scrollTop))
        .toBeLessThan(draftTop);
      expect(await thread.evaluate((element) => element.scrollTop)).toBe(beforeDraft);
      await composer.evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.mouse.wheel(0, -200);
      await waitForChatScrollIdle(page);
      expect(await thread.evaluate((element) => element.scrollTop)).toBe(beforeDraft);
    });
  });

  it("keeps a bottom-anchored transcript pinned while the composer grows", async () => {
    const artifactDirParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactDirParent
      ? createControlUiE2eArtifactDir("chat-flow.streaming", artifactDirParent)
      : undefined;
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const baseTs = Date.now() - 100_000;
    const historyMessages = Array.from({ length: 50 }, (_, index) => ({
      content: [
        {
          text: `Composer resize history ${index}\n${"extra transcript line\n".repeat(4)}`,
          type: "text",
        },
      ],
      role: index % 2 === 0 ? "assistant" : "user",
      timestamp: baseTs + index,
    }));
    await installMockGateway(page, { historyMessages });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Composer resize history 49").waitFor({ timeout: 10_000 });
      await expect
        .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
        .toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
      await waitForChatScrollIdle(page);

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      for (let line = 1; line <= 8; line += 1) {
        await composer.fill(
          Array.from({ length: line }, (_, index) => `Growing composer line ${index + 1}`).join(
            "\n",
          ),
        );
        await waitForChatScrollIdle(page);
        expect(
          await chatThreadDistanceFromBottom(page),
          `composer line count ${line}`,
        ).toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
      }
      if (artifactDir) {
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "composer-resize-pinned.png"),
        });
      }

      await composer.fill("Growing composer line 1");
      await waitForChatScrollIdle(page);
      await scrollChatThreadToTop(page);
      const readingScrollTop = await page
        .locator(".chat-thread")
        .evaluate((element) => element.scrollTop);
      await composer.fill(
        Array.from({ length: 8 }, (_, index) => `Reading composer line ${index + 1}`).join("\n"),
      );
      await waitForChatScrollIdle(page);
      expect(
        await page
          .locator(".chat-thread")
          .evaluate((element, initial) => Math.abs(element.scrollTop - initial), readingScrollTop),
      ).toBeLessThanOrEqual(1);

      if (artifactDir) {
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "composer-resize-manual-scroll.png"),
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("scrolls a delayed pending send past expanding progress before the ACK resolves", async () => {
    const artifactDirParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactDirParent
      ? createControlUiE2eArtifactDir("chat-send-scroll", artifactDirParent)
      : undefined;
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const baseTs = Date.now() - 100_000;
    const historyMessages = Array.from({ length: 50 }, (_, index) => ({
      content: [
        {
          text: `History message ${index}\n${"extra transcript line\n".repeat(4)}`,
          type: "text",
        },
      ],
      role: index % 2 === 0 ? "assistant" : "user",
      timestamp: baseTs + index,
    }));
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
      historyMessages,
      methodResponses: {
        "progressCard.get": {
          card: {
            revision: 1,
            sessionKey: "agent:main:main",
            updatedAt: baseTs,
            steps: [
              { step: "Inspect the conversation", status: "completed" },
              { step: "Review the requested changes", status: "completed" },
              { step: "Check the latest result", status: "in_progress" },
              { step: "Verify the next reply", status: "pending" },
            ],
          },
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("History message 49").waitFor({ timeout: 10_000 });
      const progress = page.locator('[data-progress-card-placement="composer"]');
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
      if (artifactDir) {
        await writeFile(
          path.join(artifactDir, "before-send.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [composer]),
        );
      }
      // Keyboard submission can land while the progress disclosure is resizing;
      // a pointer click on the moving send button would wait for stable layout.
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
      if (artifactDir) {
        await writeFile(
          path.join(artifactDir, "after-send.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [composer]),
        );
      }
      await expect
        .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
        .toBeLessThanOrEqual(4);

      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("overlays the scroll-to-bottom affordance without shrinking the transcript", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const baseTs = Date.now() - 100_000;
    const historyMessages = Array.from({ length: 50 }, (_, index) => ({
      content: [
        {
          text: `Scrollable history ${index}\n${"extra transcript line\n".repeat(4)}`,
          type: "text",
        },
      ],
      role: index % 2 === 0 ? "assistant" : "user",
      timestamp: baseTs + index,
    }));
    await installMockGateway(page, { historyMessages });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Scrollable history 49").waitFor({ timeout: 10_000 });
      await waitForChatScrollIdle(page);

      const readLayout = () =>
        page.locator(".chat-main").evaluate((container) => {
          const thread = container.querySelector<HTMLElement>(".chat-thread");
          const composer = container.querySelector<HTMLElement>(".agent-chat__composer-shell");
          const button = container.querySelector<HTMLElement>(".chat-scroll-to-bottom");
          if (!thread || !composer) {
            throw new Error("expected chat thread and composer");
          }
          const threadRect = thread.getBoundingClientRect();
          const composerRect = composer.getBoundingClientRect();
          const buttonRect = button?.getBoundingClientRect();
          return {
            buttonBottom: buttonRect ? Math.round(buttonRect.bottom) : null,
            composerTop: Math.round(composerRect.top),
            threadBottom: Math.round(threadRect.bottom),
          };
        });

      const before = await readLayout();
      const button = page.locator(".chat-scroll-to-bottom");
      expect(await button.isVisible()).toBe(false);
      expect(await button.getAttribute("aria-hidden")).toBe("true");
      expect(await button.evaluate((element: HTMLButtonElement) => element.inert)).toBe(true);

      await scrollChatThreadToTop(page);
      await page.getByRole("button", { name: "Scroll to latest" }).waitFor({ timeout: 10_000 });
      expect(await button.evaluate((element: HTMLButtonElement) => element.inert)).toBe(false);
      const after = await readLayout();

      expect(after.threadBottom).toBe(before.threadBottom);
      expect(after.composerTop).toBe(before.composerTop);
      expect(after.buttonBottom).not.toBeNull();
      expect(after.buttonBottom!).toBeLessThan(after.composerTop);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
