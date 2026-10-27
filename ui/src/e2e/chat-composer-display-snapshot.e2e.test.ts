import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Cached composer display reconciliation" });

suite.define(() => {
  it("restores disabled composer facts before hello, then accepts changed and cleared live settings", async () => {
    await suite.withPage(
      { viewport: { width: 1719, height: 1000 }, serviceWorkers: "block" },
      async ({ page }) => {
        const sessionKey = "agent:main:chat:aabbccdd-1234-4321-9876-123456789abc";
        const text = "The synthetic conversation stays in place while its settings refresh.";
        const cached = createControlUiSessionRow(sessionKey, "Cached composer example", 1, {
          model: "reasoning-example",
          modelProvider: "example",
          modelOverrideSource: "user",
          thinkingLevel: "high",
          permissionMode: "full",
        });
        const thinkingLevels = [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ];
        const gateway = await installMockGateway(page, {
          sessionKey,
          authMethod: "trusted-proxy",
          authMode: "trusted-proxy",
          deferredMethods: ["connect"],
          agentModel: "example/reasoning-example",
          sessions: [cached],
          historyMessages: [{ role: "assistant", content: text }],
          models: [
            {
              id: "reasoning-example",
              name: "Reasoning example",
              provider: "example",
              reasoning: true,
              thinkingDefault: "medium",
              thinkingLevels,
            },
            {
              id: "alternate-example",
              name: "Alternate example",
              provider: "example",
              reasoning: true,
              thinkingDefault: "medium",
              thinkingLevels,
            },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        await page.getByText(text, { exact: true }).waitFor();
        const pane = page.locator(".chat-pane-cache__pane--active");
        const model = pane.locator("[data-chat-model-select]");
        const effort = pane.locator("[data-chat-thinking-select]");
        const permission = pane.locator("[data-chat-permission-select]");
        const flushSnapshot = () =>
          page.evaluate(async () => {
            const active = document.querySelector(".chat-pane-cache__pane--active");
            await Reflect.get(active!, "sessionSnapshotStore").flush();
          });
        await expect.poll(() => model.getAttribute("aria-disabled")).toBe("false");
        await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("high");
        await flushSnapshot();

        const live = {
          ...cached,
          updatedAt: 2,
          model: "alternate-example",
          thinkingLevel: "low",
          permissionMode: "workspace",
        };
        await gateway.setSessionsListResponse({ sessions: [live] });
        await gateway.setMethodResponse("sessions.describe", { session: live });
        await page.reload();
        await gateway.waitForRequest("connect");
        await page.getByText(text, { exact: true }).waitFor();
        await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("high");
        expect(await model.textContent()).toContain("Reasoning example");
        expect(await model.getAttribute("aria-busy")).toBe("false");
        expect(await model.getAttribute("aria-disabled")).toBe("true");
        expect(await effort.getAttribute("aria-disabled")).toBe("true");
        expect(await permission.getAttribute("data-chat-select-value")).toBe("full");
        expect(await permission.isDisabled()).toBe(true);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);

        await gateway.resolveDeferred("connect");
        await expect
          .poll(() => model.getAttribute("data-chat-select-value"))
          .toBe("example/alternate-example");
        await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("low");
        await expect
          .poll(() => permission.getAttribute("data-chat-select-value"))
          .toBe("workspace");
        await expect.poll(() => permission.isEnabled()).toBe(true);
        await flushSnapshot();

        const cleared = {
          ...cached,
          updatedAt: 3,
          modelOverrideSource: null,
          thinkingLevel: undefined,
          permissionMode: undefined,
        };
        await gateway.setSessionsListResponse({ sessions: [cleared] });
        await gateway.setMethodResponse("sessions.describe", { session: cleared });
        await page.reload();
        await gateway.waitForRequest("connect");
        await page.getByText(text, { exact: true }).waitFor();
        await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("low");
        expect(await permission.getAttribute("data-chat-select-value")).toBe("workspace");
        expect(await permission.isDisabled()).toBe(true);
        await gateway.resolveDeferred("connect");
        await expect.poll(() => model.textContent()).toContain("Reasoning example");
        await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("");
        await expect.poll(() => effort.textContent()).toContain("Medium");
        await expect.poll(() => permission.getAttribute("data-chat-select-value")).toBe("");
        await expect.poll(() => permission.isEnabled()).toBe(true);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });
});
