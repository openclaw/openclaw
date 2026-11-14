import fs from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.js";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.js";
import {
  createModelChatUpstream,
  createModelGatewayFixture,
} from "./model-gateway.test-support.ts";
import { expandProvider } from "./model-providers.test-support.ts";

// Removing the provider behind the default model keeps the default (documented logout
// contract), so the confirmation has to say so, and later chats must fail without
// reaching the provider unauthenticated.
const chatRequests: { hasAuth: boolean }[] = [];
const fixture = createModelGatewayFixture({
  name: "Remove the provider behind the default model",
  instanceName: "model-provider-remove-in-use",
  createUpstream: () => createModelChatUpstream("hy4", chatRequests),
  config: (base) => ({
    gateway: { controlUi: { enabled: true } },
    agents: { entries: { main: {} }, defaults: { model: "tencent-tokenhub/hy4" } },
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

async function savedDefault() {
  return JSON.parse(await fs.readFile(fixture.instance.configPath, "utf8")).agents?.defaults?.model;
}

suite.define(() => {
  it("warns before removing the default model's provider and never chats unauthenticated", async () => {
    const artifacts = createControlUiE2eArtifactDir("model-provider-remove-in-use");
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        await page.goto(await open("settings/model-providers"));
        await waitForControlUiGatewayReady(page);
        await page.getByRole("button", { name: "Add account", exact: true }).first().click();
        const picker = page.getByRole("dialog", { name: "Add an account" });
        await picker.getByRole("searchbox", { name: "Search providers…" }).fill("Tencent");
        await picker.getByRole("button", { name: "Tencent TokenHub" }).click();
        const form = page.getByRole("dialog", { name: "Add provider" });
        await form.getByRole("textbox", { name: "API key" }).fill("sk-synthetic-remove-in-use");
        await form.getByRole("button", { name: "Save provider", exact: true }).click();
        await expect.poll(() => form.isVisible(), { timeout: 30_000 }).toBe(false);

        const chat = async (message: string) => {
          await page.goto(await open("new"));
          await waitForControlUiGatewayReady(page);
          await page.locator(".new-session-page__message").fill(message);
          await page.getByRole("button", { name: "Start session", exact: true }).click();
        };
        await chat("First message");
        await page.getByText("pong", { exact: true }).last().waitFor({ timeout: 60_000 });
        expect(chatRequests.length).toBeGreaterThan(0);

        await page.goto(await open("settings/model-providers"));
        await waitForControlUiGatewayReady(page);
        const row = await expandProvider(page, "tencent-tokenhub");
        await row
          .getByRole("button", { name: "Remove provider: Tencent TokenHub", exact: true })
          .click();
        const dialog = page.locator("openclaw-modal-dialog");
        const confirm = dialog.getByRole("button", { name: "Remove provider", exact: true });
        await confirm.waitFor();
        const shot = async (name: string, content: Locator) => {
          // Capture settled frames, not the dialog's entry fade.
          await page.waitForFunction(() =>
            document
              .getAnimations()
              .every(
                (animation) =>
                  animation.playState !== "running" ||
                  animation.effect?.getTiming().iterations === Infinity,
              ),
          );
          await fs.writeFile(
            path.join(artifacts, name),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [content]),
          );
        };
        await shot("confirm.png", confirm);
        expect(await dialog.textContent()).toMatch(/Defaults for all agents keep using \S*hy4/i);
        await confirm.click();

        // The saved account is gone; the default stays selected and the page asks for a model.
        await expect
          .poll(
            () =>
              page
                .getByRole("button", { name: "Remove provider: Tencent TokenHub", exact: true })
                .count(),
            { timeout: 30_000 },
          )
          .toBe(0);
        const required = page.getByText("Model required", { exact: true });
        await required.waitFor();
        await expect.poll(() => page.getByText("Checking models…").count()).toBe(0);
        await shot("after-remove.png", required);
        expect(await savedDefault()).toBe("tencent-tokenhub/hy4");

        const sent = chatRequests.length;
        await chat("Second message");
        await page.getByText("Couldn’t finish this reply").waitFor({ timeout: 60_000 });
        expect(chatRequests.slice(sent)).toEqual([]);
        expect(chatRequests.every((request) => request.hasAuth)).toBe(true);
      },
    );
  });
});
