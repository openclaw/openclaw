import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI reasoning stream follow" });

// Adapted from leapdragon's scroll regression; layout is the observable contract.
suite.define(() => {
  it("follows reasoning, respects a reader scrolling up, and resumes at the end", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 480 } },
      async ({ page }) => {
        const sessionKey = "agent:main:dashboard:reasoning-follow";
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessionInfo: { reasoningLevel: "stream" },
          sessions: [
            { key: sessionKey, kind: "direct", reasoningLevel: "stream", updatedAt: 1_000 },
          ],
          historyMessages: [],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        await pane.locator(".agent-chat__composer-combobox textarea").fill("Think it through.");
        await page.getByRole("button", { name: "Send message" }).click();
        const send = await gateway.waitForRequest("chat.send");
        const runId = (send.params as { idempotencyKey: string }).idempotencyKey;
        const thread = pane.locator(".chat-thread");
        const geometry = () =>
          thread.evaluate((element) => ({
            scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight,
            distanceFromEnd: element.scrollHeight - element.scrollTop - element.clientHeight,
          }));
        let seq = 0;
        let text = "";
        const streamReasoning = async (lines: number) => {
          for (let index = 0; index < lines; index += 1) {
            text += `Reasoning line ${++seq}: weighing the next step carefully.\n\n`;
          }
          await gateway.emitGatewayEvent("agent", {
            runId,
            seq,
            stream: "thinking",
            ts: 1_100 + seq,
            sessionKey,
            data: { itemId: "long-thought", text },
          });
          await expect
            .poll(() => pane.locator(".chat-thinking").textContent())
            .toContain(`Reasoning line ${seq}:`);
        };

        await streamReasoning(24);
        await expect.poll(async () => (await geometry()).scrollHeight).toBeGreaterThan(480);
        await expect.poll(async () => (await geometry()).distanceFromEnd).toBeLessThanOrEqual(8);
        await streamReasoning(12);
        await expect.poll(async () => (await geometry()).distanceFromEnd).toBeLessThanOrEqual(8);

        await thread.hover();
        await page.mouse.wheel(0, -240);
        await expect.poll(async () => (await geometry()).distanceFromEnd).toBeGreaterThan(100);
        const released = await geometry();
        await streamReasoning(12);
        await expect
          .poll(async () => (await geometry()).scrollHeight)
          .toBeGreaterThan(released.scrollHeight);
        const afterRelease = await geometry();
        expect(afterRelease.scrollTop).toBe(released.scrollTop);
        expect(afterRelease.distanceFromEnd).toBeGreaterThan(released.distanceFromEnd);

        await page.mouse.wheel(0, 100_000);
        await expect.poll(async () => (await geometry()).distanceFromEnd).toBeLessThanOrEqual(8);
        await streamReasoning(12);
        await expect.poll(async () => (await geometry()).distanceFromEnd).toBeLessThanOrEqual(8);
      },
    );
  });
});
