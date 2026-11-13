import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { buildControlUiResourcePath } from "../../../src/gateway/control-ui-resource-routes.js";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Custom provider presentation" });
const customProvider = "rtx-pro-workstation";
const assetPath =
  buildControlUiResourcePath("providerIcon", undefined, customProvider) + "?v=synthetic";
const missingPath =
  buildControlUiResourcePath("providerIcon", undefined, "unavailable") + "?v=synthetic";
const providers = [customProvider, "rack-node", "lab-inference", "openai"] as const;
const presentations = {
  [customProvider]: {
    providerName: "Workstation",
    providerIcon: { source: "asset", url: assetPath },
  },
  "rack-node": { providerName: "Rack Server", providerIcon: { source: "builtin", name: "server" } },
  "lab-inference": {
    providerName: "Research Lab",
    providerIcon: { source: "asset", url: missingPath },
  },
  openai: { providerName: "Shared OpenAI", providerIcon: { source: "asset", url: missingPath } },
} as const;

suite.define(() => {
  it.each(["before", "after"] as const)(
    "renders %s provider identity without changing model references",
    async (stage) => {
      await suite.withPage(
        { locale: "en-US", colorScheme: "dark", viewport: { width: 1440, height: 1100 } },
        async ({ page }) => {
          // Synthetic PNG artwork is drawn by the browser; no new imaging dependency.
          const imageData = await page.evaluate(() => {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 128;
            const context = canvas.getContext("2d");
            if (!context) {
              throw new Error("Canvas rendering is unavailable");
            }
            context.fillStyle = "#3879df";
            context.fillRect(0, 0, 128, 128);
            context.fillStyle = "#eef7ff";
            context.fillRect(22, 25, 84, 59);
            context.fillRect(60, 84, 8, 17);
            context.fillRect(42, 99, 44, 8);
            context.fillStyle = "#133960";
            context.fillRect(29, 32, 70, 44);
            context.fillStyle = "#ffc56e";
            context.beginPath();
            context.arc(64, 54, 16, 0, Math.PI * 2);
            context.fill();
            return canvas.toDataURL("image/png").split(",")[1]!;
          });
          const artworkBuffer = Buffer.from(imageData, "base64");
          await page.route("**" + assetPath, async (route) => {
            expect(route.request().headers().authorization).toBe("Bearer e2e-device-token");
            await route.fulfill({ status: 200, contentType: "image/png", body: artworkBuffer });
          });
          await page.route("**" + missingPath, async (route) => {
            expect(route.request().headers().authorization).toBe("Bearer e2e-device-token");
            await route.fulfill({ status: 404, body: "Unavailable" });
          });
          const models = providers.map((provider, index) => ({
            provider,
            id: "model-" + index,
            name: ["Local Llama", "Compute Model", "Research Model", "GPT Model"][index]!,
            available: true,
            ...(stage === "after" ? presentations[provider] : {}),
          }));
          const gateway = await installMockGateway(page, {
            models,
            methodResponses: {
              "models.list": {
                models,
                ...(stage === "after" ? { providerPresentations: presentations } : {}),
              },
              "models.authStatus": {
                ts: 1,
                providers: providers.map((provider) => ({
                  provider,
                  status: "ok",
                  profiles: [],
                  apiKey: { source: "config" },
                })),
              },
              "usage.status": { updatedAt: 1, providers: [] },
            },
          });
          await page.goto(
            suite.server.baseUrl + "settings/model-providers#token=synthetic-provider-artwork",
          );
          await waitForControlUiRoute(page, {
            pathname: "/settings/model-providers",
            routeId: "model-providers",
          });
          const row = page.locator('[data-provider-id="' + customProvider + '"]');
          const label = stage === "after" ? "Workstation" : "Rtx Pro Workstation";
          await row.getByText(label, { exact: true }).waitFor({ state: "visible" });
          await expect.poll(() => page.locator(".provider-row[data-provider-id]").count()).toBe(4);
          if (stage === "after") {
            await expect.poll(() => row.locator("img").count()).toBe(1);
            await expect
              .poll(() =>
                row
                  .locator("img")
                  .evaluateAll((images) =>
                    images.every(
                      (image) =>
                        image instanceof HTMLImageElement &&
                        image.complete &&
                        image.naturalWidth > 0,
                    ),
                  ),
              )
              .toBe(true);
            expect(
              await page.locator('[data-provider-id="rack-node"] svg').count(),
            ).toBeGreaterThan(0);
            await expect
              .poll(() =>
                page
                  .locator('[data-provider-id="lab-inference"] .provider-brand-icon')
                  .textContent(),
              )
              .toBe("R");
            expect(
              await page
                .locator('[data-provider-id="openai"] [data-provider-icon="codex"]')
                .count(),
            ).toBe(1);
          }
          if (process.env.OPENCLAW_PROVIDER_PRESENTATION_CAPTURE === "1") {
            await writeFile(
              path.join(suite.artifactDir, "provider-settings-" + stage + ".png"),
              await page.screenshot({ fullPage: true, animations: "disabled" }),
            );
          }
          await page.goto(suite.server.baseUrl + "chat");
          await gateway.waitForRequest("models.list");
          const picker = page.locator("details.chat-controls__model-picker");
          await picker.locator("summary").click();
          await page.getByText(label, { exact: true }).first().waitFor({ state: "visible" });
          await page
            .locator(
              '[data-chat-model-provider-group="' +
                customProvider +
                '"] .chat-controls__provider-toggle',
            )
            .click();
          const option = page.locator('[data-chat-model-option="' + customProvider + '/model-0"]');
          expect(await option.count()).toBeGreaterThan(0);
          if (process.env.OPENCLAW_PROVIDER_PRESENTATION_CAPTURE === "1") {
            await writeFile(
              path.join(suite.artifactDir, "provider-picker-" + stage + ".png"),
              await page.screenshot({ fullPage: true, animations: "disabled" }),
            );
          }
        },
      );
    },
  );
});
