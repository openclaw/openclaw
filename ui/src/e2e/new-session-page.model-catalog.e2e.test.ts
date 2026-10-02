import { expect, it } from "vitest";
import type { ModelCatalogEntry } from "../api/types.ts";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import { catalogModel } from "./model-catalog-fixtures.test-support.ts";
import {
  NEW_SESSION_MODEL_CATALOG,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollText,
  pollAttribute,
  pollCount,
} from "./new-session-page.test-support.ts";
import {
  unavailableError,
  pollVisible,
  pollFocused,
  pollOpacity,
} from "./new-session-shard.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const luna: ModelCatalogEntry = catalogModel("openai", "gpt-5.6-luna", "GPT-5.6 Luna");

suite.define(() => {
  it("keeps picker geometry stable while shortcut visibility follows focus", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        await installMockGateway(page, { models: NEW_SESSION_MODEL_CATALOG });
        await page.goto(`${suite.server.baseUrl}new`);

        const modelSelect = page.locator('[data-chat-model-select="true"]');
        const picker = page.locator(".chat-controls__model-picker");
        const search = page.locator('[data-chat-model-search="true"]');
        const secondModel = page.locator('[data-chat-model-option="anthropic/claude-sonnet-4-6"]');

        await modelSelect.click();
        await pollAttribute(picker, "open").toBe("");
        // Opening the picker moves focus to its filter so typing filters models.
        await pollFocused(search).toBe(true);
        await revealChatModelOption(page, "openai/gpt-5.5");
        await revealChatModelOption(page, "anthropic/claude-sonnet-4-6");
        await modelSelect.focus();
        const secondShortcut = secondModel.locator('[data-chat-model-shortcut-number="2"]');
        await pollCount(secondShortcut).toBe(1);
        // Finish the picker's opening scale before recording its baseline. The top
        // transform origin keeps the anchor gap stable while box geometry still grows.
        await picker.locator(":scope > [data-anchored-overlay]").evaluate(finishElementAnimations);
        const menuGeometry = () =>
          page.evaluate(() => {
            const anchor = document.querySelector('[data-chat-model-select="true"]');
            const menu = document.querySelector(".chat-controls__model-menu");
            const action = document.querySelector(
              '[data-chat-model-option="anthropic/claude-sonnet-4-6"] .chat-controls__model-option-action',
            );
            if (!anchor || !menu || !action) {
              return null;
            }
            const anchorBox = anchor.getBoundingClientRect();
            const menuBox = menu.getBoundingClientRect();
            const actionBox = action.getBoundingClientRect();
            return {
              anchorGap: Math.round(anchorBox.top - menuBox.bottom),
              menu: {
                dx: menuBox.x - anchorBox.x,
                dy: menuBox.y - anchorBox.y,
                width: menuBox.width,
                height: menuBox.height,
              },
              action: {
                dx: actionBox.x - menuBox.x,
                dy: actionBox.y - menuBox.y,
                width: actionBox.width,
                height: actionBox.height,
              },
            };
          });
        await expect.poll(async () => (await menuGeometry())?.anchorGap).toBe(4);
        const geometryBeforeFocus = await menuGeometry();
        expect(geometryBeforeFocus).not.toBeNull();
        await pollOpacity(secondShortcut).toBe("1");

        await search.focus();
        await pollFocused(search).toBe(true);
        await pollOpacity(secondShortcut).toBe("0");
        await expect.poll(menuGeometry).toEqual(geometryBeforeFocus);
      },
    );
  });
  it("accepts a draft while keeping the default hidden until model metadata arrives", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        agentModel: "openai/gpt-5.6-luna",
        heldMethods: ["models.list"],
        models: [{ ...luna, reasoning: true }],
      });

      await page.goto(`${suite.server.baseUrl}new`);
      const modelTrigger = page.locator(
        '.new-session-page__composer [data-chat-model-select="true"]',
      );
      await pollAttribute(modelTrigger, "aria-busy").toBe("true");
      expect(await modelTrigger.getAttribute("aria-label")).toContain("Loading models…");
      expect(await modelTrigger.textContent()).not.toContain("gpt-5.6-luna");
      expect(await page.locator(".chat-controls__model-trigger-skeleton").count()).toBe(1);
      await page
        .locator(".new-session-page__message")
        .fill("Start without waiting for the catalog");
      await expect
        .poll(() =>
          page.getByRole("button", { name: "Start session" }).getAttribute("aria-disabled"),
        )
        .toBe("false");
      const actions = page.locator(".new-session-page__composer .agent-chat__composer-actions");
      const loadingModelBox = await modelTrigger.boundingBox();
      const loadingActionsBox = await actions.boundingBox();
      expect(loadingModelBox).not.toBeNull();
      expect(loadingActionsBox).not.toBeNull();
      expect(
        (loadingActionsBox?.x ?? 0) - ((loadingModelBox?.x ?? 0) + (loadingModelBox?.width ?? 0)),
      ).toBeLessThan(16);

      await gateway.waitForRequest("models.list");
      await gateway.resolveDeferred("models.list");
      await pollText(modelTrigger).toContain("GPT-5.6 Luna");
      expect(await modelTrigger.getAttribute("aria-busy")).toBe("false");
      const effortPicker = page.locator(
        ".new-session-page__composer .chat-controls__effort-picker:not(.chat-controls__effort-picker--reserved)",
      );
      await pollVisible(effortPicker).toBe(true);
      const readyActionsBox = await actions.boundingBox();
      expect(readyActionsBox).not.toBeNull();
      expect(readyActionsBox?.x).toBeCloseTo(loadingActionsBox?.x ?? 0, 0);
      expect(readyActionsBox?.width).toBeCloseTo(loadingActionsBox?.width ?? 0, 0);
      await modelTrigger.click();
      await page.keyboard.press("Escape");
      await modelTrigger.click();
      expect(await gateway.getRequests("models.list")).toHaveLength(1);
    });
  });

  it.each(["picker", "startup publication"] as const)(
    "recovers failed model metadata through %s",
    async (recovery) => {
      const startup = recovery === "startup publication";
      const recoveredModel = {
        available: true,
        id: "gpt-5.6-luna",
        name: "Recovered GPT-5.6 Luna",
        provider: "openai",
        reasoning: true,
      };
      const models = startup
        ? [recoveredModel]
        : ["luna", "sol", "terra"].map((model) => ({
            available: true,
            id: `gpt-5.6-${model}`,
            name: `GPT-5.6 ${model.slice(0, 1).toUpperCase()}${model.slice(1)}`,
            provider: "openai",
          }));
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const gateway = await installMockGateway(page, {
          ...(startup ? {} : { agentModel: "openai/gpt-5.6-luna", models }),
          methodResponses: {
            "models.list": {
              __mockError: startup
                ? {
                    code: "UNAVAILABLE",
                    details: { reason: "startup-sidecars" },
                    message: "gateway startup sidecars are still initializing",
                    retryable: true,
                    retryAfterMs: 100,
                  }
                : unavailableError("metadata request timed out"),
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("models.list");
        const modelSelect = page.locator(
          '.new-session-page__composer [data-chat-model-select="true"]',
        );
        await expect
          .poll(() => modelSelect.getByText("Models unavailable", { exact: true }).isVisible())
          .toBe(true);
        expect(await page.locator("[data-chat-model-option]").count()).toBe(0);
        if (startup) {
          await pollCount(page.getByText("Models unavailable", { exact: true })).toBeGreaterThan(0);
          expect(await gateway.getRequests("models.list")).toHaveLength(1);
        }
        await gateway.setMethodResponse("models.list", { commands: [], models });
        if (startup) {
          await gateway.emitGatewayEvent("chat.metadata.changed", {});
          await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(2);
          await pollAttribute(modelSelect, "aria-disabled").toBe("false");
        }
        await modelSelect.click();
        await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(2);
        await revealChatModelOption(page, "openai/gpt-5.6-luna");
        await pollCount(page.locator("[data-chat-model-option]")).toBe(models.length);
        expect(await page.locator("[data-chat-model-catalog-state]").count()).toBe(0);
        if (startup) {
          await pollText(page.locator('[data-chat-model-option="openai/gpt-5.6-luna"]')).toContain(
            recoveredModel.name,
          );
          expect(await gateway.getRequests("models.list")).toHaveLength(2);
          for (const request of await gateway.getRequests("models.list")) {
            expect(request.params).toEqual({ view: "configured", agentId: "main" });
          }
        } else {
          expect((await gateway.getRequests("models.list"))[1]?.params).toMatchObject({
            agentId: "main",
          });
        }
      });
    },
  );
});
