import { expect, it } from "vitest";
import { pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
suite.define(() => {
  it("keeps model options stable and welcome recents current through typing and row updates", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        models: [
          { id: "gpt-5.5", name: "GPT 5.5", provider: "openai" },
          ...Array.from({ length: 2000 }, (_, index) => ({
            id: "model-" + index,
            name: "Model " + index,
            provider: "fixture",
            reasoning: true,
          })),
        ],
        sessions: Array.from({ length: 500 }, (_, index) => ({
          key: "agent:main:dashboard:typing-" + index,
          sessionId: "typing-" + index,
          kind: "direct",
          childOwnerSessionKeys: [],
          label: "Research session " + index,
          // Keep the changed row in the admitted shared page, not overflow
          // whose promotion correctly requires an authoritative membership read.
          updatedAt: 2000 - index,
        })),
      });
      await page.clock.install();
      await page.goto(suite.server.baseUrl + "new");
      const modelTrigger = page.locator("[data-chat-model-select]");
      await modelTrigger.click();
      await page.locator('[data-chat-model-option="fixture/model-1999"]').waitFor({
        state: "attached",
      });
      await modelTrigger.click();
      const input = page.locator(".new-session-page__message");
      await input.fill("Warmup ");
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      const sessionKey = "agent:main:dashboard:typing-0";
      const sidebarRow = page.locator(`aside.sidebar [data-session-key="${sessionKey}"]`).first();
      await expect.poll(() => sidebarRow.textContent()).toContain("Research session 0");
      await pauseVirtualClock(page);
      const observation = await page.evaluateHandle(() => {
        let catalogLabelReads = 0;
        const textarea = document.querySelector(".new-session-page__message");
        const modelOption = document.querySelector('[data-chat-model-option="fixture/model-1999"]');
        // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the original receiver.
        const original = String.prototype.toLocaleLowerCase;
        // Count preparation even when Solid suppresses identical DOM writes.
        // oxlint-disable-next-line no-extend-native -- Instrument only this disposable browser page; restore in finish.
        String.prototype.toLocaleLowerCase = function (
          this: string,
          ...args: Parameters<string["toLocaleLowerCase"]>
        ) {
          catalogLabelReads += /^Model \d+$/.test(this) ? 1 : 0;
          return Reflect.apply(original, this, args);
        };
        return () => {
          // oxlint-disable-next-line no-extend-native -- Restore the page-local instrumentation.
          String.prototype.toLocaleLowerCase = original;
          return {
            catalogLabelReads,
            sameTextarea: textarea === document.querySelector(".new-session-page__message"),
            sameModelOption:
              modelOption ===
              document.querySelector('[data-chat-model-option="fixture/model-1999"]'),
          };
        };
      });
      const row = await gateway.getSessionRow(sessionKey);
      const updateRow = async (label: string) => {
        const now = await page.evaluate(() => Date.now());
        await gateway.emitGatewayEvent("sessions.changed", {
          agentId: "main",
          sessionKey,
          reason: "patch",
          ancestorSessions: [],
          session: { ...row, label, displayName: label, updatedAt: now, snapshotAt: now },
        });
      };
      const requestsBefore = await gateway.getRequests();
      for (const key of "abcdefghij") {
        await updateRow("Background update " + key);
        await input.press(key);
        await page.clock.runFor(32);
      }
      // Cross the event-collection window, but not the independent 60-second fallback.
      await page.clock.fastForward(5_001);
      expect(await input.inputValue()).toBe("Warmup abcdefghij");
      expect(await observation.evaluate((finish) => finish())).toEqual({
        catalogLabelReads: 0,
        sameTextarea: true,
        sameModelOption: true,
      });
      await expect.poll(() => sidebarRow.textContent()).toContain("Background update j");
      expect((await gateway.getRequests()).slice(requestsBefore.length)).toEqual([]);
      await observation.dispose();
      // Reveal catches up from the current owner, not a retained mutable roster.
      await input.fill("");
      const recent = page.locator(".agent-chat__recent-name").first();
      await expect.poll(() => recent.textContent()).toBe("Background update j");
      await updateRow("Visible recent update");
      await expect.poll(() => recent.textContent()).toBe("Visible recent update");
    });
  });
});
