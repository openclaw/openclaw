import path from "node:path";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import {
  createControlUiMockBootstrapConfig,
  installControlUiMockBootstrapDocument,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Document UI preferences",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("paints document preferences before hello, skips boot reads, and refreshes a sibling-tab change", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const profileId = "synthetic-bootstrap-operator";
        const config = {
          ui: { prefs: { locale: "de", themeMode: "dark" } },
          tts: null as { maxTextLength: number } | null,
        };
        const entries = {
          "ui.theme": "claw",
          "ui.themeMode": "light",
          "ui.railShortcuts": ["route:agents-home"],
        };
        const scenario = {
          authMethod: "trusted-proxy" as const,
          authMode: "trusted-proxy" as const,
          awaitInitialRoster: false,
          heldMethods: ["connect"],
          presenceUsers: [{ id: profileId, self: true }],
          historyMessages: [{ role: "assistant", content: "Synthetic speech preview." }],
          featureMethods: [...defaultControlUiFeatureMethods, "config.get", "tts.speak"],
          methodResponses: {
            "config.get": { config, runtimeConfig: config, hash: "synthetic-config" },
            "users.prefs.get": { status: "ok", entries },
          },
        };
        const gateway = await installMockGateway(page, scenario);
        const bootstrap = {
          ...createControlUiMockBootstrapConfig(scenario),
          preferences: { profileId, config, entries },
        };
        await page.route("**/control-ui-config.json", (route) =>
          route.fulfill({ json: bootstrap }),
        );
        await installControlUiMockBootstrapDocument(page, bootstrap);
        await page.goto(`${suite.server.baseUrl}chat/main/dashboard/synthetic-preferences`);
        await gateway.waitForRequest("connect");
        await page.locator("html[data-theme-mode='light']").waitFor();
        await page.locator("html[lang='de']").waitFor();
        expect(await gateway.getRequests("config.get")).toHaveLength(0);
        expect(await gateway.getRequests("users.prefs.get")).toHaveLength(0);
        await page.screenshot({ path: path.join(suite.artifactDir, "before-hello.png") });
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("chat.startup");
        await page.locator(".agent-chat__composer-combobox textarea").waitFor();
        await page.getByText("Synthetic speech preview.", { exact: true }).waitFor();
        const readAloud = page.locator(".chat-read-aloud-btn");
        expect(await readAloud.count()).toBe(0);
        expect(await gateway.getRequests("config.get")).toHaveLength(0);
        expect(await gateway.getRequests("users.prefs.get")).toHaveLength(0);
        await gateway.setMethodResponse("users.prefs.get", {
          status: "ok",
          entries: { ...entries, "ui.themeMode": "dark" },
        });
        await gateway.emitGatewayEvent("users.prefs.changed", { profileId });
        await gateway.waitForRequest("users.prefs.get");
        await page.locator("html[data-theme-mode='dark']").waitFor();
        expect(await evaluateControlUiContext(page, (app) => app.theme.settings.themeMode)).toBe(
          "dark",
        );
        config.tts = { maxTextLength: 4096 };
        await gateway.emitGatewayEvent("config.changed", {});
        await readAloud.waitFor({ state: "attached" });
        expect(await gateway.getRequests("config.get")).toHaveLength(0);
        config.tts = null;
        await gateway.emitGatewayEvent("config.changed", {});
        await readAloud.waitFor({ state: "detached" });
        expect(await gateway.getRequests("config.get")).toHaveLength(0);
      },
    );
  });
});
