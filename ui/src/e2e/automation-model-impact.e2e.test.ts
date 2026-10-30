import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { CronModelImpactResult } from "../../../packages/gateway-protocol/src/schema/cron-model-impact.ts";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { sourceConfigSnapshot } from "../lib/config/config-snapshot.test-support.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  pauseVirtualClock,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { agentRoster } from "./agent-roster.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  catalogModel,
  configAuth,
  providerPageOptions,
} from "./model-catalog-fixtures.test-support.ts";

const requireRecord = createRequireRecord("record", "expected-object-value");
const suite = createControlUiE2eSuite({ name: "Control UI automation model impact" });
suite.define(() => {
  it.each(["global", "agent"] as const)(
    "assesses a %s model change before writing and preserves it on cancel",
    async (scope) => {
      await suite.withPage(
        providerPageOptions(scope === "global" ? 1280 : 400, scope === "global" ? 1000 : 900, {
          colorScheme: scope === "global" ? "light" : "dark",
        }),
        async ({ page }) => {
          await page.clock.install();
          const gateway = await installMockGateway(page, {
            models: [
              catalogModel("openai", "gpt-4.1", "GPT-4.1"),
              catalogModel("openai", "gpt-4.1-mini", "GPT-4.1 mini"),
            ],
            methodResponses: {
              "agents.list": agentRoster({ main: "Demo assistant" }, "main", "per-sender"),
              "config.get": sourceConfigSnapshot(
                {
                  agents: {
                    defaults: { model: "openai/gpt-4.1" },
                    entries: {
                      main:
                        scope === "global"
                          ? {}
                          : {
                              model: {
                                primary: "openai/gpt-4.1",
                                fallbacks: ["openai/gpt-4.1-mini"],
                              },
                            },
                    },
                  },
                },
                "impact-demo",
              ),
              "models.authStatus": { ts: 1, providers: [configAuth("openai")] },
              "cron.modelImpact": {
                model: "openai/gpt-4.1-mini",
                issues: [],
                jobs: [
                  {
                    id: "daily",
                    name: "Daily summary",
                    enabled: true,
                    effectiveAgentId: "main",
                    before: { model: "openai/gpt-4.1", source: "default" },
                    after: { model: "openai/gpt-4.1-mini", source: "default" },
                    changed: true,
                    status: "no-known-blocker",
                    issues: [],
                  },
                  {
                    id: "pinned",
                    name: "Weekly report (explicit model)",
                    enabled: true,
                    effectiveAgentId: "main",
                    before: { model: "openai/gpt-4.1", source: "payload" },
                    after: { model: "openai/gpt-4.1", source: "payload" },
                    changed: false,
                    status: "blocked",
                    issues: [
                      {
                        code: "model-selection-rejected",
                        severity: "blocker",
                        message: "The explicit model is disallowed by policy.",
                        recovery: "Ask the automation owner to choose an allowed model.",
                      },
                      {
                        code: "recorded-account-unavailable",
                        severity: "blocker",
                        message: "The saved account is unavailable.",
                        recovery: "Ask the automation owner to reconnect the saved account.",
                      },
                    ],
                  },
                  {
                    id: "disabled",
                    name: "Disabled one-time report",
                    enabled: false,
                    effectiveAgentId: "main",
                    before: { model: "openai/gpt-4.1", source: "default" },
                    after: { model: "openai/gpt-4.1-mini", source: "default" },
                    changed: true,
                    status: "unknown",
                    issues: [
                      {
                        code: "recorded-account-unavailable",
                        severity: "warning",
                        message: "Disabled-only diagnostic",
                      },
                    ],
                  },
                ],
              } satisfies CronModelImpactResult,
            },
          });
          await page.goto(
            suite.server.baseUrl +
              (scope === "global" ? "settings/model-providers" : "settings/agents/main/overview"),
          );
          await waitForControlUiRoute(page, {
            routeId: scope === "global" ? "model-providers" : "agents",
          });
          const primary = page
            .locator(
              scope === "global"
                ? ".model-providers__defaults .model-picker"
                : "openclaw-agents-page .model-picker",
            )
            .first();
          const trigger = primary.locator(".picker-select__trigger");
          await expect.poll(() => trigger.textContent()).toContain("GPT-4.1");
          if (process.env.OPENCLAW_UI_PROOF_LABEL === "before" && scope === "global") {
            const frame = await takeControlUiScreenshotFrame(page, primary, [trigger], {
              animations: "disabled",
            });
            await writeFile(path.join(suite.artifactDir, "before.png"), frame.png);
          }
          await trigger.click();
          await primary.getByRole("option", { name: /GPT-4.1 mini/ }).click();
          await gateway.waitForRequest("cron.modelImpact");
          expect(await gateway.getRequests("config.patch")).toHaveLength(0);
          const modal = page
            .locator("openclaw-modal-dialog")
            .filter({ hasText: "Review automation impact" });
          await modal.getByRole("button", { name: "Keep current model", exact: true }).waitFor();
          await expect.poll(() => modal.textContent()).toContain("Daily summary");
          await expect.poll(() => modal.textContent()).toContain("Weekly report (explicit model)");
          await expect
            .poll(() => modal.textContent())
            .toContain("The explicit model is disallowed by policy.");
          await expect
            .poll(() => modal.textContent())
            .toContain("The saved account is unavailable.");
          await expect
            .poll(() => modal.textContent())
            .toContain("Selection unchanged · Compatibility blocker");
          await expect
            .poll(() => modal.textContent())
            .toContain("Disabled automations excluded from this warning: 1");
          expect(await modal.textContent()).not.toContain("Disabled-only diagnostic");
          if (process.env.OPENCLAW_UI_PROOF_LABEL === "after") {
            const frame = await takeControlUiScreenshotFrame(
              page,
              modal.locator(".exec-approval-card"),
              [modal.getByRole("button", { name: "Keep current model", exact: true })],
              { animations: "disabled" },
            );
            await writeFile(
              path.join(
                suite.artifactDir,
                scope === "global" ? "after.png" : "agent-mobile-dark.png",
              ),
              frame.png,
            );
          }
          await modal.getByRole("button", { name: "Keep current model", exact: true }).click();
          await expect.poll(() => modal.count()).toBe(0);
          expect(await gateway.getRequests("config.patch")).toHaveLength(0);
          expect(await gateway.getRequests("config.set")).toHaveLength(0);
          await expect
            .poll(() => trigger.locator(".picker-select__label").textContent())
            .toBe("GPT-4.1");
          expect((await gateway.getRequests("cron.modelImpact"))[0]?.params).toEqual({
            model: "openai/gpt-4.1-mini",
            ...(scope === "agent" ? { agentId: "main" } : {}),
          });
          if (scope === "global") {
            await gateway.setMethodResponse("config.patch", {
              ok: true,
              hash: "impact-fast-saved",
              config: {
                agents: {
                  defaults: { model: "openai/gpt-4.1", fastModeDefault: false },
                  entries: { main: {} },
                },
              },
            });
            await page.getByRole("radio", { name: "Off", exact: true }).click();
            const saved = await gateway.waitForRequest("config.patch");
            const savedPatch: unknown = JSON.parse(String(requireRecord(saved.params).raw));
            expect(savedPatch).toMatchObject({
              agents: { defaults: { model: "openai/gpt-4.1", fastModeDefault: false } },
            });
            expect(await gateway.getRequests("cron.modelImpact")).toHaveLength(1);
            await expect.poll(() => trigger.isEnabled()).toBe(true);
            await gateway.setMethodResponse("config.patch", {
              ok: true,
              hash: "impact-model-saved",
              config: {
                agents: {
                  defaults: { model: "openai/gpt-4.1-mini", fastModeDefault: false },
                  entries: { main: {} },
                },
              },
            });
            await trigger.click();
            await primary.getByRole("option", { name: /GPT-4.1 mini/ }).click();
            await modal.getByRole("button", { name: "Change model anyway", exact: true }).click();
            await expect.poll(() => trigger.isEnabled()).toBe(true);
            await expect
              .poll(() => trigger.locator(".picker-select__label").textContent())
              .toBe("GPT-4.1 mini");
            const notice = page
              .locator('.model-providers__defaults [role="status"]')
              .filter({ hasText: "Proposed model:" });
            await expect
              .poll(() => notice.textContent())
              .toContain("The saved account is unavailable.");
            await expect
              .poll(() => notice.textContent())
              .toContain("The explicit model is disallowed by policy.");
            expect(await gateway.getRequests("config.patch")).toHaveLength(2);
          }
          if (scope === "agent") {
            await trigger.click();
            await gateway.setMethodResponse("cron.modelImpact", {
              model: null,
              agentId: "main",
              issues: [],
              jobs: [
                {
                  id: "daily",
                  name: "Daily summary",
                  enabled: true,
                  effectiveAgentId: "main",
                  before: { model: "openai/gpt-4.1", source: "agent" },
                  after: { model: "openai/gpt-4.1", source: "default" },
                  changed: false,
                  status: "unknown",
                  issues: [
                    {
                      code: "personal-account-observation-unavailable",
                      severity: "warning",
                      message: "Saved account compatibility could not be inspected.",
                      recovery: "Ask the automation owner to check the saved account.",
                    },
                  ],
                },
              ],
            } satisfies CronModelImpactResult);
            await primary.getByRole("option", { name: "Not set", exact: true }).click();
            await gateway.waitForRequest("cron.modelImpact", {
              match: { model: null, agentId: "main" },
            });
            await pauseVirtualClock(page);
            await modal.getByRole("button", { name: "Change model anyway", exact: true }).click();
            await page.clock.runFor(800);
            const saved = await gateway.waitForRequest("config.set");
            const params = requireRecord(saved.params);
            const savedConfig: unknown = JSON.parse(String(params.raw));
            expect(savedConfig).toMatchObject({
              agents: { entries: { main: { model: { fallbacks: ["openai/gpt-4.1-mini"] } } } },
            });
            expect(
              requireRecord(
                requireRecord(requireRecord(requireRecord(savedConfig).agents).entries).main,
              ).model,
            ).not.toHaveProperty("primary");
            const requests = await gateway.getRequests("config.set");
            expect(requests).toHaveLength(1);
          }
        },
      );
    },
  );
});
