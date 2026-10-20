// Exercise the production composer and Gateway event boundary with synthetic model output.
import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  createControlUiMockBootstrapConfig,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI composer predictions" });
const suggestion = "Show me a concrete example, including the trade-offs.";

suite.define(() => {
  it("shows the off-by-default Labs gate and all three model choices", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 1000 }, colorScheme: "dark" },
      async ({ page }) => {
        await installMockGateway(page, {
          methodResponses: {
            "config.get": {
              config: {},
              raw: "{}",
              hash: "predictions-config",
              appliedConfigHash: "predictions-config",
              configRevisionHash: "predictions-config",
              issues: [],
              valid: true,
            },
          },
        });
        await page.goto(suite.server.baseUrl + "settings/labs");
        await waitForControlUiRoute(page, { pathname: "/settings/labs", routeId: "labs" });
        const select = page.getByRole("combobox", { name: "Prediction model", exact: true });
        await expect.poll(() => select.inputValue()).toBe("utility");
        expect(await select.locator("option").allTextContents()).toEqual([
          "Utility model (recommended)",
          "Conversation model",
          "Default model",
        ]);
        const row = page.locator(".settings-row").filter({
          has: page.locator(".settings-row__title", { hasText: "Composer predictions" }),
        });
        expect(await row.getByRole("switch").isChecked()).toBe(false);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const artifacts = createControlUiE2eArtifactDir("composer-prediction-labs");
          const frame = await takeControlUiScreenshotFrame(page, row, [select], {
            animations: "disabled",
            scrollTo: row,
          });
          await writeFile(artifacts + "/labs.png", frame.png);
        }
      },
    );
  });
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
        const composer = page.locator(".agent-chat__input");
        const artifacts =
          process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
            ? createControlUiE2eArtifactDir("composer-predictions")
            : null;
        const capture = async (name: string) => {
          if (!artifacts) {
            return;
          }
          await page.mouse.move(600, 450);
          const frame = await takeControlUiScreenshotFrame(page, composer, [textarea], {
            elements: [composer],
            animations: "disabled",
          });
          await writeFile(artifacts + "/" + name + ".png", frame.png);
          await writeFile(artifacts + "/" + name + "-composer.png", frame.elements[0]!.png);
        };
        await page.goto(suite.server.baseUrl + "chat");
        await gateway.waitForRequest("chat.startup");
        await expect.poll(() => textarea.isDisabled()).toBe(false);
        await textarea.fill("Explain the trade-offs.");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const disabledSend = await gateway.waitForRequest("chat.send");
        await gateway.emitChatFinal({
          runId: (disabledSend.params as { idempotencyKey: string }).idempotencyKey,
          text: "An example makes these trade-offs easier to compare.",
        });
        expect(await gateway.getRequests("chat.predict")).toHaveLength(0);
        await capture("before");

        enabled = true;
        await page.reload();
        await gateway.waitForRequest("chat.startup");
        await expect.poll(() => textarea.isDisabled()).toBe(false);
        await textarea.fill("Explain the trade-offs.");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const send = await gateway.waitForRequest("chat.send");
        const runId = (send.params as { idempotencyKey: string }).idempotencyKey;
        await gateway.emitChatFinal({
          runId,
          text: "An example makes these trade-offs easier to compare.",
        });
        const prediction = await gateway.waitForRequest("chat.predict");
        expect(prediction.params).toMatchObject({ runId });
        await gateway.resolveDeferred("chat.predict", { text: suggestion });
        await expect.poll(() => ghost.textContent()).toBe(suggestion);
        expect(await textarea.inputValue()).toBe("");
        await capture("after");
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
        await capture("mobile");
        await page.getByRole("button", { name: "Use suggestion", exact: true }).click();
        await expect.poll(() => textarea.inputValue()).toBe(suggestion);
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      },
    );
  });
});
