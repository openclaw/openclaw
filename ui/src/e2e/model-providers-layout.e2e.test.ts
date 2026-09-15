import path from "node:path";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Models settings layout and discovery" });
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";
const now = Date.now();

function accountUsageResponses(primaryUsedPercent: number, secondaryUsedPercent: number) {
  return {
    cases: [
      {
        match: { agentId: "main", profileId: "openai:alpha" },
        response: {
          updatedAt: now,
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              plan: "Synthetic Alpha",
              windows: [{ label: "5h", usedPercent: primaryUsedPercent }],
            },
          ],
        },
      },
      {
        match: { agentId: "main", profileId: "openai:beta" },
        response: {
          updatedAt: now,
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              plan: "Synthetic Beta",
              windows: [{ label: "5h", usedPercent: secondaryUsedPercent }],
            },
          ],
        },
      },
    ],
  };
}

suite.define(() => {
  it.each([1440, 1100, 768, 640, 390])(
    "Models page keeps controls separate and publishes discovery into a passive picker at %ipx",
    async (width) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width, height: 1000 } },
        async ({ page }) => {
          const models = [
            { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
            { id: "gpt-5-mini", name: "GPT-5 mini", provider: "openai", available: true },
          ];
          const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
          const catalog = {
            models,
            defaultModels: { automaticUtilityModel: "openai/gpt-5-mini" },
          };
          const gateway = await installMockGateway(page, {
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
              "config.get": {
                config,
                sourceConfig: config,
                hash: "models-layout",
                raw: JSON.stringify(config),
                valid: true,
                issues: [],
              },
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
          });
          await page.goto(`${suite.server.baseUrl}settings/model-providers`);
          const primary = page.getByRole("button", { name: /^Model: GPT-5.5/ });
          await primary.waitFor();
          await expect.poll(() => primary.textContent()).toContain("alex@example.com");
          const utility = page.getByRole("button", { name: /^Utility Model: Auto/ });
          await expect.poll(() => utility.textContent()).toContain("GPT-5 mini");
          await expect.poll(() => utility.textContent()).toContain("alex@example.com");
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
          expect(rows).toHaveLength(5);
          expect(rows.every((row) => (width > 640 ? row.sideBySide : row.stacked))).toBe(true);
          const header = page.locator(".content-header--settings");
          const bounds = await header
            .locator(".page-header-actions > button")
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
          if (recordVisuals) {
            await page.screenshot({ path: path.join(suite.artifactDir, `models-${width}.png`) });
          }
          await primary.scrollIntoViewIfNeeded();
          const beforeDiscovery = await primary.boundingBox();
          const requestsBeforeOpen = await gateway.getRequests("models.list");
          await primary.click();
          await page.locator('.model-providers__defaults [role="listbox"]').first().waitFor();
          expect(await gateway.getRequests("models.list")).toEqual(requestsBeforeOpen);
          await gateway.setMethodResponse("models.list", {
            ...catalog,
            pendingProviders: ["openai"],
          });
          await gateway.emitGatewayEvent("chat.metadata.changed", {});
          const progress = page.locator('.model-providers__catalog-progress[role="status"]');
          await progress.waitFor();
          expect(await primary.boundingBox()).toEqual(beforeDiscovery);
          expect(await progress.locator('[aria-hidden="true"]').count()).toBe(1);
          if (recordVisuals) {
            await page.screenshot({
              path: path.join(suite.artifactDir, `discovering-${width}.png`),
            });
          }
          await gateway.setMethodResponse("models.list", {
            ...catalog,
            models: [
              ...models,
              { id: "account-new", name: "New account model", provider: "openai", available: true },
            ],
          });
          await gateway.emitGatewayEvent("chat.metadata.changed", {});
          await expect.poll(() => progress.count()).toBe(0);
          await page
            .locator('.model-providers__defaults [role="option"][data-value="openai/account-new"]')
            .first()
            .waitFor({ state: "visible" });
          expect(await primary.getAttribute("aria-expanded")).toBe("true");
          expect(await primary.textContent()).toContain("GPT-5.5");
        },
      );
    },
  );

  it.each([1440, 390])(
    "stacks saved OpenAI quota cards and refreshes every account at %ipx",
    async (width) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width, height: 1000 } },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            featureMethods: [...defaultControlUiFeatureMethods, "codex.accountUsage"],
            methodResponses: {
              "config.get": { config: {}, hash: "account-usage-layout", valid: true },
              "models.list": { models: [] },
              "models.authStatus": {
                ts: now,
                providers: [
                  {
                    provider: "openai",
                    displayName: "OpenAI",
                    status: "ok",
                    profiles: [
                      {
                        profileId: "openai:alpha",
                        type: "oauth",
                        status: "ok",
                        email: "alpha@quota.test",
                      },
                      {
                        profileId: "openai:beta",
                        type: "oauth",
                        status: "ok",
                        email: "betaaccountwithanextremelylongunbrokenlocalpart@quota.test",
                      },
                    ],
                  },
                ],
              },
              "usage.status": { updatedAt: now, providers: [] },
              "sessions.usage": { aggregates: { byProvider: [] } },
              "codex.accountUsage": accountUsageResponses(10, 40),
            },
          });

          await page.goto(`${suite.server.baseUrl}settings/model-providers`);
          const accountUsages = page.locator(".model-providers__account-usages");
          const cards = accountUsages.locator(".model-providers__account-usage");
          await expect.poll(() => cards.count()).toBe(2);
          await expect.poll(() => accountUsages.textContent()).toContain("90% left");
          await expect.poll(() => accountUsages.textContent()).toContain("60% left");

          const boxes = await cards.evaluateAll((elements) =>
            elements.map((element) => {
              const {
                bottom,
                height,
                left,
                right,
                top,
                width: cardWidth,
              } = element.getBoundingClientRect();
              return { bottom, height, left, right, top, width: cardWidth };
            }),
          );
          expect(boxes).toHaveLength(2);
          expect(boxes.every((box) => box.left >= 0 && box.right <= width)).toBe(true);
          expect(boxes[1]!.top).toBeGreaterThanOrEqual(boxes[0]!.bottom);

          // A long unbroken account label must wrap instead of spilling out of its card.
          const overflows = await cards.evaluateAll((elements) =>
            elements.map((element) => {
              const cardRight = element.getBoundingClientRect().right;
              return {
                card: element.scrollWidth - element.clientWidth,
                label: Math.max(
                  0,
                  ...[...element.querySelectorAll("strong")].map((node) =>
                    Math.round(node.getBoundingClientRect().right - cardRight),
                  ),
                ),
              };
            }),
          );
          expect(overflows.every((entry) => entry.card <= 1)).toBe(true);
          expect(overflows.every((entry) => entry.label <= 1)).toBe(true);

          if (recordVisuals) {
            // The settings page scrolls inside its own container, so a full-page capture would
            // stop at the viewport and cut the quota group off. Center it instead.
            await accountUsages.evaluate((element) => {
              element.scrollIntoView({ block: "center", inline: "nearest" });
            });
            await page.screenshot({
              animations: "disabled",
              path: path.join(suite.artifactDir, `account-usage-${width}-before-refresh.png`),
            });
          }

          const beforeRefresh = (await gateway.getRequests("codex.accountUsage")).length;
          await gateway.setMethodResponse("codex.accountUsage", accountUsageResponses(90, 80));
          await accountUsages.getByRole("button", { name: "Refresh", exact: true }).click();
          await expect
            .poll(async () => (await gateway.getRequests("codex.accountUsage")).length)
            .toBe(beforeRefresh + 2);
          await expect.poll(() => accountUsages.textContent()).toContain("10% left");
          await expect.poll(() => accountUsages.textContent()).toContain("20% left");

          if (recordVisuals) {
            await accountUsages.evaluate((element) => {
              element.scrollIntoView({ block: "center", inline: "nearest" });
            });
            await page.screenshot({
              animations: "disabled",
              path: path.join(suite.artifactDir, `account-usage-${width}-after-refresh.png`),
            });
          }
        },
      );
    },
  );
});
