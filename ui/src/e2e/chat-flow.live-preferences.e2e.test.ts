import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { selectChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Live chat preferences" });

suite.define(() => {
  it("saves model and reasoning while the admitted reply continues", async () => {
    await suite.withPage({ viewport: { width: 1200, height: 853 } }, async ({ page }) => {
      const key = "agent:main:live-preferences";
      const levels = [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ];
      const row = {
        key,
        sessionId: "live-preferences",
        kind: "direct",
        updatedAt: 1,
        model: "example-a",
        modelProvider: "example",
        modelOverrideSource: "user",
        thinkingLevel: "low",
        thinkingDefault: "low",
        thinkingLevels: levels,
      };
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        agentModel: "example/example-a",
        sessions: [row],
        models: ["a", "b"].map((id) => ({
          id: "example-" + id,
          name: "Example " + id.toUpperCase(),
          provider: "example",
          thinkingLevels: levels,
          thinkingDefault: "low",
          supportsFastMode: true,
        })),
        methodResponses: {
          "sessions.list": {
            ts: 1,
            path: "",
            count: 1,
            defaults: {
              model: "example-a",
              modelProvider: "example",
              thinkingLevels: levels,
              thinkingDefault: "low",
            },
            sessions: [row],
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      await page
        .locator(".agent-chat__composer-combobox textarea")
        .fill("Keep explaining the garden plan.");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const send = await gateway.waitForRequest("chat.send");
      const runId = (send.params as { idempotencyKey: string }).idempotencyKey;
      const emitText = (text: string) =>
        gateway.emitGatewayEvent("chat", {
          sessionKey: key,
          runId,
          state: "delta",
          message: { role: "assistant", content: [{ type: "text", text }] },
        });
      await emitText("The first reply is still running.");
      await page
        .locator(".chat-bubble")
        .getByText("The first reply is still running.", { exact: true })
        .waitFor();
      const main = page.getByRole("main");
      const model = main.locator("[data-chat-model-select]");
      const effort = main.locator("[data-chat-thinking-select]");
      await gateway.deferNext("sessions.patch");
      await model.click();
      await selectChatModelOption(main.locator('[data-chat-model-option="example/example-b"]'));
      expect((await gateway.waitForRequest("sessions.patch")).params).toMatchObject({
        key,
        model: "example/example-b",
      });
      await expect.poll(() => model.textContent()).toContain("Example B");
      expect(await effort.getAttribute("aria-disabled")).toBe("true");
      await gateway.resolveDeferred("sessions.patch");
      await expect.poll(() => effort.getAttribute("aria-disabled")).toBe("false");
      // Execution metadata belongs to the existing run, not the preference selector.
      const saved = await gateway.getSessionRow(key);
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: key,
        runId,
        phase: "model",
        agentId: "main",
        session: {
          ...saved,
          hasActiveRun: true,
          activeRunIds: [runId],
          activeModel: "example-a",
          activeModelProvider: "example",
          updatedAt: Date.now(),
        },
      });
      await effort.click();
      const slider = main.locator("[data-chat-thinking-slider]");
      // The mounted slider is enabled before the popup can receive keyboard focus.
      await expect.poll(() => slider.isVisible()).toBe(true);
      await expect.poll(() => slider.isEnabled()).toBe(true);
      expect(await main.locator("[data-chat-speed-option=on]").isDisabled()).toBe(true);
      await slider.press("End");
      const thinking = await gateway.waitForRequest("sessions.patch", { after: 1 });
      expect(thinking.params).toMatchObject({ key, thinkingLevel: "high" });
      await emitText(
        "The first reply is still running. Its next chunk arrived after the settings changed.",
      );
      await page
        .locator(".chat-bubble")
        .getByText(/Its next chunk arrived after the settings changed/)
        .waitFor();
      await expect.poll(() => model.textContent()).toContain("Example B");
      await expect.poll(() => effort.textContent()).toContain("High");
      expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      expect(await page.getByRole("button", { name: "Stop generating", exact: true }).count()).toBe(
        1,
      );
      await gateway.emitChatFinal({ runId, text: "The first reply finished normally." });
      await page
        .locator(".chat-bubble")
        .getByText("The first reply finished normally.", { exact: true })
        .waitFor();
      await expect.poll(() => model.textContent()).toContain("Example B");
    });
  });
});
