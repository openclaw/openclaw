import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { installMockGateway } from "./chat-flow.test-support.ts";
import { modelPicker } from "./chat-runtime-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Model favorite keyboard focus",
  unavailableMessage: (executablePath) => "Missing Chromium: " + executablePath,
});
const prefsKey = "ui.modelFavorites:main";
const favorite = JSON.stringify(["openai/gpt-4o-mini", null]);
const cases = ["provider", "search"].flatMap((target) =>
  ["Enter", "Space"].flatMap((key) =>
    ["rejected", "conflict"].map((outcome) => ({ target, key, outcome })),
  ),
);

suite.define(() => {
  it.each(cases)(
    "keeps $target heart focus through $key activation and a $outcome save",
    async ({ target, key, outcome }) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-4o",
          models: [
            { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
            { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
          ],
          presenceUsers: [{ id: "synthetic-operator", self: true }],
          featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get", "users.prefs.set"],
          methodResponses: {
            "users.prefs.get": { status: "ok", entries: {} },
            "users.prefs.set": { status: "ok" },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        const { picker, trigger, search } = modelPicker(page);
        await trigger.click();
        const provider = picker.locator('[data-chat-model-provider-group="openai"]');
        const toggle = provider.locator("[data-chat-model-provider-toggle]");
        await expect.poll(() => toggle.count()).toBe(1);
        if ((await toggle.getAttribute("aria-expanded")) !== "true") {
          await toggle.click();
        }
        if (target === "search") {
          await search.fill("GPT-4o mini");
          await expect.poll(() => picker.locator("[data-chat-model-key]:visible").count()).toBe(1);
        }
        const heart = provider.locator("[data-chat-model-favorite]");
        await expect.poll(() => heart.isEnabled()).toBe(true);
        await gateway.deferNext("users.prefs.set", { entries: { [prefsKey]: [favorite] } });
        await heart.focus();
        await heart.press(key);
        await expect.poll(() => heart.isDisabled()).toBe(true);
        const pendingActiveTag = await page.evaluate(() => document.activeElement?.tagName);
        if (outcome === "conflict") {
          await gateway.setMethodResponse("users.prefs.get", {
            status: "ok",
            entries: { [prefsKey]: [favorite] },
          });
          await gateway.resolveDeferred("users.prefs.set", { status: "conflict" });
        } else {
          await gateway.rejectDeferred("users.prefs.set", {
            message: "Synthetic favorite save rejected",
          });
        }
        await expect.poll(() => heart.isEnabled()).toBe(true);
        await expect
          .poll(() => picker.locator('[role="alert"]').textContent())
          .toContain(
            outcome === "conflict" ? "Favorites changed" : "Synthetic favorite save rejected",
          );
        const settledActiveTag = await page.evaluate(() => document.activeElement?.tagName);
        expect({ pendingActiveTag, settledActiveTag }).toEqual({
          pendingActiveTag: "INPUT",
          settledActiveTag: "INPUT",
        });
        expect(await search.evaluate((element) => element === document.activeElement)).toBe(true);
        expect(await heart.getAttribute("aria-pressed")).toBe(
          outcome === "conflict" ? "true" : "false",
        );
        expect(await picker.isVisible()).toBe(true);
        expect(await search.inputValue()).toBe(target === "search" ? "GPT-4o mini" : "");
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      });
    },
  );
});
