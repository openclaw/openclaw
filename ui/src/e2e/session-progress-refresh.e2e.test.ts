import type { Page } from "playwright";
import { expect, it } from "vitest";
import { openChatTaskProgress } from "./chat-details.test-support.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { progressSubmitScenario } from "./session-progress-submit.test-support.ts";

const suite = createChatFlowE2eSuite();

async function openProgress(page: Page) {
  const scenario = progressSubmitScenario();
  const sessionInfo = {
    ...scenario.sessionInfo,
    startedAt: Date.now() - 20 * 60_000,
    endedAt: Date.now() - 9 * 60_000,
  };
  const saved = {
    ...scenario.methodResponses["progressCard.get"].card,
    updatedAt: Date.now() - 10 * 60_000,
  };
  const gateway = await installMockGateway(page, {
    ...scenario,
    historyMessages: ["user", "assistant"].map((role) => ({ role, content: "Review." })),
    sessionInfo,
    sessions: [{ ...sessionInfo, kind: "direct", label: "Main", updatedAt: sessionInfo.endedAt }],
    featureMethods: [...scenario.featureMethods, "progressCard.refresh"],
    deferredMethods: [],
    heldMethods: ["progressCard.refresh"],
    methodResponses: { ...scenario.methodResponses, "progressCard.get": { card: saved } },
  });
  await page.goto(suite.server.baseUrl + "chat");
  await page.locator(".agent-chat__composer-combobox textarea").fill("Keep this draft.");
  const card = await openChatTaskProgress(page);
  await waitForChatScrollIdle(page);
  const snapshot = () =>
    Promise.all([
      page.locator(".chat-bubble").allTextContents(),
      page.locator(".chat-queue__item").count(),
      page.locator(".agent-chat__composer-combobox textarea").inputValue(),
    ]);
  const initial = await snapshot();
  const button = card.locator(".task-progress-details__refresh");
  const status = card.locator(".task-progress-details__refresh-status");
  const markdown = card.locator(".session-progress-card__markdown");
  const finish = async () => {
    const next = {
      ...saved,
      revision: 2,
      updatedAt: Date.now(),
      markdown: "The workspace checks passed. Preparing the review summary.",
    };
    await gateway.setMethodResponse("progressCard.get", { card: next });
    await gateway.emitGatewayEvent("progressCard.changed", {
      sessionKey: scenario.sessionKey,
      revision: 2,
    });
    await expect.poll(() => status.getAttribute("data-state")).toBe("updated");
    expect(await markdown.textContent()).toContain(next.markdown);
    expect(await button.isEnabled()).toBe(true);
    expect(await snapshot()).toEqual(initial);
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
  };
  return { gateway, card, button, status, markdown, snapshot, initial, scenario, finish };
}

suite.define(() => {
  it.each([false, true])(
    "refreshes only the work card without remounting it (mobile=%s)",
    async (mobile) => {
      const width = mobile ? 390 : 1280;
      await suite.withPage(
        { viewport: { width, height: mobile ? 844 : 900 } },
        async ({ page }) => {
          await page.emulateMedia({ reducedMotion: mobile ? "reduce" : "no-preference" });
          const f = await openProgress(page);
          const original = await f.card.elementHandle();
          const initialMarkdown = await f.markdown.textContent();
          const icon = f.button.locator("svg");
          const idleIcon = await icon.innerHTML();
          const bounds = await f.button.boundingBox();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
          expect(bounds!.width).toBeGreaterThan(0);
          await f.button.click();
          const request = await f.gateway.waitForRequest("progressCard.refresh");
          expect(request.params).toEqual({
            sessionKey: f.scenario.sessionKey,
            idempotencyKey: expect.any(String),
          });
          await expect.poll(() => f.status.getAttribute("data-state")).toBe("pending");
          expect(await f.button.isDisabled()).toBe(true);
          expect(await f.button.getAttribute("aria-busy")).toBe("true");
          expect(await icon.innerHTML()).not.toBe(idleIcon);
          expect(await icon.isVisible()).toBe(true);
          if (mobile) {
            expect(await icon.evaluate((element) => getComputedStyle(element).animationName)).toBe(
              "none",
            );
          } else {
            expect(await icon.evaluate((element) => element.getAnimations()[0]?.playState)).toBe(
              "running",
            );
            expect(await f.card.getAttribute("open")).toBe("");
          }
          expect(
            await f.status.evaluate((element) => element.getBoundingClientRect().width),
          ).toBeLessThanOrEqual(1);
          expect(await f.snapshot()).toEqual(f.initial);
          expect(await f.markdown.textContent()).toBe(initialMarkdown);
          await f.gateway.resolveDeferred("progressCard.refresh", {
            runId: "hidden-refresh-run",
            status: "accepted",
            revision: 1,
          });
          const reads = (await f.gateway.getRequests("progressCard.get")).length;
          await f.gateway.emitGatewayEvent("progressCard.changed", {
            sessionKey: f.scenario.sessionKey,
            revision: null,
          });
          await f.gateway.waitForRequest("progressCard.get", { after: reads });
          expect(await f.status.getAttribute("data-state")).toBe("pending");
          await f.finish();
          expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
          expect(await f.card.isVisible()).toBe(true);
          if (!mobile) {
            expect(await f.card.getAttribute("open")).toBe("");
          }
          expect(await f.gateway.getRequests("progressCard.refresh")).toHaveLength(1);
          await original!.dispose();
        },
      );
    },
  );

  it("keeps the old card on failure and retries the same hidden intent", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const f = await openProgress(page);
      const initialMarkdown = await f.markdown.textContent();
      await f.button.click();
      const request = await f.gateway.waitForRequest("progressCard.refresh");
      await f.gateway.rejectDeferred("progressCard.refresh", {
        code: "UNAVAILABLE",
        message: "The synthetic worker is unavailable.",
      });
      await expect.poll(() => f.status.getAttribute("data-state")).toBe("failed");
      expect(await f.button.isEnabled()).toBe(true);
      expect(await f.status.textContent()).toContain("Could not refresh. Previous update kept.");
      expect(await f.status.isVisible()).toBe(true);
      expect(
        await f.status.evaluate((element) => element.getBoundingClientRect().height),
      ).toBeGreaterThan(1);
      expect(await f.markdown.textContent()).toBe(initialMarkdown);
      expect(await f.snapshot()).toEqual(f.initial);
      await f.gateway.deferNext("progressCard.refresh");
      await f.status.getByRole("button", { name: "Retry", exact: true }).click();
      expect((await f.gateway.waitForRequest("progressCard.refresh", { after: 1 })).params).toEqual(
        request.params,
      );
      await f.gateway.resolveDeferred("progressCard.refresh", {
        runId: "retry-run",
        status: "accepted",
        revision: 1,
      });
      await f.finish();
      expect(await f.gateway.getRequests("progressCard.refresh")).toHaveLength(2);
    });
  });
});
