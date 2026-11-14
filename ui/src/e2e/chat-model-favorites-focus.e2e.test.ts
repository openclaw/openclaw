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
const favorite = "openai/gpt-4o-mini";
const cases = ["provider", "search"].flatMap((target) =>
  ["Enter", "Space"].flatMap((key) =>
    ["rejected", "conflict"].map((outcome) => ({ target, key, outcome })),
  ),
);

suite.define(() => {
  it.each(["chat", "new"])(
    "persists provider drag order after closing and reloading /%s",
    async (route) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            agentModel: "openai/example-large",
            models: [
              { provider: "anthropic", id: "claude-opus", name: "Claude Opus" },
              { provider: "google", id: "gemini-pro", name: "Gemini Pro" },
              { provider: "openai", id: "example-large", name: "Example Large" },
            ],
          });
          await page.goto(suite.server.baseUrl + route);
          const { picker, trigger } = modelPicker(page);
          await trigger.click();
          const rail = picker.getByRole("tablist");
          const order = () =>
            rail
              .getByRole("tab")
              .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-tab-value")));
          await expect.poll(order).toEqual(["anthropic", "google", "openai"]);
          await rail
            .getByRole("tab", { name: "OpenAI", exact: true })
            .dragTo(rail.getByRole("tab", { name: "Anthropic", exact: true }));
          await expect.poll(order).toEqual(["openai", "anthropic", "google"]);
          expect(
            await page.evaluate(() =>
              JSON.parse(localStorage.getItem("openclaw.control.modelProviderOrder.v1") ?? "null"),
            ),
          ).toEqual(["openai", "anthropic", "google"]);
          await page.keyboard.press("Escape");
          await trigger.click();
          await expect.poll(order).toEqual(["openai", "anthropic", "google"]);
          await page.reload();
          await trigger.click();
          await expect.poll(order).toEqual(["openai", "anthropic", "google"]);
          expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        },
      );
    },
  );

  it("uses the standard picker scrollbar and fades only clipped model-list edges", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, colorScheme: "light", reducedMotion: "reduce" },
      async ({ page }) => {
        await installMockGateway(page, {
          agentModel: "openai/gpt-4o",
          models: Array.from({ length: 24 }, (_, index) => ({
            provider: "openai",
            id: index === 0 ? "gpt-4o" : "model-" + index,
            name: index === 0 ? "GPT-4o" : "Model " + String(index).padStart(2, "0"),
          })),
        });
        await page.goto(suite.server.baseUrl + "chat");
        const { picker, trigger, search } = modelPicker(page);
        await trigger.click();
        const allModels = picker.locator("[data-chat-model-more-toggle]");
        await allModels.click();
        const list = picker.locator("[data-chat-model-window]");
        await expect
          .poll(() => list.evaluate((el) => el.scrollHeight > el.clientHeight))
          .toBe(true);
        await list.hover();
        await page.mouse.wheel(0, -2000);
        await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(0);
        await page.mouse.move(0, 0);
        expect(await list.evaluate((el) => getComputedStyle(el).scrollbarColor)).toBe("auto");
        expect(await list.evaluate((el) => getComputedStyle(el, "::-webkit-scrollbar").width)).toBe(
          "8px",
        );
        expect(
          await list.evaluate(
            (el) => getComputedStyle(el, "::-webkit-scrollbar-thumb").borderLeftWidth,
          ),
        ).toBe("2px");
        const idleThumb = await list.evaluate(
          (el) => getComputedStyle(el, "::-webkit-scrollbar-thumb").backgroundColor,
        );
        await list.hover();
        expect(
          await list.evaluate(
            (el) => getComputedStyle(el, "::-webkit-scrollbar-thumb").backgroundColor,
          ),
        ).not.toBe(idleThumb);
        await page.mouse.move(0, 0);
        await expect.poll(() => list.getAttribute("data-at-start")).toBe("true");
        await expect.poll(() => list.getAttribute("data-at-end")).toBe("false");
        expect.soft(await list.evaluate((el) => getComputedStyle(el).maskImage)).not.toBe("none");
        await list.hover();
        await page.mouse.wheel(0, 180);
        await expect.poll(() => list.getAttribute("data-at-start")).toBe("false");
        await expect.poll(() => list.getAttribute("data-at-end")).toBe("false");
        await page.mouse.wheel(0, 2000);
        // Newly mounted rows replace size estimates; finish the native scroll
        // after the final row has been measured instead of assuming a wheel delta is an edge.
        const last = picker.locator('[data-chat-model-option="openai/model-23"]');
        await last.waitFor();
        await expect.poll(() => last.evaluate((el) => el.getBoundingClientRect().height)).toBe(36);
        await page.mouse.wheel(0, 2000);
        await expect
          .poll(() =>
            list.evaluate((el) => ({
              atEnd: el.getAttribute("data-at-end"),
              top: el.scrollTop,
              height: el.clientHeight,
              total: el.scrollHeight,
            })),
          )
          .toEqual(expect.objectContaining({ atEnd: "true" }));
        await search.fill("GPT-4o");
        await expect.poll(() => list.getAttribute("data-scrollable")).toBe("false");
        expect(await list.evaluate((el) => getComputedStyle(el).maskImage)).toBe("none");
      },
    );
  });

  it("keeps stars hover-only and the provider rail quiet and live", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-4o",
          sessionInfo: { model: "gpt-4o-mini", modelProvider: "openai" },
          models: [
            { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
            { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
            { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
            { provider: "anthropic", id: "claude-3-5-haiku", name: "Claude Haiku" },
          ],
          presenceUsers: [{ id: "synthetic-operator", self: true }],
          featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get", "users.prefs.set"],
          bootstrapPreferences: {
            profileId: "synthetic-operator",
            entries: { [prefsKey]: [favorite] },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        const { picker, trigger, search, option } = modelPicker(page);
        await trigger.click();
        await page.mouse.move(0, 0);
        const selected = option(favorite);
        const other = option("openai/gpt-4.1");
        const selectedStar = selected.locator("[data-chat-model-favorite]");
        const otherStar = other.locator("[data-chat-model-favorite]");
        await expect.poll(() => selected.getAttribute("aria-selected")).toBe("true");
        await expect.poll(() => selectedStar.getAttribute("aria-pressed")).toBe("true");
        await other.waitFor();
        const check = selected.locator(".chat-controls__inline-select-check");
        const settings = picker.locator(".chat-controls__provider-settings").first();
        await expect
          .poll(async () => {
            const star = await selectedStar.boundingBox();
            const gear = await settings.boundingBox();
            return star && gear
              ? Math.abs(star.x + star.width / 2 - gear.x - gear.width / 2)
              : Infinity;
          })
          .toBeLessThan(1);
        expect(await check.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
        const rowBounds = await selected.boundingBox();
        await selected.hover();
        await expect.poll(() => check.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
        expect(await selected.boundingBox()).toEqual(rowBounds);
        await page.mouse.move(0, 0);
        await expect.poll(() => check.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
        await expect
          .poll(async () => {
            const first = await selected.boundingBox();
            const second = await other.boundingBox();
            return first && second ? second.y - first.y - first.height : null;
          })
          .toBe(1);
        // The Default, selected and other rows each carry a hover-only star.
        const opacity = () =>
          picker
            .locator("[data-chat-model-favorite]:visible")
            .evaluateAll((stars) => stars.map((star) => getComputedStyle(star).opacity));
        expect.soft(await opacity()).toEqual(["0", "0", "0"]);
        await search.press("ArrowDown");
        await expect.poll(() => other.getAttribute("data-chat-model-highlighted")).toBe("");
        await page.clock.install();
        await picker.getByRole("tab", { name: "Anthropic", exact: true }).hover();
        await page.clock.runFor(1_000);
        expect.soft(await picker.getByRole("tooltip").filter({ visible: true }).count()).toBe(0);
        expect.soft(await opacity()).toEqual(["0", "0", "0"]);
        await page.mouse.move(0, 0);
        await page.clock.runFor(200);
        await search.press("ArrowUp");
        await expect.poll(() => selected.getAttribute("data-chat-model-highlighted")).toBe("");
        expect.soft(await opacity()).toEqual(["0", "0", "0"]);
        for (const row of [selected, other]) {
          await row.hover();
          const star = row.locator("[data-chat-model-favorite]");
          await expect.poll(() => star.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
          await page.mouse.move(0, 0);
          expect.soft(await opacity()).toEqual(["0", "0", "0"]);
        }
        await selectedStar.click();
        await expect.poll(() => selectedStar.getAttribute("aria-pressed")).toBe("false");
        await page.mouse.move(0, 0);
        expect.soft(await opacity()).toEqual(["0", "0", "0"]);
        // Direct keyboard focus also leaves the star hidden until pointer hover.
        await other.focus();
        await page.keyboard.press("Tab");
        await expect
          .poll(() => otherStar.evaluate((el) => el === document.activeElement))
          .toBe(true);
        await expect.poll(() => otherStar.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
        const favoritesTab = picker.getByRole("tab", { name: "Favorites", exact: true });
        await expect.poll(() => favoritesTab.count()).toBe(0);
        await selectedStar.click();
        await favoritesTab.click();
        await expect.poll(() => selectedStar.getAttribute("aria-pressed")).toBe("true");
        expect(await picker.locator("[data-chat-model-option]:visible").count()).toBe(1);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      },
    );
  });

  it.each([1280, 390])("keeps the star column clear of context controls at %spx", async (width) => {
    await suite.withPage(
      {
        viewport: { width, height: 900 },
        hasTouch: width === 390,
        isMobile: width === 390,
        colorScheme: "light",
        reducedMotion: "reduce",
      },
      async ({ page }) => {
        const contextWindows = [
          { id: "272k", label: "272K", contextWindow: 272_000 },
          { id: "1m", label: "1M", contextWindow: 1_000_000 },
        ];
        const gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-4o",
          sessions: [
            {
              key: "agent:main:main",
              label: "Main",
              kind: "direct",
              model: "example-large",
              modelProvider: "openai",
              contextWindow: "272k",
              contextWindowDefault: "1m",
              contextWindows,
            },
          ],
          models: [
            { provider: "openai", id: "gpt-4o", name: "GPT-4o", contextWindow: 1_000_000 },
            {
              provider: "openai",
              id: "example-large",
              name: "Example Large",
              contextWindow: 1_000_000,
              contextWindowDefault: "1m",
              contextWindows,
            },
            {
              provider: "anthropic",
              id: "claude-opus",
              name: "Claude Opus",
              contextWindow: 1_000_000,
            },
          ],
          presenceUsers: [{ id: "synthetic-operator", self: true }],
          featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get", "users.prefs.set"],
        });
        await page.goto(suite.server.baseUrl + "chat");
        const { picker, trigger, option } = modelPicker(page);
        if (width === 390) {
          await page.getByRole("textbox", { name: "Chat composer", exact: true }).tap();
        }
        await trigger.click();
        const selected = option("openai/example-large");
        const star = selected.locator("[data-chat-model-favorite]");
        const context = picker.locator(".chat-controls__context-trigger");
        const gear = picker.locator(".chat-controls__provider-settings").first();
        await context.waitFor();
        const metadataSize = await picker
          .locator(".chat-controls__model-option-meta:not(.chat-controls__context-placeholder)")
          .first()
          .evaluate((el) => getComputedStyle(el).fontSize);
        expect
          .soft(await context.evaluate((el) => getComputedStyle(el).fontSize))
          .toBe(metadataSize);
        const starBounds = (await star.boundingBox())!;
        const gearBounds = (await gear.boundingBox())!;
        expect
          .soft(Math.abs(starBounds.x + starBounds.width / 2 - gearBounds.x - gearBounds.width / 2))
          .toBeLessThan(1);
        const contextBounds = (await context.boundingBox())!;
        expect.soft(contextBounds.x + contextBounds.width).toBeLessThanOrEqual(starBounds.x);
        if (width === 390) {
          expect(await star.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
        }
        await context.click();
        const contextChoice = picker.getByRole("menuitemradio", { name: "1M", exact: true });
        await contextChoice.waitFor();
        expect
          .soft(await contextChoice.evaluate((el) => getComputedStyle(el).fontSize))
          .toBe(metadataSize);
        await page.keyboard.press("Escape");
        expect(await picker.getAttribute("open")).not.toBeNull();
        await star.click();
        await expect.poll(() => star.getAttribute("aria-pressed")).toBe("true");
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      },
    );
  });

  it("returns to the selected model provider after removing the last favorite", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          agentModel: "openai/example-large",
          models: [
            { provider: "anthropic", id: "claude-opus", name: "Claude Opus" },
            { provider: "openai", id: "example-large", name: "Example Large" },
          ],
          presenceUsers: [{ id: "synthetic-operator", self: true }],
          featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get", "users.prefs.set"],
          bootstrapPreferences: {
            profileId: "synthetic-operator",
            entries: { [prefsKey]: ["anthropic/claude-opus"] },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        const { picker, trigger, search, option } = modelPicker(page);
        await trigger.click();
        const favorites = picker.getByRole("tab", { name: "Favorites", exact: true });
        await favorites.click();
        await option("anthropic/claude-opus").locator("[data-chat-model-favorite]").click();
        await expect.poll(() => favorites.count()).toBe(0);
        await expect
          .poll(() =>
            picker.getByRole("tab", { name: "OpenAI", exact: true }).getAttribute("aria-selected"),
          )
          .toBe("true");
        expect(await option("anthropic/claude-opus").count()).toBe(0);
        expect(await option("openai/example-large").getAttribute("aria-selected")).toBe("true");
        expect(await search.evaluate((el) => el === document.activeElement)).toBe(true);
        expect(await picker.getAttribute("open")).not.toBeNull();
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      },
    );
  });

  it("favorites a cooling-down model through its enabled star without selecting it", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        agentModel: "openai/gpt-4o",
        models: [
          { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
          {
            provider: "openai",
            id: "gpt-4o-mini",
            name: "GPT-4o mini",
            available: false,
            unavailableReason: "cooldown",
            unavailableUntil: Date.now() + 60_000,
          },
        ],
        presenceUsers: [{ id: "synthetic-operator", self: true }],
        featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get", "users.prefs.set"],
      });
      await page.goto(suite.server.baseUrl + "chat");
      const { picker, trigger } = modelPicker(page);
      await trigger.click();
      const row = picker.locator('[data-chat-model-option="openai/gpt-4o-mini"]');
      await expect.poll(() => row.getAttribute("aria-disabled")).toBe("true");
      const star = row.locator("[data-chat-model-favorite]");
      await expect.poll(() => star.isEnabled()).toBe(true);
      await star.click();
      await expect.poll(() => star.getAttribute("aria-pressed")).toBe("true");
      const favoriteWrites = await gateway.getRequests("users.prefs.set", {
        entries: { [prefsKey]: [favorite] },
      });
      expect(favoriteWrites.map(({ params }) => params)).toEqual([
        { entries: { [prefsKey]: [favorite] }, expectedEntries: { [prefsKey]: null } },
      ]);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      expect(await picker.isVisible()).toBe(true);
      expect(await row.getAttribute("aria-disabled")).toBe("true");
    });
  });

  it.each(cases)(
    "keeps $target star focus through $key activation and a $outcome save",
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
        if (target === "search") {
          await search.fill("GPT-4o mini");
          await expect.poll(() => picker.locator("[data-chat-model-key]:visible").count()).toBe(1);
        }
        const star = picker.locator('[data-chat-model-favorite="openai/gpt-4o-mini"]');
        await expect.poll(() => star.isEnabled()).toBe(true);
        await gateway.deferNext("users.prefs.set", { entries: { [prefsKey]: [favorite] } });
        await star.focus();
        await star.press(key);
        await expect.poll(() => star.isDisabled()).toBe(true);
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
        await expect.poll(() => star.isEnabled()).toBe(true);
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
        expect(await star.getAttribute("aria-pressed")).toBe(
          outcome === "conflict" ? "true" : "false",
        );
        expect(await picker.isVisible()).toBe(true);
        expect(await search.inputValue()).toBe(target === "search" ? "GPT-4o mini" : "");
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      });
    },
  );
});
