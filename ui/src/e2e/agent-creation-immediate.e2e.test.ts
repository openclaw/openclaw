import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import { captureSidebarUiProof } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI immediate agent creation" });
const greeting = "Hi! What would you like to call me?";
const previousMessage = "Synthetic Harbor conversation before agent creation.";
const pendingSelector = 'openclaw-pending-session-create[aria-hidden="false"]';

suite.define(() => {
  it("prepares creation from the cold selector and immediately previews its own chat before admission", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 1000 } },
      async ({ page }) => {
        await page.addInitScript(
          ({ key }) => localStorage.setItem(key, JSON.stringify({ sidebarAgentsMode: "chip" })),
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
        );
        // Synthetic Gateway data exercises the bundled UI, not inference or saved history.
        const gateway = await installMockGateway(page, {
          assistantName: "Harbor",
          historyMessages: [{ role: "assistant", content: previousMessage }],
          methodResponses: {
            "config.get": { exists: true, valid: true, sourceConfig: {} },
          },
        });
        const renderer = await holdModuleResponse(
          page,
          controlUiE2eBuiltModuleRequest("ui/src/pages/chat/pending-session-create.tsx"),
        );
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiRoute(page, { routeId: "chat" });
        const originalPane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        await originalPane.getByText(previousMessage, { exact: true }).waitFor();
        const originalUrl = page.url();
        const startupRequests = await gateway.getRequests("chat.startup");
        const sidebar = page.locator("openclaw-app-sidebar");
        const selectorButton = sidebar.locator(".sidebar-agent-card__main");
        await selectorButton.click();
        await renderer.request;
        const selector = sidebar.locator(".sidebar-agent-menu");
        const create = selector.locator('[data-value="command:new-agent"]');
        // A ready Create action must already own the renderer; clicking cannot wait on this chunk.
        expect(await create.count()).toBe(0);
        renderer.release();
        await create.waitFor({ state: "visible" });
        await gateway.deferNext("agents.create");
        await captureSidebarUiProof(suite, page, "synthetic-agent-create-before.png");

        const [firstPaint] = await Promise.all([
          page.evaluate(
            ({ pending, text, originalPath }) =>
              new Promise<{ elapsedMs: number; previousPanePresented: boolean }>((resolve) => {
                const started = performance.now();
                const sample = () => {
                  const host = document.querySelector(pending);
                  const message = host?.querySelector(".chat-group.assistant .chat-text");
                  const elapsedMs = performance.now() - started;
                  const presented =
                    host &&
                    getComputedStyle(host).opacity === "1" &&
                    message?.textContent?.trim() === text &&
                    message.getBoundingClientRect().height > 0 &&
                    location.pathname !== originalPath &&
                    !document.querySelector(".sidebar-agent-menu");
                  if (presented || elapsedMs >= 5_000) {
                    resolve({
                      elapsedMs: presented ? elapsedMs : -1,
                      previousPanePresented:
                        document.querySelector('openclaw-chat-pane[aria-hidden="false"]') !== null,
                    });
                    return;
                  }
                  requestAnimationFrame(sample);
                };
                sample();
              }),
            {
              pending: pendingSelector,
              text: greeting,
              originalPath: new URL(originalUrl).pathname,
            },
          ),
          create.click(),
        ]);
        // This bounds automation-to-painted-preview time; it makes no provider/persistence claim.
        expect(firstPaint.elapsedMs).toBeGreaterThanOrEqual(0);
        expect(firstPaint.elapsedMs).toBeLessThan(5_000);
        expect(firstPaint.previousPanePresented).toBe(false);
        const request = await gateway.waitForRequest("agents.create");
        expect(request.params).toEqual({
          agentId: expect.stringMatching(/^bot-/u),
          name: "New agent",
          onboarding: true,
        });
        if (
          !request.params ||
          typeof request.params !== "object" ||
          !("agentId" in request.params) ||
          typeof request.params.agentId !== "string"
        ) {
          throw new Error("Expected the pending agent's stable identity");
        }
        const agentId = request.params.agentId;
        expect(new URL(page.url()).pathname).toBe(`/chat/${agentId}`);
        const pending = page.locator(pendingSelector);
        expect(
          (await pending.locator(".chat-group.assistant .chat-text").allTextContents()).map(
            (text) => text.trim(),
          ),
        ).toEqual([greeting]);
        expect(await pending.locator(".chat-group.user").count()).toBe(0);
        expect(await pending.textContent()).not.toContain(previousMessage);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("chat.startup")).toEqual(startupRequests);
        await captureSidebarUiProof(suite, page, "synthetic-agent-create-pending.png");

        await selectorButton.click();
        const firstAgent = selector.locator('[data-value^="agent:"]').first();
        await expect.poll(() => firstAgent.getAttribute("data-value")).toBe(`agent:${agentId}`);
        expect(await firstAgent.textContent()).toContain("New agent");
        expect(await firstAgent.textContent()).not.toContain(agentId);
        expect(await firstAgent.getAttribute("aria-disabled")).toBe("true");
        await captureSidebarUiProof(suite, page, "synthetic-agent-create-roster.png");
        await page.keyboard.press("Escape");

        await gateway.rejectDeferred("agents.create", {
          code: "UNAVAILABLE",
          message: "Synthetic inference unavailable",
        });
        await expect.poll(() => page.url()).toBe(originalUrl);
        await originalPane.getByText(previousMessage, { exact: true }).waitFor();
        expect(await page.locator("openclaw-pending-session-create").count()).toBe(0);
        expect(await originalPane.getByText(greeting, { exact: true }).count()).toBe(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("chat.startup")).toEqual(startupRequests);
        await selectorButton.click();
        await selector.waitFor({ state: "visible" });
        expect(await selector.locator(`[data-value="agent:${agentId}"]`).count()).toBe(0);
        expect(await gateway.getRequests("agents.create")).toHaveLength(1);
        await captureSidebarUiProof(suite, page, "synthetic-agent-create-rejected.png");
      },
    );
  });
});
