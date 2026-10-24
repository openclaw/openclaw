import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  createControlUiMockBootstrapConfig,
} from "../test-helpers/control-ui-e2e.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps bubble waits quiet and reveals real work without duplicate indicators", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.addInitScript((key) => {
      localStorage.setItem(key, JSON.stringify({ theme: "light" }));
    }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
    const gateway = await installMockGateway(page, { historyMessages: [] });
    await page.route("**/control-ui-config.json", (route) =>
      route.fulfill({
        json: { ...createControlUiMockBootstrapConfig(), chatBubblesEnabled: true },
      }),
    );
    const artifactDir = createControlUiE2eArtifactDir("model-wait");
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await expect.poll(() => page.locator(".chat--bubbles").count()).toBe(1);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Compare these synthetic local model results.");
      await composer.press("Enter");
      const send = await gateway.waitForRequest("chat.send");
      const { idempotencyKey: runId, sessionKey } = send.params as {
        idempotencyKey: string;
        sessionKey: string;
      };
      const working = page.locator('.chat-working-indicator[role="status"]');
      const bubble = page.locator("details.chat-bubble-activity--working");
      const summary = bubble.locator("summary");
      const status = async (seq: number, phase: string, waitReason?: string) => {
        await gateway.emitGatewayEvent("chat", {
          runId,
          sessionKey,
          seq,
          state: "status",
          phase,
          waitReason,
        });
      };
      await status(1, "starting_model");
      await expect.poll(() => summary.textContent()).toBe("");
      await expect.poll(() => summary.locator(".chat-bubble-dots > span").count()).toBe(3);
      expect(await working.isVisible()).toBe(false);
      await writeFile(
        path.join(artifactDir, "quiet-startup.png"),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [summary]),
      );
      expect(await bubble.locator("svg").count()).toBe(0);
      await summary.click();
      await expect.poll(() => working.textContent()).toContain("Waiting for a response");
      await status(2, "waiting_for_model", "slot");
      await expect.poll(() => working.textContent()).toContain("Waiting for a free model slot");
      await writeFile(
        path.join(artifactDir, "after-slot-wait.png"),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [working]),
      );
      await gateway.emitGatewayEvent("chat", {
        runId,
        sessionKey,
        seq: 1,
        state: "delta",
        message: { role: "assistant", content: "First result." },
        deltaText: "First result.",
      });
      await gateway.emitGatewayEvent("agent", {
        runId,
        sessionKey,
        seq: 3,
        ts: 1,
        stream: "assistant",
        data: { text: "First result." },
      });
      await expect.poll(() => working.count()).toBe(0);
      await status(4, "waiting_for_model", "response");
      await expect
        .poll(() => working.textContent())
        .toContain("Waiting for the local model to respond");
      await summary.click();
      await status(3, "waiting_for_model", "slot");
      await expect
        .poll(() => working.textContent())
        .toContain("Waiting for the local model to respond");
      await writeFile(
        path.join(artifactDir, "response-wait.png"),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [working]),
      );
      await summary.click();
      await gateway.emitGatewayEvent("agent", {
        runId,
        sessionKey,
        seq: 5,
        ts: Date.now(),
        stream: "tool",
        data: {
          phase: "start",
          name: "exec",
          toolCallId: "bubble-check",
          args: { command: "pnpm test", title: "Checking the tests" },
        },
      });
      const activity = {
        itemId: "tool:bubble-check",
        toolCallId: "bubble-check",
        kind: "tool",
        name: "exec",
        title: "Checking the tests",
        meta: "Checking the tests",
        commandBearing: true,
      };
      await gateway.emitGatewayEvent("agent", {
        runId,
        sessionKey,
        seq: 6,
        ts: Date.now(),
        stream: "item",
        data: { ...activity, phase: "start", status: "running" },
      });
      const workBubble = page.locator(".chat-activity-group--working");
      await expect.poll(() => workBubble.textContent()).toContain("Checking the tests");
      expect(await bubble.count()).toBe(0);
      expect(await page.locator(".chat-bubble-dots--working").count()).toBe(1);
      await writeFile(
        path.join(artifactDir, "active-work.png"),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [workBubble]),
      );
      await workBubble.locator(".chat-activity-group__summary").click();
      await expect
        .poll(() => workBubble.locator(".chat-activity-group__body").isVisible())
        .toBe(true);
      await writeFile(
        path.join(artifactDir, "expanded-work.png"),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [workBubble]),
      );
      await workBubble.locator(".chat-activity-group__summary").click();
      await page.setViewportSize({ width: 390, height: 844 });
      await writeFile(
        path.join(artifactDir, "active-work-mobile.png"),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [workBubble]),
      );
      await gateway.emitGatewayEvent("agent", {
        runId,
        sessionKey,
        seq: 7,
        ts: Date.now(),
        stream: "tool",
        data: {
          phase: "result",
          name: "exec",
          toolCallId: "bubble-check",
          result: { content: [{ type: "text", text: "All tests passed." }] },
        },
      });
      await gateway.emitGatewayEvent("agent", {
        runId,
        sessionKey,
        seq: 8,
        ts: Date.now(),
        stream: "item",
        data: { ...activity, phase: "end", status: "completed" },
      });
      await expect.poll(() => workBubble.count()).toBe(0);
      await gateway.emitGatewayEvent("chat", { runId, sessionKey, seq: 9, state: "aborted" });
      await expect.poll(() => working.count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
