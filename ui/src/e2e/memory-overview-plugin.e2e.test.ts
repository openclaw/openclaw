import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "playwright/test";
import { it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  startControlUiE2eServer,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Packaged Memory overview" });
suite.define(() => {
  it("loads packaged JS and CSS in the actual Memory route, probes explicitly, and remounts after navigation", async () => {
    await suite.withPage(
      {
        viewport: { width: 1440, height: 1000 },
        locale: "en-US",
        reducedMotion: "reduce",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const assets: Array<{ url: string; status: number }> = [];
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("response", (response) => {
          if (response.url().includes("/assets/plugins/memory-core/")) {
            assets.push({ url: response.url(), status: response.status() });
          }
        });
        const config = {
          agents: { entries: { main: {} } },
          plugins: { slots: { memory: "custom-memory" } },
        };
        const gateway = await installMockGateway(page, {
          assistantAgentId: "main",
          defaultAgentId: "main",
          communityInvite: false,
          methodResponses: {
            "config.get": {
              config,
              sourceConfig: config,
              hash: "overview-config",
              valid: true,
              issues: [],
              raw: JSON.stringify(config),
            },
            "plugins.list": { plugins: [], diagnostics: [], mutationAllowed: true },
            "plugins.controlUi.list": { plugins: [], diagnostics: [], revision: "empty" },
            "doctor.memory.status": {
              agentId: "main",
              provider: "local",
              embedding: { ok: false, checked: false },
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/memory`);
        await waitForControlUiRoute(page, { routeId: "memory" });
        const overview = page.locator(".memory-overview");
        await expect(overview.getByRole("heading", { name: "Memory is awake" })).toBeVisible();
        await expect(overview).toContainText("custom-memory");
        await expect(overview.locator(".lob-reading-book")).toBeVisible();
        for (const title of ["Embeddings", "Read the dream diary", "Configure memory"]) {
          await expect(overview.locator(".settings-row", { hasText: title })).toHaveCSS(
            "border-top-width",
            "1px",
          );
        }
        expect(assets.some((asset) => asset.url.endsWith(".js") && asset.status === 200)).toBe(
          true,
        );
        expect(assets.some((asset) => asset.url.endsWith(".css") && asset.status === 200)).toBe(
          true,
        );
        const ordinary = await gateway.getRequests("doctor.memory.status");
        expect(ordinary).toHaveLength(1);
        expect(ordinary[0]?.params).toEqual({ agentId: "main" });
        const frame = await takeControlUiScreenshotFrame(
          page,
          overview,
          [
            overview.getByRole("heading", { name: "Memory is awake" }),
            overview.getByRole("button", { name: "Test", exact: true }),
          ],
          { elements: [overview], animations: "disabled" },
        );
        await fs.writeFile(path.join(suite.artifactDir, "memory-overview-after.png"), frame.png);
        await fs.writeFile(
          path.join(suite.artifactDir, "memory-overview-after-crop.png"),
          frame.elements[0]!.png,
        );
        await gateway.setMethodResponse("doctor.memory.status", {
          agentId: "main",
          provider: "local",
          embedding: { ok: false, checked: true, error: "embedding probe failed" },
        });
        await overview.getByRole("button", { name: "Test", exact: true }).click();
        await gateway.waitForRequest("doctor.memory.status", {
          match: { agentId: "main", probe: true },
        });
        await expect(overview).toContainText("embedding probe failed");
        await page.locator("#memory-tab-settings").click();
        await expect(overview).toHaveCount(0);
        await expect(page.locator('link[href*="/assets/plugins/memory-core/"]')).toHaveCount(0);
        await page.locator("#memory-tab-overview").click();
        await expect(overview).toContainText("embedding probe failed");
        expect(await gateway.getRequests("doctor.memory.status")).toHaveLength(3);
        await gateway.setOnline(false);
        await gateway.closeLatest();
        await expect(overview).toContainText("gateway is offline");
        expect(await gateway.getRequests("doctor.memory.status")).toHaveLength(3);
        expect(errors).toEqual([]);
      },
    );
  });
  it.each(["none", "memory-core"])(
    "keeps the packaged overview available for %s without runtime activation",
    async (slot) => {
      await suite.withPage(
        { viewport: { width: 1440, height: 1000 }, locale: "en-US", reducedMotion: "reduce" },
        async ({ page }) => {
          const config = { plugins: { slots: { memory: slot } } };
          const gateway = await installMockGateway(page, {
            communityInvite: false,
            methodResponses: {
              "config.get": {
                config,
                sourceConfig: config,
                hash: "memory-off",
                valid: true,
                issues: [],
                raw: JSON.stringify(config),
              },
              "plugins.list": {
                plugins: [
                  {
                    id: "memory-core",
                    name: "Memory Core",
                    kind: ["memory"],
                    installed: true,
                    enabled: false,
                    state: "disabled",
                  },
                ],
                diagnostics: [],
                mutationAllowed: true,
              },
              "plugins.controlUi.list": { plugins: [], diagnostics: [], revision: "empty" },
              "doctor.memory.status": {
                agentId: "main",
                provider: "local",
                embedding: { ok: false, checked: false },
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}settings/memory`);
          await waitForControlUiRoute(page, { routeId: "memory" });
          await expect(page.getByRole("heading", { name: "Memory is hibernating" })).toBeVisible();
          if (slot === "memory-core") {
            await gateway.waitForRequest("doctor.memory.status");
          }
          expect(await gateway.getRequests("doctor.memory.status")).toHaveLength(
            slot === "none" ? 0 : 1,
          );
          expect(await gateway.getRequests("plugins.controlUi.report")).toHaveLength(0);
        },
      );
    },
  );
});

const sourceSuite = createControlUiE2eSuite({
  name: "Source Memory overview",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});
sourceSuite.define(() => {
  it("loads the actual Memory route from a development server without runtime plugin activation", async () => {
    await sourceSuite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "plugins.controlUi.list": { plugins: [], diagnostics: [], revision: "empty" },
          "doctor.memory.status": {
            agentId: "main",
            provider: "local",
            embedding: { ok: false, checked: false },
          },
        },
      });
      await page.goto(`${sourceSuite.server.baseUrl}settings/memory`);
      await waitForControlUiRoute(page, { routeId: "memory" });
      const overview = page.locator(".memory-overview");
      await expect(overview.getByRole("heading", { name: "Memory is awake" })).toBeVisible();
      await expect(overview.locator(".settings-row", { hasText: "Embeddings" })).toHaveCSS(
        "border-top-width",
        "1px",
      );
      await expect(page.locator('link[href*="/assets/plugins/memory-core/"]')).toHaveCount(1);
      expect(await gateway.getRequests("doctor.memory.status")).toHaveLength(1);
      expect(await gateway.getRequests("plugins.controlUi.report")).toHaveLength(0);
      expect(errors).toEqual([]);
    });
  });
});
