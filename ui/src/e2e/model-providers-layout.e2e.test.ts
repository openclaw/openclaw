import { expect, it } from "vitest";
import { sourceConfigSnapshot } from "../lib/config/config-snapshot.test-support.ts";
import { installMockGateway, pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Models settings layout and discovery" });

const models = [
  { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
  { id: "gpt-5-mini", name: "GPT-5 mini", provider: "openai", available: true },
];
const config = {
  agents: { defaults: { model: "openai/gpt-5.5", decisionModel: "typesafe/jev-latest" } },
};
const catalog = {
  models,
  decisionModels: [{ provider: "typesafe", id: "jev-latest", name: "Jev", pluginId: "typesafe" }],
  defaultModels: { automaticUtilityModel: "openai/gpt-5-mini" },
};
const gatewayScenario = {
  models,
  methodResponses: {
    "agents.list": {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        {
          id: "main",
          name: "Research and engineering assistant",
          identity: { emoji: "🦞" },
        },
        { id: "work", name: "Work" },
      ],
    },
    "config.get": sourceConfigSnapshot(config, "models-layout"),
    "models.list": catalog,
    "models.authStatus": {
      ts: Date.now(),
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          status: "ok",
          profiles: [
            {
              profileId: "openai:alex",
              type: "oauth",
              status: "ok",
              email: "alex@example.com",
            },
          ],
        },
      ],
    },
    "usage.status": { updatedAt: Date.now(), providers: [] },
    "sessions.usage": { aggregates: { byProvider: [] } },
  },
};

suite.define(() => {
  it("keeps phone discovery feedback readable after a defaults acknowledgement", async () => {
    await suite.withPage(
      { locale: "en-US", colorScheme: "light", viewport: { width: 390, height: 844 } },
      async ({ page }) => {
        await page.clock.install();
        const gateway = await installMockGateway(page, gatewayScenario);
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        const primary = page.locator(".model-providers__defaults .picker-select__trigger").first();
        await primary.waitFor();
        const before = await primary.boundingBox();
        await gateway.setMethodResponse("models.list", {
          ...catalog,
          pendingProviders: ["openai"],
        });
        await gateway.emitGatewayEvent("chat.metadata.changed", {});
        const progress = page.locator('.model-providers__catalog-progress[role="status"]');
        await progress.waitFor();
        await pauseVirtualClock(page);
        const pending = await primary.boundingBox();
        await gateway.deferNext("config.patch");
        await primary.click();
        await page.getByRole("option", { name: /GPT-5 mini/ }).click();
        await gateway.waitForRequest("config.patch");
        const savedConfig = { agents: { defaults: { model: "openai/gpt-5-mini" } } };
        await gateway.setMethodResponse("config.get", sourceConfigSnapshot(savedConfig, "saved"));
        await gateway.resolveDeferred("config.patch", {
          ok: true,
          config: savedConfig,
          hash: "saved",
        });
        await page
          .getByText("Saved. Looking for more models in the background…", { exact: true })
          .waitFor();
        const heading = page.getByRole("heading", { name: "Defaults for all agents", exact: true });
        const textBounds = (element: Element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getBoundingClientRect().toJSON();
        };
        const title = await heading.evaluate(textBounds);
        const feedback = await progress.locator("span").last().evaluate(textBounds);
        expect(
          title.right <= feedback.left ||
            feedback.right <= title.left ||
            title.bottom <= feedback.top ||
            feedback.bottom <= title.top,
        ).toBe(true);
        const surface = await progress.boundingBox();
        expect(surface).not.toBeNull();
        expect(feedback.left).toBeGreaterThanOrEqual(surface!.x);
        expect(feedback.right).toBeLessThanOrEqual(surface!.x + surface!.width);
        expect(await primary.boundingBox()).toEqual(before);
        expect(pending).toEqual(before);
        expect(await primary.isEnabled()).toBe(true);
        expect(await gateway.getRequests("config.patch")).toHaveLength(1);
        await page.clock.resume();
        await gateway.setMethodResponse("models.list", catalog);
        await gateway.emitGatewayEvent("chat.metadata.changed", {});
        await progress.waitFor({ state: "detached" });
        expect(await primary.boundingBox()).toEqual(before);
      },
    );
  });
  it.each([1440, 1100, 768, 640, 390])(
    "Models page keeps controls separate during discovery at %ipx",
    async (width) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width, height: 1000 } },
        async ({ page }) => {
          const gateway = await installMockGateway(page, gatewayScenario);
          await page.goto(`${suite.server.baseUrl}settings/model-providers`);
          const primary = page.getByRole("button", { name: /^Model: GPT-5.5/ });
          await primary.waitFor();
          expect(await primary.textContent()).not.toContain("alex@example.com");
          expect(await primary.locator(".picker-select__description").count()).toBe(0);
          const rows = await page
            .locator(".model-providers__defaults .settings-row")
            .evaluateAll((elements) =>
              elements.map((row) => {
                const label = row.querySelector(".settings-row__text")!.getBoundingClientRect();
                const control = row
                  .querySelector(".settings-row__control")!
                  .getBoundingClientRect();
                return {
                  sideBySide: label.right <= control.left && label.bottom > control.top,
                  stacked: label.bottom <= control.top,
                };
              }),
            );
          expect(rows.every((row) => (width > 640 ? row.sideBySide : row.stacked))).toBe(true);
          await page
            .locator(".settings-sidebar openclaw-agent-select")
            .waitFor({ state: "attached" });
          expect(await page.locator(".content openclaw-agent-select").count()).toBe(0);
          expect(await page.locator(".settings-sidebar openclaw-agent-select").count()).toBe(1);
          const bounds = await page
            .locator("[data-models-connect], .model-providers__refresh-button")
            .evaluateAll((buttons) =>
              buttons.map((button) => {
                const { x, y, width: buttonWidth, height } = button.getBoundingClientRect();
                return { x, y, width: buttonWidth, height };
              }),
            );
          expect(bounds).toHaveLength(2);
          for (const [index, box] of bounds.entries()) {
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(width);
            for (const other of bounds.slice(index + 1)) {
              const overlaps =
                box.x < other.x + other.width &&
                other.x < box.x + box.width &&
                box.y < other.y + other.height &&
                other.y < box.y + box.height;
              expect(overlaps).toBe(false);
            }
          }
          await primary.scrollIntoViewIfNeeded();
          const beforeDiscovery = await primary.boundingBox();
          await primary.click();
          await page.locator('.model-providers__defaults [role="listbox"]').first().waitFor();
          await gateway.setMethodResponse("models.list", {
            ...catalog,
            pendingProviders: ["openai"],
          });
          await gateway.emitGatewayEvent("chat.metadata.changed", {});
          const progress = page.locator('.model-providers__catalog-progress[role="status"]');
          await progress.waitFor();
          expect(await primary.boundingBox()).toEqual(beforeDiscovery);
          expect(await progress.locator('[aria-hidden="true"]').count()).toBe(1);
          await page.keyboard.press("Escape");
        },
      );
    },
  );
});
