import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI immediate agent creation" });
const greeting = "Hi, I’m New agent. Happy to help.";
const previousMessage = "Synthetic Harbor conversation before agent creation.";
const pendingSelector = 'openclaw-pending-session-create[aria-hidden="false"]';
const pageOptions = {
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { width: 1440, height: 1000 },
};

async function openCreationDialog(page: Page) {
  await page.goto(`${suite.server.baseUrl}chat`);
  await waitForControlUiRoute(page, { routeId: "chat" });
  const sidebar = page.locator("openclaw-app-sidebar");
  await sidebar.locator(".sidebar-agent-card__main").click();
  await sidebar.locator('[data-value="command:new-agent"]').click();
  const dialog = page.locator(".agent-create-dialog");
  await dialog.waitFor({ state: "visible" });
  return dialog;
}

suite.define(() => {
  it("keeps the creation dialog stable when selecting Blobster presets", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      await page.addInitScript(() => {
        // oxlint-disable-next-line typescript/unbound-method -- The intercepted image remains the receiver via .call(this).
        const decode = HTMLImageElement.prototype.decode;
        HTMLImageElement.prototype.decode = function () {
          const result = decode.call(this);
          return this.src.startsWith("data:image/svg+xml")
            ? result.then(
                () =>
                  new Promise<void>((resolve) => {
                    setTimeout(resolve, 500);
                  }),
              )
            : result;
        };
      });
      await installMockGateway(page, {
        assistantName: "Harbor",
        methodResponses: { "config.get": { exists: true, valid: true, sourceConfig: {} } },
      });
      const dialog = await openCreationDialog(page);
      const presets = dialog.locator(".avatar-picker__preset");
      await presets.first().click();
      await expect.poll(() => presets.first().getAttribute("aria-pressed")).toBe("true");
      await page.waitForTimeout(250); // Let the opening animation finish before measuring selection.

      const bounds = () =>
        dialog.evaluate((modal) => {
          const rect = modal.getBoundingClientRect();
          return { top: Math.round(rect.top), height: Math.round(rect.height) };
        });
      const before = await bounds();
      await presets.nth(1).click();
      await dialog.locator('.avatar-picker__status[role="status"]').waitFor({ state: "attached" });
      const during = await bounds();
      await expect.poll(() => presets.nth(1).getAttribute("aria-pressed")).toBe("true");
      const after = await bounds();
      const frames = [before, during, after];
      for (const dimension of ["height", "top"] as const) {
        const values = frames.map((frame) => frame[dimension]);
        expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
      }
    });
  });

  it("keeps its height as avatar tabs change and generates through the footer", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        assistantName: "Harbor",
        featureMethods: [...defaultControlUiFeatureMethods, "agents.avatar.generate"],
        methodResponses: {
          "config.get": { exists: true, valid: true, sourceConfig: {} },
          "agents.avatar.generate": {
            name: "Sky helper",
            description: "A friendly blue avatar.",
            svg: '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><circle cx="48" cy="48" r="44" fill="#4488ff"/></svg>',
          },
        },
      });
      const dialog = await openCreationDialog(page);
      await page.waitForTimeout(250);
      const initialHeight = await dialog.evaluate(
        (element) => element.getBoundingClientRect().height,
      );
      const assertStableHeight = async () => {
        const height = await dialog.evaluate((element) => element.getBoundingClientRect().height);
        expect(Math.abs(height - initialHeight)).toBeLessThanOrEqual(1);
      };

      await dialog.getByRole("button", { name: "Generate", exact: true }).first().click();
      await assertStableHeight();
      expect(await dialog.locator(".avatar-picker__preview").count()).toBe(0);
      const action = dialog.locator(".agent-create-dialog__actions button").last();
      await expect.poll(() => action.textContent()).toBe("Generate");
      await dialog.locator("textarea").fill("A friendly blue guide");
      await action.click();
      await expect
        .poll(async () => (await gateway.getRequests("agents.avatar.generate")).length)
        .toBe(1);
      await expect.poll(() => action.textContent()).toBe("Save");
      const reset = dialog.locator(".agent-create-dialog__actions button").first();
      const preview = dialog.locator(".agent-create-dialog__preview img");
      await expect.poll(() => reset.textContent()).toBe("Reset");
      await expect.poll(() => preview.count()).toBe(1);
      await assertStableHeight();

      await reset.click();
      await expect.poll(() => dialog.locator("textarea").inputValue()).toBe("");
      await expect.poll(() => preview.count()).toBe(0);
      await expect.poll(() => action.textContent()).toBe("Generate");
      await assertStableHeight();

      await dialog.getByRole("button", { name: "Upload", exact: true }).click();
      await assertStableHeight();
      await dialog.getByRole("button", { name: "Blobster", exact: true }).click();
      await assertStableHeight();
    });
  });

  it("prepares creation from the cold selector and immediately previews its own chat before admission", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      await page.addInitScript(
        ({ key }) => localStorage.setItem(key, JSON.stringify({ sidebarAgentsMode: "chip" })),
        { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
      );
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

      await create.click();
      const dialog = page.locator(".agent-create-dialog");
      await dialog.waitFor({ state: "visible" });
      await dialog.locator('input[name="name"]').fill("New agent");
      const submit = dialog.locator('button[type="submit"]');

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
        submit.click(),
      ]);
      // This bounds automation-to-painted-preview time; it makes no provider/persistence claim.
      expect(firstPaint.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(firstPaint.elapsedMs).toBeLessThan(5_000);
      expect(firstPaint.previousPanePresented).toBe(false);
      const request = await gateway.waitForRequest("agents.create");
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
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("chat.startup")).toEqual(startupRequests);
      await selectorButton.click();
      const firstAgent = selector.locator('[data-value^="agent:"]').first();
      await expect.poll(() => firstAgent.getAttribute("data-value")).toBe(`agent:${agentId}`);
      expect(await firstAgent.textContent()).toContain("New agent");
      expect(await firstAgent.textContent()).not.toContain(agentId);
      expect(await firstAgent.getAttribute("aria-disabled")).toBe("true");
      await page.keyboard.press("Escape");
      await gateway.rejectDeferred("agents.create", {
        code: "UNAVAILABLE",
        message: "Synthetic inference unavailable",
      });
      await expect.poll(() => page.url()).toBe(originalUrl);
      await originalPane.getByText(previousMessage, { exact: true }).waitFor();
      expect(await page.locator("openclaw-pending-session-create").count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("chat.startup")).toEqual(startupRequests);
      await selectorButton.click();
      await selector.waitFor({ state: "visible" });
      expect(await selector.locator(`[data-value="agent:${agentId}"]`).count()).toBe(0);
    });
  });
});
