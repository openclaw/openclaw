import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import partialConfig from "../../../test/fixtures/config-corpus/provider-partially-unavailable.json" with { type: "json" };
import type { ModelCatalogResult } from "../api/types.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Partial provider refresh controls" });
const levels = ["off", "low", "medium", "high", "xhigh", "max", "ultra"].map((id) => ({
  id,
  label: id,
}));
const catalog: ModelCatalogResult = {
  models: [
    {
      id: "gpt-5.4",
      name: "GPT-5.4",
      provider: "openai",
      available: true,
      reasoning: true,
      supportsFastMode: true,
      thinkingLevels: levels,
      thinkingDefault: "high",
    },
    {
      id: "unavailable-model",
      name: "Unavailable Copilot model",
      provider: "github-copilot",
      available: false,
      unavailableReason: "missing-auth",
      thinkingLevels: [],
    },
  ],
  refreshFailed: true,
  providerOutcomes: [
    { provider: "openai", status: "ready" },
    { provider: "github-copilot", status: "unavailable" },
  ],
};

function readControls(page: Page) {
  return page
    .locator(".agent-chat__input")
    .first()
    .evaluate((composer) => {
      const effort = composer.querySelector<HTMLElement>("[data-chat-thinking-select]");
      return {
        text: composer.textContent,
        notice: composer.querySelector("[data-chat-model-catalog-state]")?.textContent,
        effort: effort
          ? {
              label: effort.getAttribute("aria-label"),
              visible: effort.checkVisibility({ visibilityProperty: true }),
              disabled: effort.getAttribute("aria-disabled"),
              reserved: effort.closest("details")?.getAttribute("aria-hidden"),
              value: effort.getAttribute("data-chat-thinking-value"),
              fast: effort.getAttribute("data-chat-fast-mode"),
            }
          : null,
      };
    });
}

async function captureControls(page: Page, stage: string) {
  const controls = await readControls(page);
  await writeFile(path.join(suite.artifactDir, `${stage}.json`), JSON.stringify(controls, null, 2));
  await page.screenshot({
    path: path.join(suite.artifactDir, `${stage}.png`),
    animations: "disabled",
  });
}

suite.define(() => {
  it.each(["new", "chat"])(
    "keeps effort, speed and the model picker usable in %s",
    async (route) => {
      await suite.withPage(
        { locale: "en-US", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            agentModel: partialConfig.agents.defaults.model,
            models: catalog.models,
            sessionInfo: {
              model: "gpt-5.4",
              modelProvider: "openai",
              thinkingLevels: levels,
              thinkingDefault: "high",
            },
            methodResponses: {
              "models.list": catalog,
              "sessions.list": {
                ts: 1,
                path: "",
                count: 1,
                defaults: {
                  model: "gpt-5.4",
                  modelProvider: "openai",
                  thinkingLevels: levels,
                  thinkingDefault: "high",
                },
                sessions: [
                  {
                    key: "agent:main:main",
                    kind: "direct",
                    model: "gpt-5.4",
                    modelProvider: "openai",
                    thinkingLevels: levels,
                    thinkingDefault: "high",
                  },
                ],
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}${route}`);
          const composer = page.locator(".agent-chat__input").first();
          const model = composer.locator("[data-chat-model-select]");
          await expect.poll(() => model.getAttribute("aria-busy")).toBe("false");
          await model.click();
          await page
            .getByText("Some models could not be refreshed. Open Models to try again.", {
              exact: true,
            })
            .waitFor();
          const available = composer.locator('[data-chat-model-option="openai/gpt-5.4"]');
          await expect.poll(() => available.isVisible()).toBe(true);
          await page.screenshot({
            path: path.join(suite.artifactDir, `${route}-catalog.png`),
            animations: "disabled",
          });
          await model.click();
          await page.screenshot({
            path: path.join(suite.artifactDir, `${route}-composer.png`),
            animations: "disabled",
          });
          const effort = composer.locator("[data-chat-thinking-select]");
          await expect.poll(() => effort.isVisible()).toBe(true);
          await effort.click();
          const slider = composer.locator("[data-chat-thinking-slider]");
          await expect
            .poll(() => slider.getAttribute("data-chat-thinking-values"))
            .toBe(levels.map(({ id }) => id).join(","));
          const sliderBounds = await slider.boundingBox();
          expect(sliderBounds).not.toBeNull();
          await slider.click({
            position: { x: sliderBounds!.width - 2, y: sliderBounds!.height / 2 },
          });
          await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("ultra");
          if (route === "chat") {
            expect((await gateway.waitForRequest("sessions.patch")).params).toMatchObject({
              key: "agent:main:main",
              thinkingLevel: "ultra",
            });
          }
          const speed = composer.getByRole("switch", { name: /Fast responses/ });
          await expect.poll(() => speed.isEnabled()).toBe(true);
          await page.screenshot({
            path: path.join(suite.artifactDir, `${route}-effort.png`),
            animations: "disabled",
          });
          await speed.click();
          if (route === "chat") {
            await expect
              .poll(async () =>
                (await gateway.getRequests("sessions.patch")).map(({ params }) => params),
              )
              .toContainEqual({ key: "agent:main:main", fastMode: true });
          }
          await page.keyboard.press("Escape");
          await model.click();
          expect(await composer.locator('[data-chat-model-catalog-state="error"]').count()).toBe(0);
          for (const [index, refreshFailed] of [false, true, false].entries()) {
            await gateway.setMethodResponse("models.list", {
              ...catalog,
              refreshFailed,
              providerOutcomes: [
                { provider: "openai", status: "ready" },
                { provider: "github-copilot", status: refreshFailed ? "unavailable" : "ready" },
              ],
            });
            await gateway.emitGatewayEvent("chat.metadata.changed", {});
            const notice = composer.locator("[data-chat-model-catalog-state]");
            await expect.poll(() => notice.count()).toBe(refreshFailed ? 1 : 0);
            await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("ultra");
            expect(await effort.getAttribute("data-chat-fast-mode")).toBe("true");
            expect(await model.textContent()).toContain("GPT-5.4");
            await captureControls(page, `${route}-recovery-${index}`);
          }
        },
      );
    },
  );

  it("keeps usable effort controls when the selected model is locked during a partial refresh", async () => {
    await suite.withPage({ locale: "en-US" }, async ({ page }) => {
      await installMockGateway(page, {
        agentModel: partialConfig.agents.defaults.model,
        models: catalog.models,
        methodResponses: {
          "models.list": catalog,
          "sessions.list": {
            ts: 1,
            path: "",
            count: 1,
            defaults: {},
            sessions: [
              {
                key: "agent:main:main",
                kind: "direct",
                model: "gpt-5.4",
                modelProvider: "openai",
                modelSelectionLocked: true,
                thinkingLevels: levels,
                thinkingDefault: "high",
              },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const effort = page.locator("[data-chat-thinking-select]");
      await expect.poll(() => effort.isVisible()).toBe(true);
      expect(await effort.getAttribute("aria-disabled")).toBe("false");
      expect(await page.locator(".chat-controls__effort-picker").getAttribute("aria-hidden")).toBe(
        "false",
      );
      expect(
        await page.locator("[data-chat-model-select]").getAttribute("data-chat-model-locked"),
      ).toBe("true");
      await effort.click();
      await expect.poll(() => page.locator("[data-chat-thinking-slider]").isEnabled()).toBe(true);
    });
  });

  it.each(["empty", "rejected", "retained rejection", "selected unavailable", "non-reasoning"])(
    "does not expose usable effort for %s",
    async (condition) => {
      await suite.withPage({ locale: "en-US" }, async ({ page }) => {
        const selected = {
          ...catalog.models[0]!,
          available: condition !== "selected unavailable",
          supportsFastMode: condition !== "non-reasoning",
          reasoning: condition !== "non-reasoning",
          thinkingLevels: condition === "non-reasoning" ? [] : levels,
        };
        const models =
          condition === "empty"
            ? []
            : [selected, { id: "other", name: "Other", provider: "example", available: true }];
        const failure = { __mockError: { code: "UNAVAILABLE", message: "Catalog request failed" } };
        const gateway = await installMockGateway(page, {
          agentModel: partialConfig.agents.defaults.model,
          models,
          sessionInfo: {
            model: selected.id,
            modelProvider: selected.provider,
            thinkingLevels: selected.thinkingLevels,
          },
          methodResponses: {
            "models.list": condition === "rejected" ? failure : { ...catalog, models },
            "sessions.list": {
              ts: 1,
              path: "",
              count: 1,
              defaults: {
                model: selected.id,
                modelProvider: selected.provider,
                thinkingLevels: selected.thinkingLevels,
                thinkingDefault: condition === "non-reasoning" ? "off" : "high",
              },
              sessions: [
                {
                  key: "agent:main:main",
                  kind: "direct",
                  model: selected.id,
                  modelProvider: selected.provider,
                  thinkingLevels: selected.thinkingLevels,
                  thinkingDefault: condition === "non-reasoning" ? "off" : "high",
                },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const model = page.locator("[data-chat-model-select]");
        await expect.poll(() => model.getAttribute("aria-busy")).toBe("false");
        if (condition === "retained rejection") {
          await expect
            .poll(() => page.locator("[data-chat-thinking-select]").isVisible())
            .toBe(true);
          await gateway.setMethodResponse("models.list", failure);
        }
        await model.click();
        await expect
          .poll(() => page.locator("[data-chat-model-catalog-state]").isVisible())
          .toBe(true);
        await expect
          .poll(async () => {
            const { effort } = await readControls(page);
            return !effort || effort.reserved === "true" || effort.disabled === "true";
          })
          .toBe(true);
        await captureControls(page, `${condition}-open`);
        await model.click();
        await expect
          .poll(async () => {
            const { effort } = await readControls(page);
            return !effort || effort.disabled === "true";
          })
          .toBe(true);
        await captureControls(page, `${condition}-closed`);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      });
    },
  );
});
