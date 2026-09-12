import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import config from "../../../test/fixtures/config-corpus/provider-partially-unavailable.json" with { type: "json" };
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.ts";
import type { ModelCatalogResult } from "../api/types.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

let instance: OpenClawTestInstance;
const tempDirs = createTempDirTracker();
const suite = createControlUiE2eSuite({
  name: "Partial refresh with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const mockProvider = path.join(tempDirs.make("partial-refresh-provider-"), "copilot.mjs");
    await fs.writeFile(
      mockProvider,
      `
      const fetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.href === "https://api.github.com/copilot_internal/user") {
          return Promise.resolve(new Response("Fixture provider unavailable", { status: 503 }));
        }
        if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
          return fetch(input, init);
        }
        throw new Error("Unexpected external request in partial-refresh fixture");
      };
    `,
    );
    instance = await createOpenClawTestInstance({
      name: "partial-refresh",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        VITEST: undefined,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${mockProvider}`,
      },
      config: {
        ...config,
        gateway: { ...config.gateway, controlUi: { enabled: true } },
        models: { ...config.models, catalogRefresh: { enabled: false } },
        cron: { enabled: false },
      },
    });
    try {
      await instance.startGateway();
      return {
        baseUrl: `http://127.0.0.1:${instance.port}/`,
        close: async () => {
          await instance.cleanup();
          tempDirs.cleanup();
        },
      };
    } catch (error) {
      await instance.cleanup();
      tempDirs.cleanup();
      throw error;
    }
  },
});

suite.define(() => {
  it("retains existing-chat controls after another provider fails to refresh", async () => {
    const call = async (method: string, params: Record<string, unknown>) => {
      const result = await instance.cli([
        "gateway",
        "call",
        method,
        "--json",
        "--timeout",
        "30000",
        "--params",
        JSON.stringify(params),
      ]);
      expect(result.code, result.stderr).toBe(0);
      return result.stdout;
    };
    const key = "agent:main:partial-refresh";
    await call("sessions.create", {
      key,
      agentId: "main",
      label: "Partial refresh",
      model: "openai/gpt-5.4",
    });
    await call("sessions.patch", { key, thinkingLevel: "high" });
    let catalog: ModelCatalogResult = JSON.parse(
      await call("models.list", { agentId: "main", view: "configured", refresh: true }),
    );
    // Assert the completed failure, not the bounded foreground pending snapshot.
    await expect
      .poll(async () => {
        if (catalog.pendingProviders?.length) {
          catalog = JSON.parse(await call("models.list", { agentId: "main", view: "configured" }));
        }
        return catalog.pendingProviders ?? [];
      })
      .toEqual([]);
    await fs.writeFile(
      path.join(suite.artifactDir, "models-list.json"),
      JSON.stringify(catalog, null, 2),
    );
    expect(catalog.refreshFailed).toBe(true);
    expect(catalog.providerOutcomes).toContainEqual({
      provider: "github-copilot",
      status: "unavailable",
    });
    expect(catalog.models).toContainEqual(
      expect.objectContaining({ provider: "openai", id: "gpt-5.4", available: true }),
    );
    for (const route of ["new", "chat/main/partial-refresh"]) {
      await suite.withPage(
        { locale: "en-US", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          await page.addInitScript(() => {
            localStorage.setItem(
              "openclaw:control-ui:community-invite",
              JSON.stringify({ dismissedAtMs: 1770000000000 }),
            );
          });
          const dashboard = await instance.cli(["dashboard", "--json"]);
          expect(dashboard.code, dashboard.stderr).toBe(0);
          const { browserUrl }: { browserUrl: string } = JSON.parse(dashboard.stdout);
          const url = new URL(browserUrl);
          url.pathname = `/${route}`;
          await page.goto(url.href);
          await waitForControlUiGatewayReady(page);
          const composer = page.locator(".agent-chat__input").first();
          const model = composer.locator("[data-chat-model-select]");
          await expect.poll(() => model.getAttribute("aria-disabled")).toBe("false");
          await model.click();
          // A failed background refresh must not add chrome above a usable list.
          await composer.locator('[data-chat-model-option="openai/gpt-5.4"]').waitFor();
          expect(await composer.locator("[data-chat-model-catalog-state]").count()).toBe(0);
          const stage = route === "new" ? "new" : "chat";
          await page.screenshot({
            path: path.join(suite.artifactDir, `${stage}-catalog.png`),
            animations: "disabled",
          });
          await model.click();
          await page.screenshot({
            path: path.join(suite.artifactDir, `${stage}-composer.png`),
            animations: "disabled",
          });
          const effort = composer.locator("[data-chat-thinking-select]");
          await expect.poll(() => effort.isVisible()).toBe(true);
          expect(await effort.getAttribute("aria-disabled")).toBe("false");
          await effort.click();
          await expect
            .poll(() => composer.locator("[data-chat-thinking-slider]").isEnabled())
            .toBe(true);
          await page.screenshot({
            path: path.join(suite.artifactDir, `${stage}-effort.png`),
            animations: "disabled",
          });
        },
      );
    }
  }, 120_000);
});
