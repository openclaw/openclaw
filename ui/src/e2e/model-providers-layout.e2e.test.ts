import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { configSnapshot } from "./model-setup-fixtures.test-support.ts";

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
    "config.get": configSnapshot(config, "models-layout"),
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
          expect(rows.every((row) => (width > 768 ? row.sideBySide : row.stacked))).toBe(true);
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
