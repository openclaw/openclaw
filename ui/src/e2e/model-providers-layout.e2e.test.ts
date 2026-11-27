import { expect, it } from "vitest";
import { sourceConfigSnapshot } from "../lib/config/config-snapshot.test-support.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
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
  it.each([
    [390, 844],
    [820, 1180],
    [1180, 820],
    [1440, 900],
  ])(
    "shows both runtime names in the picker and the saved fallback at %i × %i",
    async (width, height) => {
      await suite.withPage(
        { viewport: { width, height }, isMobile: width === 390, hasTouch: true, locale: "en-US" },
        async ({ page }) => {
          const name = "Studio documentation review extended context";
          const ref = "openai/studio-review";
          const entry = {
            ...models[0],
            id: "studio-review",
            name,
            defaultModelRuntimes: {
              base: { agentRuntime: { id: "openclaw", source: "model" }, available: true },
              alternatives: [{ agentRuntime: { id: "codex", source: "model" }, available: true }],
            },
          };
          const saved = {
            agents: {
              defaults: {
                ...config.agents.defaults,
                model: { primary: "openai/gpt-5.5", fallbacks: [ref] },
                models: { [ref]: { agentRuntime: { id: "codex" } } },
              },
            },
          };
          const gw = await installMockGateway(page, {
            ...gatewayScenario,
            methodResponses: {
              ...gatewayScenario.methodResponses,
              "models.list": { ...catalog, models: [...models, entry] },
              "config.patch": { ok: true, config: saved, hash: "saved" },
            },
          });
          await page.goto(suite.server.baseUrl + "settings/model-providers");
          const defaults = page.locator(".model-providers__defaults");
          const trigger = defaults.getByRole("button", { name: /^Fallback model:/ });
          await trigger.tap();
          const list = defaults.getByRole("listbox");
          const variants = list.getByRole("option").filter({ hasText: name });
          await expect.poll(() => variants.count()).toBe(2);
          for (const [i, runtime] of ["OpenClaw", "Codex"].entries()) {
            const label = variants.nth(i).locator(".picker-select__split-label");
            expect(await label.getAttribute("title")).toBe(name + " · " + runtime);
            const tail = label.locator("span").last();
            expect((await tail.textContent())?.trim()).toBe("· " + runtime);
            expect(await label.evaluate((e) => e.getBoundingClientRect().height)).toBeLessThan(25);
            expect(
              await label.evaluate(
                (e) =>
                  e.lastElementChild!.getBoundingClientRect().right <=
                  e.getBoundingClientRect().right + 1,
              ),
            ).toBe(true);
          }
          const overflow = (el: Element) => el.scrollWidth - el.clientWidth;
          expect(
            await variants
              .locator(".picker-select__label")
              .evaluateAll((els) => els.map((el) => el.scrollWidth - el.clientWidth)),
          ).toEqual([0, 0]);
          await gw.setMethodResponse("config.get", sourceConfigSnapshot(saved, "saved"));
          await variants.filter({ hasText: "Codex" }).tap();
          await gw.waitForRequest("config.patch");
          await expect.poll(() => trigger.textContent()).toContain(name + " · Codex");
          expect(await trigger.locator(".picker-select__label").evaluate(overflow)).toBe(0);
          expect(await trigger.locator(".picker-select__split-label").getAttribute("title")).toBe(
            name + " · Codex",
          );
        },
      );
    },
  );
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
          const moreSettings = page.locator("[data-models-more-settings]");
          if ((await moreSettings.getAttribute("aria-expanded")) !== "true") {
            await moreSettings.click();
          }
          expect(await primary.textContent()).not.toContain("alex@example.com");
          expect(await primary.locator(".picker-select__description").count()).toBe(0);
          const rows = await page
            .locator(".model-providers__defaults .settings-row:not([data-models-more-settings])")
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
            .locator("[data-models-login-discover], .model-providers__refresh-button")
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
          const access = page.getByRole("heading", { name: "Providers", exact: true });
          const section = page.locator(".settings-section").filter({ has: access });
          const group = section.locator(":scope > .settings-group");
          expect((await access.boundingBox())!.x).toBe((await group.boundingBox())!.x);
          await primary.scrollIntoViewIfNeeded();
          const beforeDiscovery = await primary.boundingBox();
          await primary.click();
          await page.locator('.model-providers__defaults [role="listbox"]').first().waitFor();
          await gateway.setMethodResponse("models.list", {
            ...catalog,
            models: [
              ...models,
              { id: "published", name: "Published model", provider: "openai", available: true },
            ],
            pendingProviders: ["openai"],
          });
          await gateway.emitGatewayEvent("chat.metadata.changed", {});
          await page
            .locator('.model-providers__defaults [role="option"][data-value="openai/published"]')
            .first()
            .waitFor();
          const progress = page.locator('.model-providers__catalog-progress[role="status"]');
          expect(await progress.count()).toBe(0);
          expect(await primary.boundingBox()).toEqual(beforeDiscovery);
          await page.keyboard.press("Escape");
        },
      );
    },
  );
});
