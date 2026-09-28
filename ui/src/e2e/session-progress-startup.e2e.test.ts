import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each(["card", "empty", "error"] as const)(
    "keeps the same usable composer through initial history and %s progress",
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
          hasActiveRun: false,
        },
        historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
        deferredMethods: ["chat.startup", "progressCard.get", "chat.send"],
        methodResponses: { "progressCard.get": { card } },
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        const artifactDir = createControlUiE2eArtifactDir(`progress-startup-${outcome}`);
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Queue before history and progress");
        await page.screenshot({
          path: path.join(artifactDir, "history-pending.png"),
          animations: "disabled",
        });
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
        expect(await composer.evaluate((node, original) => node === original, textarea)).toBe(true);
        expect(await composer.inputValue()).toBe(draft);
        expect(await composer.evaluate((node) => document.activeElement === node)).toBe(true);
        await page.screenshot({ path: path.join(artifactDir, "progress-pending.png") });
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
          const editorFrames: Array<typeof before> = [];
          const frames: Array<{ top: number; height: number; card: boolean }> = [];
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
                card: shell.querySelector(".session-progress-card--composer") !== null,
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
            await page.locator(".session-progress-card--composer").waitFor();
          }
          await expect
            .poll(() => page.locator(".agent-chat__progress-float--loading").count())
            .toBe(0);
          expect(await composer.evaluate((node, original) => node === original, textarea)).toBe(
            true,
          );
          expect(await composer.inputValue()).toBe(draft);
          expect(await composer.evaluate((node) => document.activeElement === node)).toBe(true);
          const { frames, before, editorFrames } = await geometry.evaluate((capture) =>
            capture.finish(),
          );
          await page.screenshot({ path: path.join(artifactDir, "progress-resolved.png") });
          for (const sample of editorFrames) {
            for (const surface of ["input", "textarea"] as const) {
              for (const dimension of ["x", "y", "width", "height"] as const) {
                expect(
                  Math.abs(sample[surface][dimension] - before[surface][dimension]),
                ).toBeLessThanOrEqual(1);
              }
            }
          }
          expect(frames.every((frame) => frame.card === (outcome === "card"))).toBe(true);
          expect(
            Math.max(...frames.map((frame) => frame.height)) -
              Math.min(...frames.map((frame) => frame.height)),
          ).toBeLessThanOrEqual(1);
          expect(
            Math.max(...frames.map((frame) => frame.top)) -
              Math.min(...frames.map((frame) => frame.top)),
          ).toBeLessThanOrEqual(1);
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
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it.each(["history", "progress"] as const)(
    "preserves the composer when %s settles first during a history refresh and initial progress read",
    async (first) => {
      const context = await suite.newBrowserContext({});
      const page = await context.newPage();
      const sessionKey = "agent:main:main";
      const gateway = await installMockGateway(page, {
        sessionInfo: { key: sessionKey, kind: "direct", updatedAt: 1 },
        historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
        deferredMethods: ["progressCard.get"],
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("progressCard.get");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
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
          message: {
            role: "user",
            content: [{ type: "text", text: "A peer joined the conversation." }],
            __openclaw: { id: "startup-peer-message", seq: 3 },
          },
        });
        await gateway.waitForRequest("chat.history", { after: before });
        for (const response of [first, first === "history" ? "progress" : "history"]) {
          if (response === "history") {
            await gateway.resolveDeferred("chat.history");
          } else {
            await gateway.resolveDeferred("progressCard.get", {
              card: { sessionKey, revision: 1, updatedAt: 1, markdown: "Initial task progress" },
            });
            await page.locator(".session-progress-card--composer").waitFor();
          }
          expect(await composer.evaluate((node, original) => node === original, textarea)).toBe(
            true,
          );
          expect(await composer.inputValue()).toBe(draft);
          expect(await composer.evaluate((node) => document.activeElement === node)).toBe(true);
        }
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
