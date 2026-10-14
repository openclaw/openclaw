import { expect, it } from "vitest";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
suite.define(() => {
  it("does not rebuild model options while typing a draft with a large catalog", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
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
          kind: "direct",
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
            return catalogLabelReads;
          },
        };
      });
      const samples: number[] = [];
      for (const key of "abcdefghij") {
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
      expect(await observation.evaluate((value) => value.finish())).toBe(0);
      await observation.dispose();
    });
  });
});
