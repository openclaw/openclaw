import { expect, it } from "vitest";
import { projectAgentToolActivity } from "../../../src/infra/agent-activity-events.js";
import { createChatFlowE2eSuite } from "./chat-flow.test-support.ts";
import { openMockAbortableRun } from "./chat-run-lifecycle.test-support.ts";
import { holdModuleResponse } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps roster activity until terminal delivery while chat foreground activity resumes on tools and retries", async () => {
    await suite.withPage({ viewport: { height: 800, width: 1200 } }, async ({ page }) => {
      const source = await holdModuleResponse(page, /\/favicon\.svg(?:\?|$)/u);
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
      await source.request;
      const idleFavicon = await favicon.getAttribute("href");
      expect(idleFavicon).toMatch(/^\/favicon\.svg(?:\?|$)/u);
      source.release();
      const workingColor = await page.evaluate(() => {
        const root = document.documentElement;
        return getComputedStyle(root)
          .getPropertyValue(root.dataset.themeMode === "light" ? "--info" : "--accent")
          .trim();
      });
      await expect.poll(() => sidebar.count()).toBeGreaterThan(0);
      await expect.poll(() => favicon.getAttribute("href")).toMatch(/^data:image\/svg\+xml,/);
      const activeFavicon = await favicon.getAttribute("href");
      expect(
        await favicon.evaluate((icon) => {
          const href = icon.getAttribute("href")!;
          const svg = new DOMParser().parseFromString(
            decodeURIComponent(href.slice(href.indexOf(",") + 1)),
            "image/svg+xml",
          );
          return svg.documentElement.lastElementChild?.getAttribute("fill");
        }),
      ).toBe(workingColor);
      await emit(
        2,
        "item",
        projectAgentToolActivity({ phase: "start", toolCallId: "read", name: "read_file" }),
      );
      await expect.poll(() => thread.count()).toBeGreaterThan(0);
      await expect.poll(() => composer.textContent()).not.toBe("");
      await expect.poll(() => sidebar.count()).toBeGreaterThan(0);
      await expect.poll(() => favicon.getAttribute("href")).toBe(activeFavicon);
      await emit(3, "lifecycle", { phase: "finishing", error: "Retryable attempt failure" });
      await expect.poll(() => thread.count()).toBe(0);
      await emit(4, "run_status", { phase: "retrying", message: "Retrying", attempt: 2 });
      await expect.poll(() => thread.count()).toBeGreaterThan(0);
      await expect.poll(() => composer.textContent()).not.toBe("");
      await expect.poll(() => sidebar.count()).toBeGreaterThan(0);
      await expect.poll(() => favicon.getAttribute("href")).toBe(activeFavicon);
      await emit(3, "lifecycle", { phase: "finishing" });
      await emit(2, "assistant", { text: "Stale answer" });
      expect(await thread.count()).toBeGreaterThan(0);
      expect(await composer.textContent()).not.toBe("");
      expect(await sidebar.count()).toBeGreaterThan(0);
      expect(await favicon.getAttribute("href")).toBe(activeFavicon);
      expect(await stop.isVisible()).toBe(true);
      await emit(5, "assistant", { itemId: "final", text: "File read.", delta: "File read." });
      await emit(6, "lifecycle", { phase: "finishing" });
      await expect.poll(() => thread.count()).toBe(0);
      await expect.poll(() => composer.textContent()).toBe("");
      await expect.poll(() => sidebar.count()).toBeGreaterThan(0);
      await expect.poll(() => favicon.getAttribute("href")).toBe(activeFavicon);
      expect(await stop.isVisible()).toBe(true);
      await gateway.emitGatewayEvent("chat", {
        sessionKey,
        runId,
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "File read." }] },
      });
      await expect.poll(() => sidebar.count()).toBe(0);
      await expect.poll(() => favicon.getAttribute("href")).toBe(idleFavicon);
      await stop.waitFor({ state: "hidden" });
    });
  });
});
