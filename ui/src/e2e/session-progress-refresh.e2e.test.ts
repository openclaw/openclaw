import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
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
      collapsed: false,
      reducedMotion: "no-preference" as const,
    },
    {
      name: "narrow-collapsed",
      width: 390,
      height: 844,
      collapsed: true,
      reducedMotion: "reduce" as const,
    },
  ])(
    "refreshes only the work card and preserves disclosure: $name",
    async ({ name, width, height, collapsed, reducedMotion }) => {
      await suite.withPage({ viewport: { width, height } }, async ({ page }) => {
        await page.emulateMedia({ reducedMotion });
        const scenario = refreshScenario();
        const gateway = await installMockGateway(page, scenario);
        await page.goto(`${suite.server.baseUrl}chat`);
        const card = page.locator(".session-progress-card--composer");
        await card.waitFor();
        await waitForChatScrollIdle(page);
        if (collapsed) {
          await card.locator("summary").click();
        }
        await expect
          .poll(() => card.evaluate((element) => (element as HTMLDetailsElement).open))
          .toBe(!collapsed);
        await card.getByRole("button", { name: "Refresh task progress", exact: true }).waitFor();
        const button = card.locator(".session-progress-card__refresh");
        await button.locator("svg path").first().waitFor({ state: "attached" });
        const idleIcon = await button.locator("svg").innerHTML();
        const iconBounds = await button.locator("svg").boundingBox();
        expect(iconBounds?.width).toBeGreaterThan(0);
        const bounds = await button.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        await page.locator(".agent-chat__composer-combobox textarea").fill("Keep this draft.");
        const initial = await transcriptSnapshot(page);
        const originalCard = await card.elementHandle();
        const timestamp = await card.locator("time").getAttribute("datetime");
        const summaryHeight = await card
          .locator("summary")
          .evaluate((element) => element.getBoundingClientRect().height);
        const markdown = await card.locator(".session-progress-card__markdown").textContent();
        await page.mouse.move(0, 0);
        await captureUiProof(suite, page, name, "after-idle.png");
        await button.click();
        const request = await gateway.waitForRequest("progressCard.refresh");
        expect(request.params).toEqual({
          sessionKey: scenario.sessionKey,
          idempotencyKey: expect.any(String),
        });
        await expect.poll(() => button.getAttribute("data-state")).toBe("pending");
        expect(await button.isDisabled()).toBe(true);
        expect(await button.getAttribute("aria-busy")).toBe("true");
        const pendingIcon = button.locator("svg");
        await page.mouse.move(0, 0);
        await captureUiProof(suite, page, name, "after-pending.png");
        if (reducedMotion === "reduce") {
          expect(
            await pendingIcon.evaluate((element) => getComputedStyle(element).animationName),
          ).toBe("none");
          expect(await pendingIcon.innerHTML()).not.toBe(idleIcon);
          expect(await pendingIcon.isVisible()).toBe(true);
        } else {
          expect(
            await pendingIcon.evaluate((element) => getComputedStyle(element).animationName),
          ).toBe("session-progress-refresh-spin");
        }
        expect(
          await card
            .locator("summary")
            .evaluate((element) => element.getBoundingClientRect().height),
        ).toBe(summaryHeight);
        const pendingStatus = card.locator(".session-progress-card__refresh-status");
        expect(
          await pendingStatus.evaluate((element) => element.getBoundingClientRect().width),
        ).toBeLessThanOrEqual(1);
        expect(await transcriptSnapshot(page)).toEqual(initial);
        expect(await card.locator("time").getAttribute("datetime")).toBe(timestamp);
        expect(await card.locator(".session-progress-card__markdown").textContent()).toBe(markdown);
        await gateway.resolveDeferred("progressCard.refresh", {
          runId: "hidden-refresh-run",
          status: "accepted",
          revision: 1,
        });
        // Acceptance and a same-revision authoritative read are not completion.
        const reads = (await gateway.getRequests("progressCard.get")).length;
        await gateway.emitGatewayEvent("progressCard.changed", {
          sessionKey: scenario.sessionKey,
          revision: 1,
        });
        await gateway.waitForRequest("progressCard.get", { after: reads });
        expect(await button.getAttribute("data-state")).toBe("pending");
        expect(await card.locator("time").getAttribute("datetime")).toBe(timestamp);
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
        await expect.poll(() => button.getAttribute("data-state")).toBe("updated");
        expect(await button.isDisabled()).toBe(false);
        expect(await card.locator("time").getAttribute("datetime")).toBe(
          new Date(nextCard.updatedAt).toISOString(),
        );
        expect(await card.locator(".session-progress-card__markdown").textContent()).toContain(
          nextCard.markdown,
        );
        expect(await card.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(
          !collapsed,
        );
        expect(await originalCard!.evaluate((element) => element.isConnected)).toBe(true);
        expect(await transcriptSnapshot(page)).toEqual(initial);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
        expect(await gateway.getRequests("progressCard.refresh")).toHaveLength(1);
        await page.mouse.move(0, 0);
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
      const card = page.locator(".session-progress-card--composer");
      await card.waitFor();
      await waitForChatScrollIdle(page);
      const initial = await transcriptSnapshot(page);
      const timestamp = await card.locator("time").getAttribute("datetime");
      const button = card.locator(".session-progress-card__refresh");
      await button.click();
      const request = await gateway.waitForRequest("progressCard.refresh");
      await gateway.rejectDeferred("progressCard.refresh", {
        code: "UNAVAILABLE",
        message: "The synthetic worker is unavailable.",
      });
      await card.getByRole("button", { name: "Retry progress refresh" }).waitFor();
      expect(await button.isEnabled()).toBe(true);
      const failureStatus = card.locator(".session-progress-card__refresh-status");
      expect(await failureStatus.textContent()).toBe("Could not refresh. Previous update kept.");
      expect(
        await failureStatus.evaluate((element) => element.getBoundingClientRect().height),
      ).toBeGreaterThan(1);
      expect(await failureStatus.isVisible()).toBe(true);
      expect(await card.locator("time").getAttribute("datetime")).toBe(timestamp);
      expect(await transcriptSnapshot(page)).toEqual(initial);
      await page.mouse.move(0, 0);
      await captureUiProof(suite, page, "desktop-error", "after-error.png");
      // Releasing a held method also ends its hold; reserve the next retry explicitly.
      await gateway.deferNext("progressCard.refresh");
      await button.click();
      const retry = await gateway.waitForRequest("progressCard.refresh", { after: 1 });
      expect(retry.params).toEqual(request.params);
      await gateway.resolveDeferred("progressCard.refresh", {
        runId: "retry-run",
        status: "accepted",
        revision: 1,
      });
      await expect.poll(() => button.getAttribute("data-state")).toBe("pending");
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
      await expect.poll(() => button.getAttribute("data-state")).toBe("updated");
      expect(await transcriptSnapshot(page)).toEqual(initial);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("progressCard.refresh")).toHaveLength(2);
    });
  });
});
