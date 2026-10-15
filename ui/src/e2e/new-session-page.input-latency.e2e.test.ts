import { expect, it } from "vitest";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
suite.define(() => {
  it("keeps model options stable while typing with unrelated session updates", async () => {
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
          updatedAt: 1000 + index,
        })),
      });
      await page.goto(suite.server.baseUrl + "new");
      await page.locator('[data-chat-model-option="fixture/model-1999"]').waitFor({
        state: "attached",
      });
      const input = page.locator(".new-session-page__message");
      await input.fill("Warmup ");
      await input.focus();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
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
          if (/^Model \d+$/.test(this)) {
            catalogLabelReads += 1;
          }
          return Reflect.apply(original, this, args);
        };
        return {
          finish() {
            // oxlint-disable-next-line no-extend-native -- Restore the page-local instrumentation.
            String.prototype.toLocaleLowerCase = original;
            return {
              catalogLabelReads,
              sameTextarea: textarea === document.querySelector(".new-session-page__message"),
              sameModelOption:
                modelOption ===
                document.querySelector('[data-chat-model-option="fixture/model-1999"]'),
            };
          },
        };
      });
      const samples: number[] = [];
      const sessionKey = "agent:main:dashboard:typing-0";
      const row = await gateway.getSessionRow(sessionKey);
      const requestsBefore = await gateway.getRequests();
      for (const key of "abcdefghij") {
        await gateway.emitGatewayEvent("sessions.changed", {
          agentId: "main",
          sessionKey,
          reason: "patch",
          ancestorSessions: [],
          session: {
            ...row,
            label: "Background update " + key,
            displayName: "Background update " + key,
            updatedAt: Date.now(),
            snapshotAt: Date.now(),
          },
        });
        const start = performance.now();
        await input.press(key);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        samples.push(performance.now() - start);
      }
      // Keep timing diagnostic-only: the deterministic regression is catalog work,
      // not a wall-clock threshold sensitive to the machine running this test.
      console.log("New Session key + two frames (ms)", samples);
      expect(await input.inputValue()).toBe("Warmup abcdefghij");
      expect(await observation.evaluate((value) => value.finish())).toEqual({
        catalogLabelReads: 0,
        sameTextarea: true,
        sameModelOption: true,
      });
      await expect
        .poll(() =>
          page
            .locator('aside.sidebar [data-session-key="' + sessionKey + '"]')
            .first()
            .textContent(),
        )
        .toContain("Background update j");
      expect((await gateway.getRequests()).slice(requestsBefore.length)).toEqual([]);
      await observation.dispose();
    });
  });
});
