import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { openChatTaskProgress } from "./chat-details.test-support.ts";
import {
  captureUiProof,
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { progressSubmitScenario } from "./session-progress-submit.test-support.ts";

const suite = createChatFlowE2eSuite();

function refreshScenario() {
  const scenario = progressSubmitScenario();
  const sessionInfo = {
    ...scenario.sessionInfo,
    startedAt: Date.now() - 20 * 60_000,
    endedAt: Date.now() - 9 * 60_000,
  };
  return {
    ...scenario,
    assistantName: "Demo assistant",
    sessionInfo,
    // The roster and selected detail must retain the same terminal snapshot.
    sessions: [
      { ...sessionInfo, kind: "direct" as const, label: "Main", updatedAt: sessionInfo.endedAt },
    ],
    historyMessages: [
      {
        role: "user",
        content: [{ type: "text", text: "Review the workspace and keep the work card current." }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "The workspace review is ready. The work card tracks the remaining checks.",
          },
        ],
        timestamp: 2,
      },
    ],
    featureMethods: [...scenario.featureMethods, "progressCard.refresh"],
    deferredMethods: [],
    heldMethods: ["progressCard.refresh"],
    methodResponses: {
      ...scenario.methodResponses,
      "progressCard.get": {
        card: {
          ...scenario.methodResponses["progressCard.get"].card,
          updatedAt: Date.now() - 10 * 60_000,
        },
      },
    },
  };
}

async function transcriptSnapshot(page: Page) {
  return {
    messages: await page.locator(".chat-bubble").allTextContents(),
    queueRows: await page.locator(".chat-queue__item").count(),
    draft: await page.locator(".agent-chat__composer-combobox textarea").inputValue(),
  };
}

suite.define(() => {
  it.each([
    {
      name: "desktop-expanded",
      width: 1280,
      height: 900,
      mobile: false,
      reducedMotion: "no-preference" as const,
    },
    {
      name: "mobile-page",
      width: 390,
      height: 844,
      mobile: true,
      reducedMotion: "reduce" as const,
    },
  ])(
    "refreshes only the work card and preserves its presentation: $name",
    async ({ name, width, height, mobile, reducedMotion }) => {
      await suite.withPage({ viewport: { width, height } }, async ({ page }) => {
        await page.emulateMedia({ reducedMotion });
        const scenario = refreshScenario();
        const gateway = await installMockGateway(page, scenario);
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.locator(".agent-chat__composer-combobox textarea").fill("Keep this draft.");
        const card = await openChatTaskProgress(page);
        await waitForChatScrollIdle(page);
        const button = card.locator(".task-progress-details__refresh");
        const status = card.locator(".task-progress-details__refresh-status");
        const initial = await transcriptSnapshot(page);
        const originalCard = await card.elementHandle();
        const initialMarkdown = await card
          .locator(".session-progress-card__markdown")
          .textContent();
        const idleIcon = await button.locator("svg").innerHTML();
        const bounds = await button.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        expect(bounds!.width).toBeGreaterThan(0);
        if (!mobile) {
          expect(await card.getAttribute("open")).toBe("");
        }
        const readTimestamp = async () => {
          const options = card.getByRole("button", { name: "Task progress options", exact: true });
          await options.click();
          const time = card.locator(".session-progress-card__refresh time");
          await time.waitFor();
          const timestamp = await time.getAttribute("datetime");
          await page.keyboard.press("Escape");
          return timestamp;
        };
        const timestamp = mobile ? undefined : await readTimestamp();
        if (!mobile) {
          expect(timestamp).toBe(
            new Date(scenario.methodResponses["progressCard.get"].card.updatedAt).toISOString(),
          );
        }
        await captureUiProof(suite, page, name, "after-idle.png");
        await button.click();
        const request = await gateway.waitForRequest("progressCard.refresh");
        expect(request.params).toEqual({
          sessionKey: scenario.sessionKey,
          idempotencyKey: expect.any(String),
        });
        await expect.poll(() => status.getAttribute("data-state")).toBe("pending");
        expect(await button.isDisabled()).toBe(true);
        expect(await button.getAttribute("aria-busy")).toBe("true");
        expect(await button.locator("svg").innerHTML()).not.toBe(idleIcon);
        expect(await button.locator("svg").isVisible()).toBe(true);
        if (reducedMotion === "reduce") {
          expect(
            await button
              .locator("svg")
              .evaluate((element) => getComputedStyle(element).animationName),
          ).toBe("none");
        } else {
          expect(
            await button
              .locator("svg")
              .evaluate((element) => element.getAnimations()[0]?.playState),
          ).toBe("running");
        }
        expect(
          await status.evaluate((element) => element.getBoundingClientRect().width),
        ).toBeLessThanOrEqual(1);
        expect(await transcriptSnapshot(page)).toEqual(initial);
        expect(await card.locator(".session-progress-card__markdown").textContent()).toBe(
          initialMarkdown,
        );
        await captureUiProof(suite, page, name, "after-pending.png");
        await gateway.resolveDeferred("progressCard.refresh", {
          runId: "hidden-refresh-run",
          status: "accepted",
          revision: 1,
        });
        const reads = (await gateway.getRequests("progressCard.get")).length;
        await gateway.emitGatewayEvent("progressCard.changed", {
          sessionKey: scenario.sessionKey,
          revision: null,
        });
        await gateway.waitForRequest("progressCard.get", { after: reads });
        expect(await status.getAttribute("data-state")).toBe("pending");
        if (!mobile) {
          expect(await readTimestamp()).toBe(timestamp);
        }
        const nextCard = {
          ...scenario.methodResponses["progressCard.get"].card,
          revision: 2,
          updatedAt: Date.now(),
          markdown: "The workspace checks passed. Preparing the review summary.",
          steps: [
            { step: "Inspect the workspace", status: "completed" },
            { step: "Verify the progress card", status: "completed" },
            { step: "Summarize the result", status: "in_progress" },
          ],
        };
        await gateway.setMethodResponse("progressCard.get", { card: nextCard });
        await gateway.emitGatewayEvent("progressCard.changed", {
          sessionKey: scenario.sessionKey,
          revision: 2,
        });
        await expect.poll(() => status.getAttribute("data-state")).toBe("updated");
        expect(await button.isEnabled()).toBe(true);
        if (!mobile) {
          expect(await readTimestamp()).toBe(new Date(nextCard.updatedAt).toISOString());
          expect(await card.getAttribute("open")).toBe("");
        }
        expect(await card.locator(".session-progress-card__markdown").textContent()).toContain(
          nextCard.markdown,
        );
        expect(await originalCard!.evaluate((element) => element.isConnected)).toBe(true);
        expect(await card.isVisible()).toBe(true);
        expect(await transcriptSnapshot(page)).toEqual(initial);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
        expect(await gateway.getRequests("progressCard.refresh")).toHaveLength(1);
        await captureUiProof(suite, page, name, "after-updated.png");
        await writeFile(
          path.join(suite.artifactDir, name + "-requests.json"),
          JSON.stringify(await gateway.getRequests(), null, 2),
        );
        await originalCard!.dispose();
      });
    },
  );

  it("keeps the old card on failure and retries the same hidden intent", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const scenario = refreshScenario();
      const gateway = await installMockGateway(page, scenario);
      await page.goto(`${suite.server.baseUrl}chat`);
      const card = await openChatTaskProgress(page);
      await waitForChatScrollIdle(page);
      const initial = await transcriptSnapshot(page);
      const initialMarkdown = await card.locator(".session-progress-card__markdown").textContent();
      const button = card.locator(".task-progress-details__refresh");
      const status = card.locator(".task-progress-details__refresh-status");
      await button.click();
      const request = await gateway.waitForRequest("progressCard.refresh");
      await gateway.rejectDeferred("progressCard.refresh", {
        code: "UNAVAILABLE",
        message: "The synthetic worker is unavailable.",
      });
      await expect.poll(() => status.getAttribute("data-state")).toBe("failed");
      expect(await button.isEnabled()).toBe(true);
      expect(await status.textContent()).toContain("Could not refresh. Previous update kept.");
      expect(await status.isVisible()).toBe(true);
      expect(
        await status.evaluate((element) => element.getBoundingClientRect().height),
      ).toBeGreaterThan(1);
      expect(await card.locator(".session-progress-card__markdown").textContent()).toBe(
        initialMarkdown,
      );
      expect(await transcriptSnapshot(page)).toEqual(initial);
      await captureUiProof(suite, page, "desktop-error", "after-error.png");
      await gateway.deferNext("progressCard.refresh");
      await status.getByRole("button", { name: "Retry", exact: true }).click();
      const retry = await gateway.waitForRequest("progressCard.refresh", { after: 1 });
      expect(retry.params).toEqual(request.params);
      await gateway.resolveDeferred("progressCard.refresh", {
        runId: "retry-run",
        status: "accepted",
        revision: 1,
      });
      await expect.poll(() => status.getAttribute("data-state")).toBe("pending");
      await gateway.setMethodResponse("progressCard.get", {
        card: {
          ...scenario.methodResponses["progressCard.get"].card,
          revision: 2,
          updatedAt: Date.now(),
        },
      });
      await gateway.emitGatewayEvent("progressCard.changed", {
        sessionKey: scenario.sessionKey,
        revision: 2,
      });
      await expect.poll(() => status.getAttribute("data-state")).toBe("updated");
      expect(await transcriptSnapshot(page)).toEqual(initial);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("progressCard.refresh")).toHaveLength(2);
    });
  });
});
