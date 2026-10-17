import type { Page } from "playwright";
import { expect, it } from "vitest";
import { openChatDetails } from "./chat-details.test-support.ts";
import {
  chatMessage,
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { progressSubmitScenario } from "./session-progress-submit.test-support.ts";

const suite = createChatFlowE2eSuite();

function refreshScenario() {
  const scenario = progressSubmitScenario();
  scenario.methodResponses["progressCard.get"].card.updatedAt = Date.now() - 10 * 60_000;
  const sessionInfo = {
    ...scenario.sessionInfo,
    startedAt: Date.now() - 20 * 60_000,
    endedAt: Date.now() - 9 * 60_000,
  };
  return {
    ...scenario,
    sessionInfo,
    // The roster and selected detail must retain the same terminal snapshot.
    sessions: [
      { ...sessionInfo, kind: "direct" as const, label: "Main", updatedAt: sessionInfo.endedAt },
    ],
    historyMessages: ["user", "assistant"].map((role, i) =>
      chatMessage(role, "Review the workspace.", { timestamp: i + 1 }),
    ),
    featureMethods: [...scenario.featureMethods, "progressCard.refresh"],
    deferredMethods: [],
    heldMethods: ["progressCard.refresh"],
  };
}

async function transcriptSnapshot(page: Page) {
  return {
    messages: await page.locator(".chat-bubble").allTextContents(),
    queueRows: await page.locator(".chat-queue__item").count(),
    draft: await page.locator(".agent-chat__composer-combobox textarea").inputValue(),
  };
}

async function openRefreshCard(page: Page, draft?: string) {
  const scenario = refreshScenario();
  const { sessionKey } = scenario;
  const gateway = await installMockGateway(page, scenario);
  await page.goto(`${suite.server.baseUrl}chat`);
  const card = page.locator('[data-progress-card-placement="details"]');
  if (draft) {
    await page.locator(".agent-chat__composer-combobox textarea").fill(draft);
  }
  await openChatDetails(page);
  await card.waitFor();
  const baseline = scenario.methodResponses["progressCard.get"].card;
  const update = async (overrides: Partial<typeof baseline> = {}) => {
    const next = { ...baseline, revision: 2, updatedAt: Date.now(), ...overrides };
    await gateway.setMethodResponse("progressCard.get", { card: next });
    await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: next.revision });
    return next;
  };
  const accept = (runId: string) =>
    gateway.resolveDeferred("progressCard.refresh", { runId, status: "accepted", revision: 1 });
  return {
    sessionKey,
    gateway,
    card,
    update,
    accept,
    options: card.getByRole("button", { name: "Task progress options", exact: true }),
    button: card.locator(".session-progress-card__refresh[aria-busy]"),
    time: card.locator("time"),
  };
}

suite.define(() => {
  it.each([
    [1280, 900, false, "no-preference"],
    [390, 844, true, "reduce"],
  ] as const)(
    "refreshes only the work card and preserves disclosure: %s × %s",
    async (width, height, collapsed, reducedMotion) => {
      await suite.withPage({ viewport: { width, height } }, async ({ page }) => {
        await page.emulateMedia({ reducedMotion });
        const { sessionKey, gateway, card, options, button, time, update, accept } =
          await openRefreshCard(page, "Keep this draft.");
        if (collapsed) {
          await card.locator("summary").click();
        }
        await waitForChatScrollIdle(page);
        await expect
          .poll(() => card.evaluate((element) => (element as HTMLDetailsElement).open))
          .toBe(!collapsed);
        const summary = card.locator("summary");
        const cardMarkdown = card.locator(".session-progress-card__markdown");
        expect(await card.locator("summary button:visible").count()).toBe(1);
        await options.click();
        await card.getByRole("menuitem", { name: "Refresh task progress", exact: true }).waitFor();
        await button.locator("svg path").first().waitFor({ state: "attached" });
        const icon = button.locator("svg");
        const idleIcon = await icon.innerHTML();
        const iconBounds = await icon.boundingBox();
        expect(iconBounds?.width).toBeGreaterThan(0);
        const bounds = await button.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        const initial = await transcriptSnapshot(page);
        const originalCard = await card.elementHandle();
        const timestamp = await time.getAttribute("datetime");
        const summaryH = await summary.evaluate((el) => el.getBoundingClientRect().height);
        const markdown = await cardMarkdown.textContent();
        await page.keyboard.press("Escape");
        await page.mouse.move(0, 0);
        await options.click();
        await button.click();
        const request = await gateway.waitForRequest("progressCard.refresh");
        expect(request.params).toEqual({
          sessionKey,
          idempotencyKey: expect.any(String),
        });
        await expect.poll(() => options.getAttribute("data-state")).toBe("pending");
        await options.click();
        expect(await button.isDisabled()).toBe(true);
        expect(await button.getAttribute("aria-busy")).toBe("true");
        await page.mouse.move(0, 0);
        if (reducedMotion === "reduce") {
          expect(await icon.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
          expect(await icon.innerHTML()).not.toBe(idleIcon);
          expect(await icon.isVisible()).toBe(true);
        } else {
          expect(await icon.evaluate((el) => el.getAnimations()[0]?.playState)).toBe("running");
        }
        expect(await summary.evaluate((el) => el.getBoundingClientRect().height)).toBe(summaryH);
        await page.keyboard.press("Escape");
        const status = card.locator(".session-progress-card__refresh-status");
        const statusWidth = await status.evaluate((el) => el.getBoundingClientRect().width);
        expect(statusWidth).toBeLessThanOrEqual(1);
        expect(await transcriptSnapshot(page)).toEqual(initial);
        expect(await time.getAttribute("datetime")).toBe(timestamp);
        expect(await cardMarkdown.textContent()).toBe(markdown);
        await accept("hidden-refresh-run");
        // The authoritative baseline read must not complete the accepted refresh.
        const reads = (await gateway.getRequests("progressCard.get")).length;
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: null });
        await gateway.waitForRequest("progressCard.get", { after: reads });
        expect(await options.getAttribute("data-state")).toBe("pending");
        expect(await time.getAttribute("datetime")).toBe(timestamp);
        const nextCard = await update({
          markdown: "The workspace checks passed. Preparing the review summary.",
          steps: [
            { step: "Inspect the workspace", status: "completed" },
            { step: "Verify the progress card", status: "completed" },
            { step: "Summarize the result", status: "in_progress" },
          ],
        });
        await expect.poll(() => options.getAttribute("data-state")).toBe("updated");
        await options.click();
        expect(await button.isDisabled()).toBe(false);
        await page.keyboard.press("Escape");
        expect(await time.getAttribute("datetime")).toBe(
          new Date(nextCard.updatedAt).toISOString(),
        );
        expect(await cardMarkdown.textContent()).toContain(nextCard.markdown);
        expect(await card.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(!collapsed);
        expect(await originalCard!.evaluate((element) => element.isConnected)).toBe(true);
        expect(await page.locator(".chat-details:popover-open").isVisible()).toBe(true);
        expect(await transcriptSnapshot(page)).toEqual(initial);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
        expect(await gateway.getRequests("progressCard.refresh")).toHaveLength(1);
        await originalCard!.dispose();
      });
    },
  );

  it("keeps the old card on failure and retries the same hidden intent", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { gateway, card, options, button, time, update, accept } = await openRefreshCard(page);
      await waitForChatScrollIdle(page);
      const initial = await transcriptSnapshot(page);
      const timestamp = await time.getAttribute("datetime");
      await options.click();
      await button.click();
      const request = await gateway.waitForRequest("progressCard.refresh");
      await gateway.rejectDeferred("progressCard.refresh", {
        code: "UNAVAILABLE",
        message: "The synthetic worker is unavailable.",
      });
      await options.click();
      await card.getByRole("menuitem", { name: "Retry progress refresh" }).waitFor();
      expect(await button.isEnabled()).toBe(true);
      const status = card.locator(".session-progress-card__refresh-status");
      expect(await status.textContent()).toBe("Could not refresh. Previous update kept.");
      expect(await status.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(1);
      expect(await status.isVisible()).toBe(true);
      expect(await time.getAttribute("datetime")).toBe(timestamp);
      expect(await transcriptSnapshot(page)).toEqual(initial);
      await page.mouse.move(0, 0);
      // Releasing a held method also ends its hold; reserve the next retry explicitly.
      await gateway.deferNext("progressCard.refresh");
      await button.click();
      const retry = await gateway.waitForRequest("progressCard.refresh", { after: 1 });
      expect(retry.params).toEqual(request.params);
      await accept("retry-run");
      await expect.poll(() => options.getAttribute("data-state")).toBe("pending");
      await update();
      await expect.poll(() => options.getAttribute("data-state")).toBe("updated");
      expect(await transcriptSnapshot(page)).toEqual(initial);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("progressCard.refresh")).toHaveLength(2);
    });
  });
});
