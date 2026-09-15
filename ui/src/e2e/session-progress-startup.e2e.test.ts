import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each(["card", "empty", "error"] as const)(
    "mounts the composer in its final geometry after an initial %s response",
    async (outcome) => {
      const context = await suite.newBrowserContext({
        viewport: { width: 1440, height: 900 },
        reducedMotion: "no-preference",
      });
      const page = await context.newPage();
      const sessionKey = "agent:main:main";
      const card = {
        sessionKey,
        revision: 1,
        updatedAt: Date.now(),
        steps: [
          { step: "Inspect the conversation", status: "in_progress" },
          { step: "Verify the result", status: "pending" },
        ],
      };
      const gateway = await installMockGateway(page, {
        sessionInfo: {
          key: sessionKey,
          kind: "direct",
          updatedAt: 1,
          hasActiveRun: true,
          activeRunIds: ["startup-progress-run"],
        },
        inFlightRun: { runId: "startup-progress-run", text: "", events: [] },
        historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
        deferredMethods: ["progressCard.get"],
        methodResponses: { "progressCard.get": { card } },
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("progressCard.get");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        expect(await composer.count()).toBe(0);
        await page.locator(".lazy-view-state--loading").first().waitFor();

        const geometry = page.evaluate(async () => {
          const frames: Array<{ top: number; height: number; card: boolean }> = [];
          const shifts: number[] = [];
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              const shift = entry as PerformanceEntry & {
                value: number;
                sources: Array<{ node?: Node }>;
              };
              const composerElement = document.querySelector(".agent-chat__composer-shell");
              if (
                composerElement &&
                shift.sources.some(
                  ({ node }) =>
                    node instanceof Element &&
                    (node.contains(composerElement) || composerElement.contains(node)),
                )
              ) {
                shifts.push(shift.value);
              }
            }
          });
          observer.observe({ type: "layout-shift" });
          await new Promise<void>((resolve) => {
            const sample = () => {
              const shell = document.querySelector<HTMLElement>(".agent-chat__composer-shell");
              if (shell) {
                const bounds = shell.getBoundingClientRect();
                frames.push({
                  // The containing card's entrance transform does not change layout.
                  top: shell.offsetTop,
                  height: bounds.height,
                  card: shell.querySelector(".session-progress-card--composer") !== null,
                });
              }
              if (frames.length === 20) {
                resolve();
              } else {
                requestAnimationFrame(sample);
              }
            };
            requestAnimationFrame(sample);
          });
          observer.disconnect();
          return { frames, shifts };
        });
        if (outcome === "error") {
          await gateway.rejectDeferred("progressCard.get", {
            message: "Progress temporarily unavailable",
          });
        } else {
          await gateway.resolveDeferred("progressCard.get", {
            card: outcome === "card" ? card : null,
          });
        }
        await composer.waitFor();
        const { frames, shifts } = await geometry;
        expect(shifts).toEqual([]);
        expect(frames.every((frame) => frame.card === (outcome === "card"))).toBe(true);
        expect(
          Math.max(...frames.map((frame) => frame.height)) -
            Math.min(...frames.map((frame) => frame.height)),
        ).toBeLessThanOrEqual(1);
        expect(
          Math.max(...frames.map((frame) => frame.top)) -
            Math.min(...frames.map((frame) => frame.top)),
        ).toBeLessThanOrEqual(1);

        await composer.fill("Keep this draft while progress refreshes");
        await gateway.deferNext("progressCard.get");
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
        await expect
          .poll(async () => (await gateway.getRequests("progressCard.get")).length)
          .toBe(2);
        expect(await composer.inputValue()).toBe("Keep this draft while progress refreshes");
        await gateway.rejectDeferred("progressCard.get", {
          message: "Refresh temporarily unavailable",
        });
        expect(await composer.inputValue()).toBe("Keep this draft while progress refreshes");
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("shows a failed initial history without waiting for progress", async () => {
    const context = await suite.newBrowserContext({});
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [],
      deferredMethods: ["chat.startup", "progressCard.get"],
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await gateway.rejectDeferred("chat.startup", { message: "History temporarily unavailable" });
      const error = page.locator('.chat-history-error[role="alert"]');
      await error.waitFor();
      expect(await error.textContent()).toContain("History temporarily unavailable");
      await page
        .locator(".agent-chat__composer-combobox textarea")
        .fill("Preserve this recovery draft");
      expect(await error.getByRole("button", { name: "Retry" }).count()).toBe(1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
