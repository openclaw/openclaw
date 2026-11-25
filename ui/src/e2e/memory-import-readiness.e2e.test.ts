import { expect, it } from "vitest";
import type { MigrationsMemoryPlanResult } from "../../../packages/gateway-protocol/src/schema/migrations.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { agentRoster } from "./agent-roster.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Memory import readiness",
  startServerBeforeBrowser: true,
});
const summary = {
  total: 0,
  planned: 0,
  migrated: 0,
  skipped: 0,
  conflicts: 0,
  errors: 0,
  sensitive: 0,
};
const plan: MigrationsMemoryPlanResult = {
  agentId: "main",
  workspace: "/tmp/synthetic-workspace",
  providers: [
    {
      providerId: "claude",
      label: "Claude",
      found: false,
      error: "Cannot read memory source: permission denied",
      summary,
      items: [],
    },
  ],
};

suite.define(() => {
  it("fits a short destination agent and paths beside their labels on a phone", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "agents.list": agentRoster({ main: "Molty", writer: "Writer" }, "main", "agent"),
          "migrations.memory.plan": {
            ...plan,
            providers: [
              {
                providerId: "codex",
                label: "Codex",
                found: true,
                source: "/studio/notes",
                target: "/studio",
                summary,
                items: [],
              },
            ],
          },
        },
      });
      await page.goto(new URL("/memory-import", suite.server.baseUrl).toString());
      const host = page.locator(".memory-import");
      await host.getByText("/studio/memory/imports/", { exact: true }).waitFor();
      const rows = host
        .locator(".settings-row")
        .filter({ has: page.locator(".agent-select__trigger, .settings-row__value") });
      expect(await rows.count()).toBe(3);
      for (const row of await rows.all()) {
        const label = await row.locator(".settings-row__title").boundingBox();
        const value = await row
          .locator(".agent-select__trigger, .settings-row__value")
          .boundingBox();
        expect(label!.y + label!.height / 2).toBeCloseTo(value!.y + value!.height / 2, 0);
      }
    });
  });

  it("does not claim a provider was not found when its memory scan failed", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: { "migrations.memory.plan": plan },
      });
      await page.goto(new URL("/memory-import", suite.server.baseUrl).toString());
      await gateway.waitForRequest("migrations.memory.plan");
      const provider = page.locator('[data-provider-id="claude"]');
      const error = provider.getByRole("alert");
      await expect.poll(() => error.textContent()).toContain("permission denied");
      expect(await provider.getByText("Not found", { exact: true }).count()).toBe(0);
      expect(
        await provider
          .getByText("No memory to import yet on this computer.", { exact: true })
          .count(),
      ).toBe(0);
      expect(await provider.locator('[data-test-id="memory-import-provider-button"]').count()).toBe(
        0,
      );

      const missing: MigrationsMemoryPlanResult = {
        ...plan,
        providers: [{ providerId: "claude", label: "Claude", found: false, summary, items: [] }],
      };
      await gateway.setMethodResponse("migrations.memory.plan", missing);
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await provider
        .getByText("No memory to import yet on this computer.", { exact: true })
        .waitFor();
      expect(await provider.getByText("Not found", { exact: true }).count()).toBe(1);
      expect(await error.count()).toBe(0);

      const available: MigrationsMemoryPlanResult = {
        ...plan,
        providers: [
          {
            providerId: "claude",
            label: "Claude",
            found: true,
            planFingerprint: "a".repeat(64),
            summary: { ...summary, total: 1, planned: 1 },
            items: [
              { id: "claude-memory", source: "/tmp/synthetic-memory/MEMORY.md", status: "planned" },
            ],
          },
        ],
      };
      await gateway.setMethodResponse("migrations.memory.plan", available);
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await provider.locator('[data-test-id="memory-import-provider-button"]').waitFor();
      await expect.poll(() => provider.textContent()).toContain("1 file");
      expect(await provider.getByText("Not found", { exact: true }).count()).toBe(0);
      expect(await gateway.getRequests("migrations.memory.apply")).toHaveLength(0);
    });
  });
});
