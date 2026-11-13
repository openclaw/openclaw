import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { modelPicker } from "./chat-runtime-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Claude native login model badge" });

suite.define(() => {
  it.each([false, true])(
    "labels Claude CLI native login separately from the direct API sibling (API configured: %s)",
    async (apiConfigured) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const models = [
          {
            id: "claude-sonnet-4-5",
            name: "Claude Sonnet 4.5",
            provider: "anthropic",
            available: true,
            agentRuntime: { id: "claude-cli", source: "model" as const },
          },
          {
            id: "claude-haiku-4-5",
            name: "Claude Haiku 4.5",
            provider: "anthropic",
            available: true,
            agentRuntime: { id: "openclaw", source: "model" as const },
          },
        ];
        // Synthetic status metadata, not a live signed-in Claude account.
        await installMockGateway(page, {
          agentModel: "anthropic/claude-sonnet-4-5",
          models,
          methodResponses: {
            "models.authStatus": {
              ts: 1,
              providers: [
                {
                  provider: "claude-cli",
                  displayName: "Claude CLI",
                  status: "ok",
                  profiles: [],
                  nativeAuth: { kind: "subscription" },
                },
                ...(apiConfigured
                  ? [
                      {
                        provider: "anthropic",
                        displayName: "Claude",
                        status: "static",
                        profiles: [],
                        apiKey: { source: "config" },
                      },
                    ]
                  : []),
              ],
            },
          },
          sessionInfo: { model: "claude-sonnet-4-5", modelProvider: "anthropic" },
        });
        await page.goto(suite.server.baseUrl + "chat");
        const { picker, trigger } = modelPicker(page);
        await trigger.click();
        const native = picker.locator('[data-chat-model-provider-group="claude-cli"]');
        const api = picker.locator('[data-chat-model-provider-group="anthropic"]');
        await native.waitFor({ state: "visible" });
        await api.waitFor({ state: "visible" });
        const menu = picker.locator("[data-anchored-overlay]");
        const frame = await takeControlUiScreenshotFrame(
          page,
          menu,
          [
            native.locator(".chat-controls__provider-heading"),
            api.locator(".chat-controls__provider-heading"),
          ],
          {
            animations: "disabled",
            elements: [menu],
          },
        );
        await writeFile(
          suite.artifactDir + (apiConfigured ? "/picker-with-api.png" : "/picker-native-only.png"),
          frame.png,
        );
        await writeFile(
          suite.artifactDir +
            (apiConfigured ? "/picker-with-api-crop.png" : "/picker-native-only-crop.png"),
          frame.elements[0]!.png,
        );
        await expect
          .poll(() => native.locator(".chat-controls__auth-meta-label").allTextContents())
          .toEqual(["Subscription"]);
        expect(await native.locator("[data-auth-kind]").getAttribute("data-auth-kind")).toBe(
          "subscription",
        );
        if (apiConfigured) {
          expect(await api.locator(".chat-controls__auth-meta-label").textContent()).toBe("API");
        } else {
          expect(await api.locator(".chat-controls__auth-meta-label").count()).toBe(0);
        }
      });
    },
  );
});
