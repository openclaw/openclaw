import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
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

suite.define(() => {
  it.each(["no-preference", "reduce"] as const)(
    "pauses and seeks task progress smoothly, then reverses without a jump (%s)",
    async (reducedMotion) => {
      const proofDir = captureUiProofEnabled
        ? path.join(suite.artifactDir, "session-progress-motion", reducedMotion)
        : null;
      if (proofDir) {
        await mkdir(proofDir, { recursive: true });
      }
      const context = await suite.newBrowserContext({
        ...createControlUiE2eContextOptions(),
        reducedMotion,
        ...(proofDir ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 900 } } } : {}),
      });
      const page = await context.newPage();
      const video = page.video();
      const sessionKey = "agent:main:main";
      await installMockGateway(page, {
        sessionKey,
        featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
        historyMessages: Array.from({ length: 40 }, (_, index) => ({
          role: index % 2 ? "assistant" : "user",
          content: [{ type: "text", text: `History ${index}\n${"Reading context.\n".repeat(3)}` }],
          timestamp: index + 1,
        })),
        methodResponses: {
          "progressCard.get": {
            card: {
              sessionKey,
              revision: 1,
              updatedAt: Date.now(),
              markdown: "Checking the task progress interaction.",
              steps: [
                { step: "Inspect the current behavior", status: "completed" },
                { step: "Make the closing motion gentle", status: "in_progress" },
                { step: "Verify the reading position stays put", status: "pending" },
              ],
            },
          },
        },
      });
      const card = page.locator('[data-progress-card-placement="composer"]');
      const cardHeight = () => card.evaluate((element) => element.getBoundingClientRect().height);
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await card.locator(".session-progress-card__body").waitFor();
        await waitForChatScrollIdle(page);
        if (proofDir) {
          await writeFile(
            path.join(proofDir, "crop.json"),
            JSON.stringify(await card.boundingBox()),
          );
          await page.waitForTimeout(400); // Recording-only pacing, not an assertion wait.
        }
        await page.locator(".chat-thread").hover();
        await page.mouse.wheel(0, -320);
        await waitForChatScrollIdle(page);
        await page.waitForTimeout(201); // Separate two user gestures at the 200 ms boundary.
        await page.mouse.wheel(0, -320);
        await expect.poll(() => card.getAttribute("open")).toBeNull();
        await waitForChatScrollIdle(page);
        const closed = await cardHeight();
        if (proofDir) {
          await page.waitForTimeout(400);
        }
        await page.locator('.chat-scroll-to-bottom[data-visible="true"]').click();
        await waitForChatScrollIdle(page);
        expect(await card.getAttribute("open")).toBeNull();
        await card.locator("summary").click();
        await expect.poll(() => card.getAttribute("open")).toBe("");
        await waitForChatScrollIdle(page);
        const before = await cardHeight();
        expect(before - closed).toBeGreaterThan(50);
        if (proofDir) {
          await page.waitForTimeout(400);
        }

        // Resolve the native details slot once: its animations are outside the
        // card's getAnimations(), and inspector animation IDs are weak references.
        const inspector = await context.newCDPSession(page);
        const { root } = await inspector.send("DOM.getDocument");
        const { nodeId } = await inspector.send("DOM.querySelector", {
          nodeId: root.nodeId,
          selector: '[data-progress-card-placement="composer"] .session-progress-card__body',
        });
        const { node } = await inspector.send("DOM.describeNode", { nodeId });
        const { object } = await inspector.send("DOM.resolveNode", {
          backendNodeId: expectDefined(node.assignedSlot, "native details content slot")
            .backendNodeId,
        });
        const objectId = expectDefined(object.objectId, "native details content handle");
        const evaluateContent = async (
          evaluate: (this: Element, time: number) => unknown,
          time = 0,
        ): Promise<unknown> => {
          const { result, exceptionDetails } = await inspector.send("Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: evaluate.toString(),
            arguments: [{ value: time }],
            returnByValue: true,
          });
          expect(exceptionDetails).toBeUndefined();
          return result.value;
        };
        const contentIsRunning = () =>
          evaluateContent(function () {
            return this.getAnimations().some(
              (animation) =>
                animation instanceof CSSTransition &&
                animation.transitionProperty === "height" &&
                animation.playState === "running",
            );
          });
        const seekContent = (time: number) =>
          evaluateContent(function (currentTime) {
            for (const animation of this.getAnimations()) {
              animation.pause();
              animation.currentTime = currentTime;
            }
          }, time);
        await inspector.send("Animation.enable");
        await inspector.send("Animation.setPlaybackRate", { playbackRate: 0 });
        await card.locator("summary").click();
        await expect.poll(() => card.getAttribute("open")).toBeNull();
        if (reducedMotion === "no-preference") {
          await expect.poll(contentIsRunning).toBe(true);
        }
        const duration = await evaluateContent(function () {
          return (
            this.getAnimations()
              .find(
                (animation) =>
                  animation instanceof CSSTransition && animation.transitionProperty === "height",
              )
              ?.effect?.getTiming().duration ?? 0
          );
        });
        if (typeof duration !== "number") {
          throw new Error("Expected a numeric disclosure animation duration");
        }
        const samples: Array<{ height: number; opacity: number }> = [];
        const sample = () =>
          card.evaluate((element) => ({
            height: element.getBoundingClientRect().height,
            opacity: Number(getComputedStyle(element, "::details-content").opacity),
          }));
        if (duration) {
          for (const fraction of [0, 0.25, 0.5, 0.75]) {
            await seekContent(duration * fraction);
            samples.push(await sample());
          }
          // Completed sibling transitions must not be retained by the test driver.
          await inspector.send("HeapProfiler.collectGarbage");
          await seekContent(duration * 0.25);
        } else {
          samples.push(await sample());
        }
        if (proofDir) {
          await writeFile(
            path.join(proofDir, "motion.json"),
            JSON.stringify({ before, closed, duration, samples }, null, 2),
          );
          await card.screenshot({
            path: path.join(proofDir, "quarter-close.png"),
            animations: "allow",
          });
        }
        if (reducedMotion === "reduce") {
          expect(duration).toBe(0);
          expect(await cardHeight()).toBe(closed);
        } else {
          expect(duration).toBeGreaterThanOrEqual(200);
          expect(duration).toBeLessThanOrEqual(300);
          expect((samples[1]!.height - closed) / (samples[0]!.height - closed)).toBeGreaterThan(
            0.6,
          );
          expect(samples[1]!.opacity).toBeGreaterThan(0.6);
          for (let index = 1; index < samples.length; index += 1) {
            expect(samples[index]!.height).toBeLessThanOrEqual(samples[index - 1]!.height);
          }
          const reversingFrom = await cardHeight();
          await card.locator("summary").click();
          await expect.poll(() => card.getAttribute("open")).toBe("");
          await expect.poll(contentIsRunning).toBe(true);
          expect(Math.abs((await cardHeight()) - reversingFrom)).toBeLessThanOrEqual(1);
          await inspector.send("HeapProfiler.collectGarbage");
          await inspector.send("Animation.setPlaybackRate", { playbackRate: 1 });
          await expect.poll(cardHeight).toBe(before);
        }
      } finally {
        await page.close();
        if (proofDir && video) {
          await video.saveAs(path.join(proofDir, "closing-cycle.webm"));
        }
        await suite.closeBrowserContext(context);
      }
    },
  );
});
