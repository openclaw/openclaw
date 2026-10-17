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
const sessionInfo = { key: sessionKey, kind: "direct", updatedAt: 1 };
const historyMessages = [chatMessage("assistant", "Ready.")];

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
        const card = { sessionKey, revision: 1, updatedAt: Date.now(), markdown: "Task progress" };
        const gateway = await installMockGateway(page, {
          sessionInfo: { ...sessionInfo, hasActiveRun: false },
          historyMessages,
          deferredMethods: ["chat.startup", "progressCard.get", "chat.send"],
          methodResponses: { "progressCard.get": { card } },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const composer = page.locator(composerSelector);
        const queued = "Queue before history";
        await composer.fill(queued);
        const textarea = await composer.elementHandle();
        await page.locator(".agent-chat__file-input").setInputFiles({
          name: "startup-note.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Synthetic startup attachment"),
        });
        await page.locator(".chat-attachment-thumb", { hasText: "startup-note.txt" }).waitFor();
        await composer.press("Enter");
        await page.locator(".chat-queue").getByText(queued, { exact: true }).waitFor();
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
          message: queued,
          attachments: [expect.objectContaining({ fileName: "startup-note.txt" })],
        });
        await expectComposer(composer, textarea, draft);
        const geometry = await page.evaluateHandle(() => {
          const readEditor = () =>
            [".agent-chat__input", ".agent-chat__composer-combobox textarea"].flatMap(
              (selector) => {
                const box = document.querySelector(selector)!.getBoundingClientRect();
                return [box.x, box.y, box.width, box.height];
              },
            );
          const before = readEditor();
          const frames: Array<{ top: number; height: number; card: boolean }> = [];
          let editorDrift = 0;
          let finishing = false;
          let frame: number;
          const sample = () => {
            editorDrift = Math.max(
              editorDrift,
              ...readEditor().map((value, i) => Math.abs(value - before[i]!)),
            );
            if (finishing) {
              const shell = document.querySelector<HTMLElement>(".agent-chat__composer-shell")!;
              frames.push({
                top: shell.offsetTop,
                height: shell.getBoundingClientRect().height,
                card: shell.querySelector('[data-progress-card-placement="composer"]') !== null,
              });
            }
            frame = requestAnimationFrame(sample);
          };
          sample();
          return {
            async finish() {
              finishing = true;
              for (let i = 0; i < 20; i++) {
                await new Promise<number>(requestAnimationFrame);
              }
              return { frames, editorDrift };
            },
            cancel: () => cancelAnimationFrame(frame),
          };
        });
        try {
          if (outcome === "error") {
            await gateway.rejectDeferred("progressCard.get", { message: "Progress unavailable" });
          } else {
            await gateway.resolveDeferred("progressCard.get", {
              card: outcome === "card" ? card : null,
            });
          }
          if (outcome === "card") {
            await page.locator(progressSelector).waitFor({ state: "attached" });
          }
          const pending = page.locator('openclaw-chat-details-progress [role="status"]');
          await expect.poll(() => pending.count()).toBe(0);
          await expectComposer(composer, textarea, draft);
          const { frames, editorDrift } = await geometry.evaluate((capture) => capture.finish());
          expect(editorDrift).toBeLessThanOrEqual(1);
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
        await gateway.rejectDeferred("progressCard.get", { message: "Refresh unavailable" });
        expect(await composer.inputValue()).toBe("Keep this draft while progress refreshes");
      });
    },
  );

  it.each(["history", "progress"] as const)(
    "preserves the composer when %s settles first during a history refresh and initial progress read",
    async (first) => {
      await suite.withPage({}, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionInfo,
          historyMessages,
          deferredMethods: ["progressCard.get"],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("progressCard.get");
        const composer = page.locator(composerSelector);
        const draft = "Keep draft and focus through either reply order";
        await composer.fill(draft);
        const textarea = await composer.elementHandle();
        // History admits progress; peer messages may refresh history before progress settles.
        await gateway.deferNext("chat.history");
        const before = (await gateway.getRequests("chat.history")).length;
        await gateway.emitGatewayEvent("session.message", {
          sessionKey,
          session: { key: sessionKey, kind: "direct", updatedAt: 2 },
          messageId: "peer",
          messageSeq: 3,
          message: chatMessage("user", "Peer joined.", { __openclaw: { id: "peer", seq: 3 } }),
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
