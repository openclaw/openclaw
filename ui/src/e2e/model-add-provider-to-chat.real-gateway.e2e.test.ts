import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.js";
import {
  createModelChatUpstream,
  createModelGatewayFixture,
} from "./model-gateway.test-support.ts";

// A first-run agent has no model. Adding a provider's API key from Models must end in a chat
// that answers, without a detour through Set up a model.
const chatRequests: { hasAuth: boolean }[] = [];
const fixture = createModelGatewayFixture({
  name: "Adding the first provider ends in a working chat",
  instanceName: "model-add-provider-to-chat",
  createUpstream: () => createModelChatUpstream("hy4-preview", chatRequests),
  config: (base) => ({
    gateway: { controlUi: { enabled: true } },
    agents: { entries: { main: {} } },
    plugins: { allow: ["tencent"] },
    models: {
      providers: {
        // No inline model list: a listed loopback endpoint is a keyless local server.
        "tencent-tokenhub": {
          baseUrl: `${base}/v1`,
          api: "openai-completions",
        },
      },
    },
  }),
});
const { suite, open } = fixture;

suite.define(() => {
  it("adds a key, activates its model and chats from the add dialog", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        await page.goto(await open("settings/model-providers"));
        await waitForControlUiGatewayReady(page);
        await page.locator('[data-model-readiness="model-required"]').waitFor();
        expect(await page.locator(".page-subtitle").first().textContent()).toContain(
          "Global model defaults and provider access for your agents.",
        );

        let clicks = 0;
        const started = Date.now();
        await page.getByRole("button", { name: "Add account", exact: true }).first().click();
        clicks++;
        const picker = page.getByRole("dialog", { name: "Add an account" });
        await picker.getByRole("searchbox", { name: "Search providers…" }).fill("Tencent");
        await picker.getByRole("button", { name: "Tencent TokenHub" }).click();
        clicks++;
        const form = page.getByRole("dialog", { name: "Add provider" });
        // A provider with config still shows its display name, not its config id.
        expect((await form.locator(".oc-dialog__title").textContent())?.trim()).toBe(
          "Tencent TokenHub",
        );
        await form.getByRole("textbox", { name: "API key" }).fill("sk-synthetic-first-provider");
        await form.getByRole("button", { name: "Save provider", exact: true }).click();
        clicks++;

        // The dialog ends on a model that passed the same check as Test & use.
        const startChat = form.getByRole("button", { name: /^Start a new chat with / });
        await startChat.waitFor({ timeout: 30_000 });
        expect(await form.textContent()).toContain("is ready to chat.");
        const config = JSON.parse(await fs.readFile(fixture.instance.configPath, "utf8"));
        expect(JSON.stringify(config.agents)).toContain("tencent-tokenhub/hy4-preview");

        await startChat.click();
        clicks++;
        await page.waitForURL((url) => !url.pathname.includes("settings"), { timeout: 30_000 });
        expect(page.url()).not.toContain("model-setup");
        await page.getByRole("textbox", { name: "Chat composer", exact: true }).fill("Hello");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await page
          .locator(".chat-group.assistant .chat-bubble")
          .getByText("pong", { exact: true })
          .first()
          .waitFor({ timeout: 30_000 });
        const elapsed = Date.now() - started;
        console.log(`[add-to-chat] key to reply ${elapsed} ms, ${clicks} clicks before typing`);
        expect(clicks).toBeLessThanOrEqual(4);
        expect(chatRequests.length).toBeGreaterThan(0);
        expect(chatRequests.every((request) => request.hasAuth)).toBe(true);
      },
    );
  });
});
