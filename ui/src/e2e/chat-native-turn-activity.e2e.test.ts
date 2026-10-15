import { expect, it } from "vitest";
import { projectAgentToolActivity } from "../../../src/infra/agent-activity-events.js";
import { createChatFlowE2eSuite } from "./chat-flow.test-support.ts";
import { openMockAbortableRun } from "./chat-run-lifecycle.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("resumes native tool and retry activity across the thread, composer, sidebar and favicon", async () => {
    await suite.withPage({ viewport: { height: 800, width: 1200 } }, async ({ page }) => {
      const { gateway, sessionKey, runId, stop } = await openMockAbortableRun(
        page,
        suite.server.baseUrl,
        "native-tool-run",
      );
      const thread = page.locator(".chat-working-indicator");
      const composer = page.locator(".agent-chat__run-status-announcement");
      const sidebar = page.locator(".sidebar-footer-bar__home").getByLabel("Active run");
      const favicon = page.locator('link[rel="icon"][type="image/svg+xml"]');
      const emit = (seq: number, stream: string, data: Record<string, unknown>) =>
        gateway.emitGatewayEvent("agent", { sessionKey, runId, seq, stream, data, ts: seq });
      await emit(1, "assistant", {
        itemId: "text",
        text: "Checking the file.",
        delta: "Checking the file.",
      });
      await expect.poll(() => thread.count()).toBe(0);
      await expect.poll(() => composer.textContent()).toBe("");
      await expect.poll(() => sidebar.count()).toBe(0);
      const idleFavicon = await favicon.getAttribute("href");
      await emit(
        2,
        "item",
        projectAgentToolActivity({ phase: "start", toolCallId: "read", name: "read_file" }),
      );
      await expect.poll(() => thread.count()).toBeGreaterThan(0);
      await expect.poll(() => composer.textContent()).not.toBe("");
      await expect.poll(() => sidebar.count()).toBeGreaterThan(0);
      await expect.poll(() => favicon.getAttribute("href")).not.toBe(idleFavicon);
      await emit(3, "lifecycle", { phase: "finishing", error: "Retryable attempt failure" });
      await expect.poll(() => thread.count()).toBe(0);
      await emit(4, "run_status", { phase: "retrying", message: "Retrying", attempt: 2 });
      await expect.poll(() => thread.count()).toBeGreaterThan(0);
      await expect.poll(() => composer.textContent()).not.toBe("");
      await expect.poll(() => sidebar.count()).toBeGreaterThan(0);
      await expect.poll(() => favicon.getAttribute("href")).not.toBe(idleFavicon);
      await emit(3, "lifecycle", { phase: "finishing" });
      await emit(2, "assistant", { text: "Stale answer" });
      expect(await thread.count()).toBeGreaterThan(0);
      expect(await composer.textContent()).not.toBe("");
      expect(await sidebar.count()).toBeGreaterThan(0);
      expect(await favicon.getAttribute("href")).not.toBe(idleFavicon);
      expect(await stop.isVisible()).toBe(true);
      await emit(5, "assistant", { itemId: "final", text: "File read.", delta: "File read." });
      await emit(6, "lifecycle", { phase: "finishing" });
      await expect.poll(() => thread.count()).toBe(0);
      await expect.poll(() => composer.textContent()).toBe("");
      await expect.poll(() => sidebar.count()).toBe(0);
      await expect.poll(() => favicon.getAttribute("href")).toBe(idleFavicon);
    });
  });
});
