// Real Control UI routing and rendering; Gateway and provider replies are synthetic fixtures.
import { expect, it } from "vitest";
import type { MigrationsMemoryPlanResult } from "../../../packages/gateway-protocol/src/schema/migrations.js";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  activated,
  candidate,
  makeDetection,
  setupRpc as rpc,
} from "./model-setup-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "AI connection leaves history opt-in",
  startServerBeforeBrowser: true,
});

const memoryPlan: MigrationsMemoryPlanResult = {
  agentId: "main",
  workspace: "/synthetic/workspace",
  providers: [
    {
      providerId: "codex",
      label: "Codex",
      planFingerprint: "a".repeat(64),
      found: true,
      source: "/synthetic/codex",
      target: "/synthetic/workspace",
      summary: {
        total: 1,
        planned: 1,
        migrated: 0,
        skipped: 0,
        conflicts: 0,
        errors: 0,
        sensitive: 0,
      },
      items: [
        { id: "memory:codex:MEMORY.md", status: "planned", source: "/synthetic/codex/MEMORY.md" },
      ],
    },
  ],
};

suite.define(() => {
  it("connects AI without history questions and imports memory only when asked", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [
          ...defaultControlUiFeatureMethods,
          rpc.detect,
          rpc.activate,
          rpc.next,
          "migrations.memory.plan",
          "migrations.memory.apply",
        ],
        methodResponses: {
          // The Gateway still reports native catalogs that need a first-time choice.
          [rpc.detect]: makeDetection({
            candidates: [candidate("codex-cli", "Codex", "openai/gpt-5", { recommended: true })],
            nativeSessionCatalogs: [
              { pluginId: "anthropic", label: "Claude Code" },
              { pluginId: "codex", label: "Codex" },
            ],
            nativeSessionCatalogPreferenceRequired: true,
          }),
          [rpc.activate]: activated("openai/gpt-5"),
          "migrations.memory.plan": memoryPlan,
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
      const codex = page.locator('[data-candidate-kind="codex-cli"] button');
      await codex.waitFor();
      expect(await page.getByText("Find existing sessions").count()).toBe(0);
      expect(await page.locator(".model-setup input[type=checkbox]").count()).toBe(0);
      await codex.click();
      const activation = (await gateway.waitForRequest(rpc.activate)).params;
      expect(activation).toMatchObject({ kind: "codex-cli", modelRef: "openai/gpt-5" });
      expect(activation).not.toHaveProperty("nativeSessionCatalogsEnabled");
      await page.getByRole("heading", { name: "Model verified" }).waitFor();

      // Onboarding mode used to plan and offer a memory import here.
      await page.evaluate(() =>
        window.openclawControlUi!.navigate("new-session", {
          pathname: "/new",
          search: "?onboarding=1",
          hash: "",
        }),
      );
      await waitForControlUiRoute(page, { pathname: "/new", routeId: "new-session" });
      await gateway.waitForRequest("agents.list");
      await page.waitForTimeout(500);
      expect(await gateway.getRequests("migrations.memory.plan")).toHaveLength(0);
      expect(await page.getByText("Bring your agent memory with you").count()).toBe(0);

      // The voluntary page names the source and destination, and Cancel copies nothing.
      await page.evaluate(() => window.openclawControlUi!.navigate("memory-import"));
      await gateway.waitForRequest("migrations.memory.plan");
      const provider = page.locator('[data-provider-id="codex"]');
      await provider.getByText("/synthetic/codex", { exact: true }).waitFor();
      await provider.getByText("/synthetic/workspace/memory/imports/", { exact: true }).waitFor();
      await provider.locator('[data-test-id="memory-import-provider-button"]').click();
      const confirm = page.locator(".memory-import__confirm");
      await confirm.getByText("Import from Codex?").first().waitFor();
      await expect
        .poll(() => confirm.textContent())
        .toContain("Copy 1 selected memory files into this agent workspace.");
      await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
      await confirm.waitFor({ state: "detached" });
      expect(await gateway.getRequests("migrations.memory.apply")).toHaveLength(0);
    });
  });
});
