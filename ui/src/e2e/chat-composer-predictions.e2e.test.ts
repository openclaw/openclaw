import { expect, it } from "vitest";
import {
  createControlUiMockBootstrapConfig,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { sendChat } from "./chat-flow-fixtures.test-support.ts";
import { requireString } from "./chat-flow.test-support.ts";
import { exactButton } from "./chat-presentation.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI composer predictions" });
const suggestion = "Show me a concrete example, including the trade-offs.";

suite.define(() => {
  it("keeps predictions opt-in and accepts an undoable draft without sending", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, colorScheme: "dark" },
      async ({ page }) => {
        let enabled = false;
        const gateway = await installMockGateway(page, { deferredMethods: ["chat.predict"] });
        await page.route("**/control-ui-config.json", (route) =>
          route.fulfill({
            json: {
              ...createControlUiMockBootstrapConfig(),
              composerPredictionsEnabled: enabled,
              communityInvite: false,
            },
          }),
        );
        const textarea = page.locator(".agent-chat__composer-combobox textarea");
        const ghost = page.locator(".agent-chat__composer-prediction");
        const sendAndFinish = async () => {
          await gateway.waitForRequest("chat.startup");
          await expect.poll(() => textarea.isDisabled()).toBe(false);
          const send = await sendChat(page, gateway, "Explain the trade-offs.");
          const runId = requireString(send.idempotencyKey, "run id");
          await gateway.emitChatFinal({
            runId,
            text: "An example makes these trade-offs easier to compare.",
          });
          return runId;
        };
        await page.goto(suite.server.baseUrl + "chat");
        await sendAndFinish();
        expect(await gateway.getRequests("chat.predict")).toHaveLength(0);

        enabled = true;
        await page.reload();
        const runId = await sendAndFinish();
        const prediction = await gateway.waitForRequest("chat.predict");
        expect(prediction.params).toMatchObject({ runId });
        await gateway.resolveDeferred("chat.predict", { text: suggestion });
        await expect.poll(() => ghost.textContent()).toBe(suggestion);
        expect(await textarea.inputValue()).toBe("");
        await textarea.focus();
        await textarea.press("Tab");
        await expect.poll(() => textarea.inputValue()).toBe(suggestion);
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        await textarea.press("ControlOrMeta+z");
        await expect.poll(() => textarea.inputValue()).toBe("");
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        await gateway.deferNext("chat.predict");
        await gateway.emitChatFinal({
          runId: "mobile-prediction",
          text: "You can also continue on a smaller screen.",
        });
        await expect.poll(async () => (await gateway.getRequests("chat.predict")).length).toBe(2);
        await gateway.resolveDeferred("chat.predict", { text: suggestion });
        await expect.poll(() => ghost.textContent()).toBe(suggestion);
        await page.setViewportSize({ width: 390, height: 844 });
        await exactButton(page, "Use suggestion").click();
        await expect.poll(() => textarea.inputValue()).toBe(suggestion);
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      },
    );
  });
});
