import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  expectDefined,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const height = (card: Locator) => card.evaluate((el) => el.getBoundingClientRect().height);
async function headerPoint(card: Locator) {
  const box = expectDefined(await card.locator("summary").boundingBox(), "progress header");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function wheel(page: Page, card: Locator, dy: number) {
  const point = await headerPoint(card);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, dy);
}
async function still(card: Locator, expected: number) {
  // A real pause, longer than the retired 240ms animation, must not finish the reveal.
  for (let i = 0; i < 6; i++) {
    await card.page().waitForTimeout(100);
    expect(Math.abs((await height(card)) - expected)).toBeLessThanOrEqual(1);
  }
}

suite.define(() => {
  it.each([
    { reducedMotion: "no-preference", mobile: false },
    { reducedMotion: "reduce", mobile: false },
    { reducedMotion: "reduce", mobile: true },
  ] as const)(
    "scrubs progress with wheel and drag, holds through streaming, and reverses ($reducedMotion, touch=$mobile)",
    async ({ reducedMotion, mobile }) => {
      const viewport = mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 };
      const proofDir = captureUiProofEnabled
        ? path.join(suite.artifactDir, "elastic", reducedMotion + (mobile ? "-mobile" : "-desktop"))
        : null;
      if (proofDir) {
        await mkdir(proofDir, { recursive: true });
      }
      const context = await suite.newBrowserContext({
        ...createControlUiE2eContextOptions(),
        reducedMotion,
        viewport,
        isMobile: mobile,
        hasTouch: mobile,
        ...(proofDir ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
      });
      const page = await context.newPage();
      const video = page.video();
      const sessionKey = "agent:main:main";
      const runId = "elastic-progress-run";
      let text = Array.from({ length: 48 }, (_, i) => "Current findings " + i + ".").join("\n\n");
      const initialCard = {
        sessionKey,
        revision: 1,
        updatedAt: Date.now(),
        markdown:
          "Reviewing the synthetic workspace.\n\n" + "- A detailed finding to verify.\n".repeat(18),
        steps: [
          { step: "Inspect the workspace", status: "completed" },
          { step: "Verify direct manipulation", status: "in_progress" },
          { step: "Summarize the result", status: "pending" },
        ],
      };
      const gateway = await installMockGateway(page, {
        sessionKey,
        featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
        historyMessages: Array.from({ length: 30 }, (_, i) => ({
          role: i % 2 ? "assistant" : "user",
          content: [{ type: "text", text: "Earlier context " + i + "." }],
          timestamp: i + 1,
        })),
        inFlightRun: { runId, text },
        sessionInfo: { key: sessionKey, activeRunIds: [runId], hasActiveRun: true },
        methodResponses: { "progressCard.get": { card: initialCard } },
      });
      const card = page.locator('[data-progress-card-placement="composer"]');
      const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
      let captureClip: { x: number; y: number; width: number; height: number } | undefined;
      const shot = async (name: string) => {
        if (!proofDir) {
          return;
        }
        // Capture a normal viewport during recording; crop only after the video closes.
        await writeFile(
          path.join(proofDir, name + ".viewport.png"),
          await page.screenshot({ fullPage: false }),
        );
      };
      try {
        await page.goto(suite.server.baseUrl + "chat");
        if (mobile) {
          await card.locator("summary").click();
        }
        await card.locator(".session-progress-card__body").waitFor();
        await waitForChatScrollIdle(page);
        const full = await height(card);
        const bounds = expectDefined(await card.boundingBox(), "full progress card");
        const cropY = Math.max(0, bounds.y - 150);
        captureClip = {
          x: bounds.x,
          y: cropY,
          width: bounds.width,
          height: bounds.y + bounds.height - cropY,
        };
        if (proofDir) {
          await writeFile(
            path.join(proofDir, "capture.json"),
            JSON.stringify({ viewport, clip: captureClip }),
          );
        }
        await shot("01-expanded");
        await thread.hover();
        await page.mouse.wheel(0, -320);
        await waitForChatScrollIdle(page);
        await page.waitForTimeout(201);
        await page.mouse.wheel(0, -320);
        if (mobile) {
          // Explicitly close the manually opened mobile card before scrubbing it.
          await card.locator("summary").click();
        }
        await expect.poll(() => card.getAttribute("open")).toBeNull();
        await waitForChatScrollIdle(page);
        const closed = await height(card);
        await shot("02-collapsed");
        const readerTop = await thread.evaluate((el) => el.scrollTop);
        await wheel(page, card, -48);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            }),
        );
        await shot("03-input-attempt");
        await expect.poll(() => height(card)).toBeCloseTo(closed + 48, 0);
        await still(card, closed + 48);
        await shot("03-paused-partial");
        await wheel(page, card, -24);
        await expect.poll(() => height(card)).toBeCloseTo(closed + 72, 0);
        await wheel(page, card, 24);
        await expect.poll(() => height(card)).toBeCloseTo(closed + 48, 0);
        await still(card, closed + 48);
        for (let line = 1; line <= 6; line++) {
          text += "\n\nStreaming finding " + line + ".";
          await gateway.emitGatewayEvent("chat", {
            sessionKey,
            runId,
            state: "delta",
            message: { role: "assistant", content: [{ type: "text", text }] },
          });
        }
        await gateway.setMethodResponse("progressCard.get", {
          card: {
            ...initialCard,
            revision: 2,
            markdown: initialCard.markdown + "\nMore findings arrived.",
          },
        });
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
        await expect.poll(() => card.textContent()).toContain("More findings arrived.");
        await still(card, closed + 48);
        expect(
          Math.abs((await thread.evaluate((el) => el.scrollTop)) - readerTop),
        ).toBeLessThanOrEqual(2);
        await shot("04-stream-preserves-partial");
        const point = await headerPoint(card);
        if (mobile) {
          const touch = await context.newCDPSession(page);
          try {
            await touch.send("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: [point],
            });
            for (let step = 1; step <= 6; step++) {
              await touch.send("Input.dispatchTouchEvent", {
                type: "touchMove",
                touchPoints: [{ x: point.x, y: point.y - step * 6 }],
              });
            }
            await expect.poll(() => height(card)).toBeCloseTo(closed + 84, 0);
            await still(card, closed + 84);
            await touch.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x: point.x, y: point.y - 16 }],
            });
            await expect.poll(() => height(card)).toBeCloseTo(closed + 64, 0);
            await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            await still(card, closed + 64);
            const next = await headerPoint(card);
            await touch.send("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: [next],
            });
            await touch.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x: next.x, y: next.y - 12 }],
            });
            await expect.poll(() => height(card)).toBeCloseTo(closed + 76, 0);
            await touch.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
            await still(card, closed + 76);
            await wheel(page, card, 12);
          } finally {
            await touch.detach();
          }
        } else {
          await page.mouse.move(point.x, point.y);
          await page.mouse.down();
          await page.mouse.move(point.x, point.y - 36, { steps: 12 });
          await expect.poll(() => height(card)).toBeCloseTo(closed + 84, 0);
          await still(card, closed + 84);
          await page.mouse.move(point.x, point.y - 16, { steps: 4 });
          await expect.poll(() => height(card)).toBeCloseTo(closed + 64, 0);
          await page.mouse.up();
          await still(card, closed + 64);
        }
        await shot("05-drag-release-holds");
        await wheel(page, card, -200);
        await expect.poll(() => height(card)).toBeCloseTo(closed + 264, 0);
        await wheel(page, card, 200);
        await expect.poll(() => height(card)).toBeCloseTo(closed + 64, 0);
        await page.locator('.chat-scroll-to-bottom[data-visible="true"]').click();
        await waitForChatScrollIdle(page);
        await still(card, closed + 64);
        await gateway.emitChatFinal({ sessionKey, runId, text: text + "\n\nComplete." });
        await still(card, closed + 64);
        await card.locator("summary").focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => height(card)).toBeCloseTo(full, 0);
        const body = card.locator(".session-progress-card__body");
        await body.hover();
        await page.mouse.wheel(0, 90);
        await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        await still(card, full);
        await card.locator("summary").focus();
        await page.keyboard.press("Space");
        await expect.poll(() => card.getAttribute("open")).toBeNull();
        await still(card, closed);
        // A full opening reached by a gesture must close on the first activation.
        for (const activation of ["click", "Enter", "Space"] as const) {
          await wheel(page, card, -1000);
          await expect.poll(() => height(card)).toBeCloseTo(full, 0);
          if (activation === "click") {
            await card.locator("summary").click();
          } else {
            await card.locator("summary").focus();
            await page.keyboard.press(activation);
          }
          await expect.poll(() => card.getAttribute("open")).toBeNull();
        }
      } finally {
        await page.close();
        if (proofDir && video) {
          await video.saveAs(path.join(proofDir, "gesture-cycle.webm"));
        }
        await suite.closeBrowserContext(context);
      }
    },
  );
});
