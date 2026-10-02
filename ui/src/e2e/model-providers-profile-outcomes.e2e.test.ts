import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { buildAuthHealthSummary } from "../../../src/agents/auth-health.js";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { configSnapshot, pageRunner } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expandProvider } from "./model-providers.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI model provider profile outcomes" });
const NOW = Date.now();
const withPage = pageRunner(suite, {
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 1000, width: 1280 },
});
const text = (root: Locator, selector: string) => root.locator(selector).textContent();
const statusText = async (card: Locator) =>
  (await text(card, ".model-providers__head .settings-status"))?.trim();
const configResponse = (config = {}) => ({
  ...configSnapshot(config, "accounts"),
  sourceConfig: config,
});

suite.define(() => {
  it("explains saved account health separately from catalog availability", async () => {
    const health = buildAuthHealthSummary({
      store: {
        version: 1,
        profiles: {
          "xai:opaque-account": {
            type: "oauth",
            provider: "xai",
            access: "synthetic-access",
            refresh: "synthetic-refresh",
            expires: Date.now() + 60 * 60_000,
          },
        },
      },
    });
    const xai = health.providers[0]!;
    await withPage(async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "config.get": configResponse(),
          "models.authStatus": {
            ts: NOW,
            providers: [
              {
                ...xai,
                displayName: "xAI",
                profiles: xai.profiles.map((profile) =>
                  Object.assign({}, profile, { source: "saved" }),
                ),
              },
              {
                provider: "minimax",
                displayName: "MiniMax",
                status: "ok",
                profiles: [
                  {
                    profileId: "minimax:opaque-account",
                    type: "oauth",
                    status: "ok",
                    source: "saved",
                    displayName: "Work account",
                  },
                ],
              },
            ],
          },
          "models.list": {
            models: [{ id: "test-model", name: "Test model", provider: "xai", available: true }],
            providerOutcomes: [
              { provider: "xai", status: "ready" },
              { provider: "minimax", status: "unavailable" },
            ],
          },
          "usage.status": { updatedAt: NOW, providers: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      const xaiCard = page.locator('[data-provider-id="xai"]');
      const minimaxCard = page.locator('[data-provider-id="minimax"]');
      await expandProvider(page, "xai");
      await expandProvider(page, "minimax");
      await expect.poll(() => statusText(xaiCard)).toBe("Ready");
      expect(await text(xaiCard, ".model-providers__profile-copy strong")).toBe(
        "Signed-in account",
      );
      // The row already reads Ready, so the healthy account does not repeat it.
      expect((await text(xaiCard, ".model-providers__profile-status"))?.trim()).toBe("");
      expect(await statusText(minimaxCard)).toContain("Models unavailable");
      expect(await text(minimaxCard, ".model-providers__profile-copy strong")).toBe("Work account");
      // The profile id stays reachable as the identity's title, not a separate disclosure.
      expect(await xaiCard.locator("details").count()).toBe(0);
      expect(
        await xaiCard.locator(".model-providers__profile-copy strong").getAttribute("title"),
      ).toBe("xai:opaque-account");
    });
  });

  it("lifts an account, makes room during dragging, and saves its dropped priority", async () => {
    await withPage(async ({ page }) => {
      const provider = {
        provider: "openai",
        displayName: "OpenAI",
        status: "ok",
        profiles: [
          { profileId: "openai:alex", type: "oauth", status: "ok", email: "alex@example.com" },
          { profileId: "openai:blair", type: "oauth", status: "ok", email: "blair@example.com" },
        ],
        profileOrder: ["openai:alex", "openai:blair"],
      };
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "models.authOrderSet"],
        models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true }],
        methodResponses: {
          "config.get": configResponse(),
          "models.authStatus": { ts: NOW, providers: [provider] },
          "usage.status": { updatedAt: NOW, providers: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      const card = await expandProvider(page, "openai");
      const alex = card.locator('[data-profile-id="openai:alex"]');
      const blair = card.locator('[data-profile-id="openai:blair"]');
      const grip = alex.locator(".model-providers__profile-grip");
      await expect.poll(() => grip.isEnabled()).toBe(true);
      // The drag ends over the lower account, so keep both rows inside the viewport.
      await blair.scrollIntoViewIfNeeded();
      const start = await grip.boundingBox();
      const first = await alex.boundingBox();
      const second = await blair.boundingBox();
      if (!start || !first || !second) {
        throw new Error("Expected both account rows and the drag handle to be visible");
      }
      await gateway.deferNext("models.authOrderSet");
      const x = start.x + start.width / 2;
      const y = start.y + start.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + first.height * 0.75, { steps: 6 });
      await expect.poll(async () => (await alex.boundingBox())?.y).toBeGreaterThan(first.y);
      await expect.poll(async () => (await blair.boundingBox())?.y).toBeLessThan(second.y);
      expect(await gateway.getRequests("models.authOrderSet")).toHaveLength(0);
      await page.mouse.up();
      const request = await gateway.waitForRequest("models.authOrderSet");
      const profileIds = ["openai:blair", "openai:alex"];
      expect(request.params).toEqual({ agentId: "main", provider: "openai", profileIds });
      const visibleOrder = () =>
        card
          .locator(".model-providers__profile")
          .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-profile-id")));
      await expect.poll(visibleOrder).toEqual(profileIds);
      expect(await card.getByText("Saving", { exact: true }).count()).toBe(0);
      await gateway.setMethodResponse("models.authStatus", {
        ts: NOW,
        providers: [{ ...provider, profileOrder: profileIds, profileOrderStored: true }],
      });
      await gateway.resolveDeferred("models.authOrderSet", { provider: "openai", profileIds });
      await card.getByRole("button", { name: "Clear custom order", exact: true }).waitFor();
      await expect.poll(visibleOrder).toEqual(profileIds);
    });
  });
});
