import path from "node:path";
import { expect, it } from "vitest";
import { buildAuthHealthSummary } from "../../../src/agents/auth-health.js";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  readyProvider,
  videoPageOptions,
  authProfile,
  button,
  catalogModel,
  configSnapshot,
  configuredRequests,
  createScreenshots,
  emptyUsage,
  pageOptions,
  trimmedText,
} from "./model-provider-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI model provider profile outcomes" });
const NOW = Date.now();

const capture = createScreenshots(() => suite.artifactDir, {});

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
    await suite.withPage(pageOptions(1280, 1000), async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "config.get": configSnapshot({}, "accounts"),
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
              readyProvider("minimax", "MiniMax", [
                authProfile("minimax:opaque-account", "oauth", "ok", {
                  source: "saved",
                  displayName: "Work account",
                }),
              ]),
            ],
          },
          "models.list": {
            models: [catalogModel("xai", "test-model", "Test model")],
            providerOutcomes: [
              { provider: "xai", status: "ready" },
              { provider: "minimax", status: "unavailable" },
            ],
          },
          ...emptyUsage(NOW),
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      const xaiCard = page.locator('[data-provider-id="xai"]');
      const minimaxCard = page.locator('[data-provider-id="minimax"]');
      await xaiCard.screenshot({ path: path.join(suite.artifactDir, "account-status.png") });
      await minimaxCard.screenshot({ path: path.join(suite.artifactDir, "catalog-status.png") });
      await trimmedText(xaiCard.locator(".model-providers__head .settings-status")).toBe("Ready");
      const profileName = ".model-providers__profile-copy strong";
      expect(await xaiCard.locator(profileName).textContent()).toBe("Account 1");
      expect(await xaiCard.locator(".model-providers__profile-status").textContent()).toContain(
        "Signed in",
      );
      expect(
        await minimaxCard.locator(".model-providers__head .settings-status").textContent(),
      ).toContain("Models unavailable");
      expect(await minimaxCard.locator(profileName).textContent()).toBe("Work account");
      const details = xaiCard.locator("details");
      expect(await details.locator("summary").textContent()).toBe("Details");
      expect(await details.getAttribute("open")).toBeNull();
      await details.locator("summary").click();
      expect(await details.textContent()).toContain("xai:opaque-account");
    });
  });

  it("lifts an account, makes room during dragging, and saves its dropped priority", async () => {
    await suite.withPage(videoPageOptions(1280, 1000, suite.artifactDir), async ({ page }) => {
      const provider = readyProvider(
        "openai",
        "OpenAI",
        [
          authProfile("openai:alex", "oauth", "ok", { email: "alex@example.com" }),
          authProfile("openai:blair", "oauth", "ok", { email: "blair@example.com" }),
        ],
        { profileOrder: ["openai:alex", "openai:blair"] },
      );
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "models.authOrderSet"],
        models: [catalogModel("openai", "gpt-5.5", "GPT-5.5")],
        methodResponses: {
          "config.get": configSnapshot({}, "roster"),
          "models.authStatus": { ts: NOW, providers: [provider] },
          ...emptyUsage(NOW),
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      const card = page.locator('[data-provider-id="openai"]');
      const alex = card.locator('[data-profile-id="openai:alex"]');
      const blair = card.locator('[data-profile-id="openai:blair"]');
      const grip = alex.locator(".model-providers__profile-grip");
      await expect.poll(() => grip.isEnabled()).toBe(true);
      await grip.scrollIntoViewIfNeeded();
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
      await capture(page, "account-lifted.png");
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
      await button(card, "Clear custom order").waitFor();
      await expect.poll(visibleOrder).toEqual(profileIds);
      await capture(page, "account-priority-saved.png");
    });
  });

  it.each([
    {
      name: "keeps the selected agent ready when a sibling profile is rejected",
      providerOutcomes: [
        { provider: "openai", profileId: "openai:rejected", status: "auth-rejected" },
        { provider: "openai", profileId: "openai:ready", status: "ready" },
      ],
      status: "Ready",
      available: true,
    },
    {
      name: "keeps the selected agent's provider-wide rejection visible",
      providerOutcomes: [
        { provider: "openai", status: "auth-rejected" },
        { provider: "openai", profileId: "openai:ready", status: "ready" },
      ],
      status: "Credentials rejected",
      available: false,
    },
  ])("$name", async ({ providerOutcomes, status, available }) => {
    await suite.withPage(pageOptions(1440, 1000, { colorScheme: "dark" }), async ({ page }) => {
      const config = {
        auth: {
          profiles: {
            "openai:rejected": { provider: "openai" },
            "openai:ready": { provider: "openai" },
          },
        },
      };
      const readyModel = catalogModel("openai", "gpt-ready", "GPT Ready", available);
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "models.probe"],
        methodResponses: {
          "agents.list": {
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
            agents: [
              { id: "main", identity: { name: "Main" }, name: "Main" },
              { id: "writer", identity: { name: "Writer" }, name: "Writer" },
            ],
          },
          "config.get": configSnapshot(config, "multi-profile-model-provider"),
          "models.list": {
            cases: [
              {
                match: { view: "configured", agentId: "writer", refresh: true },
                response: {
                  models: [readyModel],
                  refreshFailed: providerOutcomes.some((outcome) => outcome.status !== "ready"),
                  providerOutcomes,
                },
              },
              {
                match: { view: "configured", agentId: "writer" },
                response: { models: [readyModel] },
              },
              { match: { view: "configured" }, response: { models: [] } },
            ],
          },
          "models.authStatus": {
            cases: [
              {
                match: { agentId: "writer" },
                response: {
                  ts: NOW,
                  providers: [
                    readyProvider(
                      "openai",
                      "OpenAI",
                      [
                        authProfile("openai:rejected", "oauth", "ok"),
                        authProfile("openai:ready", "oauth", "ok"),
                      ],
                      { apiKey: { source: "env", envVar: "OPENAI_API_KEY" } },
                    ),
                  ],
                },
              },
              { response: { ts: NOW, providers: [] } },
            ],
          },
          ...emptyUsage(NOW),
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("agents.list");
      const pageScope = page.locator(".settings-sidebar__agent openclaw-agent-select");
      await pageScope.locator(".agent-select__trigger").click();
      await pageScope
        .locator(".agent-select__option[data-agent-option]")
        .filter({ hasText: "Writer" })
        .click();
      await expect.poll(() => configuredRequests(gateway, "writer", false)).not.toHaveLength(0);

      const openaiCard = page.locator('[data-provider-id="openai"]');
      await openaiCard.waitFor();
      await button(page, "Refresh").click();
      await expect
        .poll(async () => (await configuredRequests(gateway, "writer", true))[0])
        .toEqual({ view: "configured", agentId: "writer", refresh: true });
      await trimmedText(openaiCard.locator(".model-providers__head .settings-status")).toBe(status);
      if (!available) {
        await openaiCard.screenshot({
          path: path.join(suite.artifactDir, "provider-auth-rejected.png"),
        });
      }
      expect(
        await openaiCard
          .locator('[data-profile-id="openai:ready"] .model-providers__profile-status')
          .textContent(),
      ).toContain(available ? "Signed in" : "Credentials configured");
    });
  });
});
