import type { ElementHandle, Locator } from "playwright";
import { expect, it } from "vitest";
import {
  chatMessage,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:main";
const composerSelector = ".agent-chat__composer-combobox textarea";
const progressSelector = '[data-progress-card-placement="details"]';

async function expectComposer(composer: Locator, original: ElementHandle | null, draft: string) {
  expect(await composer.evaluate((node, element) => node === element, original)).toBe(true);
  expect(await composer.inputValue()).toBe(draft);
  expect(await composer.evaluate((node) => document.activeElement === node)).toBe(true);
}

suite.define(() => {
  it.each(["card", "empty", "error"] as const)(
    "keeps the same usable composer through initial history and %s progress",
    async (outcome) => {
      const contextOptions = {
        viewport: { width: 1440, height: 900 },
        reducedMotion: "no-preference",
      } as const;
      await suite.withPage(contextOptions, async ({ page }) => {
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
            hasActiveRun: false,
          },
          historyMessages: [chatMessage("assistant", "Ready.")],
          deferredMethods: ["chat.startup", "progressCard.get", "chat.send"],
          methodResponses: { "progressCard.get": { card } },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const composer = page.locator(composerSelector);
        await composer.fill("Queue before history and progress");
        const textarea = await composer.elementHandle();
        expect(textarea).not.toBeNull();
        await page.locator(".agent-chat__file-input").setInputFiles({
          name: "startup-note.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Synthetic startup attachment"),
        });
        await page.locator(".chat-attachment-thumb", { hasText: "startup-note.txt" }).waitFor();
        await composer.press("Enter");
        await page
          .locator(".chat-queue")
          .getByText("Queue before history and progress", { exact: true })
          .waitFor();
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("progressCard.get")).toHaveLength(0);
        const draft = "Keep this draft while progress loads";
        await composer.fill(draft);
        await gateway.resolveDeferred("chat.startup");
        await gateway.waitForRequest("progressCard.get");
        await page.locator(".chat-thread").getByText("Ready.", { exact: true }).waitFor();
        const send = await gateway.waitForRequest("chat.send");
        expect(send.params).toMatchObject({
          sessionKey,
          message: "Queue before history and progress",
          attachments: [expect.objectContaining({ fileName: "startup-note.txt" })],
        });
        await expectComposer(composer, textarea, draft);
        const geometry = await page.evaluateHandle(() => {
          const bounds = (selector: string) => {
            const element = document.querySelector<HTMLElement>(selector)!;
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height };
          };
          const readEditor = () => ({
            input: bounds(".agent-chat__input"),
            textarea: bounds(".agent-chat__composer-combobox textarea"),
          });
          const before = readEditor();
          const frames: Array<{ top: number; height: number; card: boolean }> = [];
          const editorFrames: Array<typeof before> = [];
          let remaining: number | undefined;
          let frame: number;
          let complete!: () => void;
          const finished = new Promise<void>((resolve) => {
            complete = resolve;
          });
          const sample = () => {
            editorFrames.push(readEditor());
            if (remaining !== undefined) {
              const shell = document.querySelector<HTMLElement>(".agent-chat__composer-shell")!;
              frames.push({
                top: shell.offsetTop,
                height: shell.getBoundingClientRect().height,
                card: shell.querySelector('[data-progress-card-placement="composer"]') !== null,
              });
              if (--remaining === 0) {
                complete();
                return;
              }
            }
            frame = requestAnimationFrame(sample);
          };
          sample();
          return {
            async finish() {
              remaining = 20;
              await finished;
              return { frames, before, editorFrames };
            },
            cancel: () => cancelAnimationFrame(frame),
          };
        });
        try {
          if (outcome === "error") {
            await gateway.rejectDeferred("progressCard.get", {
              message: "Progress temporarily unavailable",
            });
          } else {
            await gateway.resolveDeferred("progressCard.get", {
              card: outcome === "card" ? card : null,
            });
          }
          if (outcome === "card") {
            await page.locator(progressSelector).waitFor({ state: "attached" });
          }
          await expect
            .poll(() => page.locator('openclaw-chat-details-progress [role="status"]').count())
            .toBe(0);
          await expectComposer(composer, textarea, draft);
          const { frames, before, editorFrames } = await geometry.evaluate((capture) =>
            capture.finish(),
          );
          for (const sample of editorFrames) {
            for (const surface of ["input", "textarea"] as const) {
              for (const dimension of ["x", "y", "width", "height"] as const) {
                expect(
                  Math.abs(sample[surface][dimension] - before[surface][dimension]),
                ).toBeLessThanOrEqual(1);
              }
            }
          }
          expect(frames.every((frame) => !frame.card)).toBe(true);
          const detailsToggle = page.locator(".chat-details-toggle");
          expect(await detailsToggle.getAttribute("aria-expanded")).toBe("false");
          expect(await page.locator('.chat-details[role="dialog"]').isVisible()).toBe(false);
          for (const dimension of ["height", "top"] as const) {
            const values = frames.map((frame) => frame[dimension]);
            expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
          }
        } finally {
          await geometry.evaluate((capture) => capture.cancel());
          await geometry.dispose();
        }

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
      });
    },
  );

  it.each(["history", "progress"] as const)(
    "preserves the composer when %s settles first during a history refresh and initial progress read",
    async (first) => {
      await suite.withPage({}, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionInfo: { key: sessionKey, kind: "direct", updatedAt: 1 },
          historyMessages: [chatMessage("assistant", "Ready.")],
          deferredMethods: ["progressCard.get"],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("progressCard.get");
        const composer = page.locator(composerSelector);
        const draft = "Keep draft and focus through either reply order";
        await composer.fill(draft);
        const textarea = await composer.elementHandle();
        expect(textarea).not.toBeNull();
        // Initial history owns progress admission. A live message can independently
        // refresh that history while the first progress response is still pending.
        await gateway.deferNext("chat.history");
        const before = (await gateway.getRequests("chat.history")).length;
        await gateway.emitGatewayEvent("session.message", {
          sessionKey,
          session: { key: sessionKey, kind: "direct", updatedAt: 2 },
          messageId: "startup-peer-message",
          messageSeq: 3,
          message: chatMessage("user", "A peer joined the conversation.", {
            __openclaw: { id: "startup-peer-message", seq: 3 },
          }),
        });
        await gateway.waitForRequest("chat.history", { after: before });
        for (const response of [first, first === "history" ? "progress" : "history"]) {
          if (response === "history") {
            await gateway.resolveDeferred("chat.history");
          } else {
            await gateway.resolveDeferred("progressCard.get", {
              card: { sessionKey, revision: 1, updatedAt: 1, markdown: "Initial task progress" },
            });
            await page.locator(progressSelector).waitFor({ state: "attached" });
          }
          await expectComposer(composer, textarea, draft);
        }
      });
    },
  );

  it("shows a failed initial history without waiting for progress", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        historyMessages: [],
        deferredMethods: ["chat.startup", "progressCard.get"],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await gateway.rejectDeferred("chat.startup", { message: "History temporarily unavailable" });
      const error = page.locator('.chat-history-error[role="alert"]');
      await error.waitFor();
      expect(await error.textContent()).toContain("History temporarily unavailable");
      await page.locator(composerSelector).fill("Preserve this recovery draft");
      expect(await error.getByRole("button", { name: "Retry" }).count()).toBe(1);
    });
  });
});
