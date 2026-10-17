import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI memory engine settings mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

function configResponse(engineId: string, hash: string) {
  const config = { plugins: { slots: { memory: engineId } } };
  return {
    config,
    hash,
    appliedConfigHash: hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

const memoryPlugins = [
  { id: "memory-lancedb", name: "Memory LanceDB" },
  // The UI owns this product label, not the catalog name.
  { id: "memory-core", name: "memory-core" },
].map(({ id, name }) => ({
  id,
  name,
  installed: true,
  enabled: true,
  state: "enabled",
  kind: ["memory"],
}));

const desktop = {
  colorScheme: "dark",
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 900, width: 1440 },
} as const;

function pluginCatalog<T>(plugins: T[]) {
  return { plugins, diagnostics: [], mutationAllowed: true };
}

function enabledPlugin<T>(plugin: T) {
  return { ok: true, plugin, restartRequired: false };
}

type MemoryPlugin = Omit<(typeof memoryPlugins)[number], "kind"> & { kind?: string[] };

async function openSettings(
  page: Page,
  engineId: string,
  hash: string,
  plugins: MemoryPlugin[] = memoryPlugins,
) {
  const gateway = await installMockGateway(page, {
    methodResponses: {
      "config.get": configResponse(engineId, hash),
      "plugins.list": pluginCatalog(plugins),
    },
  });
  expect((await page.goto(`${suite.server.baseUrl}settings/memory/settings`))?.status()).toBe(200);
  return gateway;
}

async function capture(
  page: Page,
  name: string,
  target = page.locator(".settings-page > .settings-section").first(),
) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
    await target.screenshot({ animations: "disabled", path: path.join(suite.artifactDir, name) });
  }
}

suite.define(() => {
  it("config.set keeps the default engine first and drains Off before selecting it", async () => {
    await suite.withPage(desktop, async ({ page }) => {
      const gateway = await openSettings(page, "memory-lancedb", "memory-hash-1");
      const engineGroup = page.getByRole("radiogroup").first();
      await engineGroup.waitFor();
      await expect
        .poll(async () =>
          (await engineGroup.locator("label").allTextContents()).map((label) => label.trim()),
        )
        .toEqual(["OpenClaw Memory", "Memory LanceDB", "Off"]);

      await gateway.deferNext("config.set");
      await gateway.deferNext("plugins.setEnabled");
      await engineGroup.getByRole("radio", { name: "Off", exact: true }).click();
      // Before autosave debounce: the write barrier must flush Off before enabling the plugin.
      await engineGroup.getByRole("radio", { name: "OpenClaw Memory", exact: true }).click();
      expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(0);

      const pendingOffSave = await gateway.waitForRequest("config.set");
      expect(pendingOffSave.params).toMatchObject({ baseHash: "memory-hash-1" });
      await capture(page, "00-off-write-draining.png");
      await gateway.resolveDeferred("config.set");
      const enableRequest = await gateway.waitForRequest("plugins.setEnabled");
      expect(enableRequest.params).toEqual({ pluginId: "memory-core", enabled: true });

      await gateway.setMethodResponse("config.get", configResponse("memory-core", "memory-hash-2"));
      await gateway.resolveDeferred("plugins.setEnabled", enabledPlugin(memoryPlugins[1]));

      const selected = engineGroup.getByRole("radio", { name: "OpenClaw Memory", exact: true });
      await expect.poll(() => selected.isChecked()).toBe(true);
      await expect.poll(() => page.getByText("Could not change the memory engine").count()).toBe(0);

      await capture(page, "01-openclaw-memory-selected.png");
    });
  });

  it("keeps a committed add-on enabled and makes a failed config refresh visible", async () => {
    await suite.withPage(desktop, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(String(error)));
      const activeMemory = {
        id: "active-memory",
        name: "Active memory",
        installed: true,
        enabled: false,
        state: "disabled",
      };
      const gateway = await openSettings(page, "memory-lancedb", "memory-refresh-hash-1", [
        ...memoryPlugins,
        activeMemory,
      ]);
      const toggle = page.getByRole("switch", { name: "Enable or disable Active memory" });
      await toggle.waitFor();
      const initialConfigReads = (await gateway.getRequests("config.get")).length;
      const initialCatalogReads = (await gateway.getRequests("plugins.list")).length;
      await gateway.deferNext("plugins.setEnabled");
      await gateway.deferNext("config.get");
      await toggle.click();

      const mutation = await gateway.waitForRequest("plugins.setEnabled");
      expect(mutation.params).toEqual({ pluginId: "active-memory", enabled: true });
      const committed = { ...activeMemory, enabled: true, state: "enabled" };
      await gateway.setMethodResponse("plugins.list", pluginCatalog([...memoryPlugins, committed]));
      await gateway.resolveDeferred("plugins.setEnabled", enabledPlugin(committed));
      await expect
        .poll(async () => (await gateway.getRequests("config.get")).length)
        .toBeGreaterThan(initialConfigReads);
      await gateway.rejectDeferred("config.get", {
        code: "UNAVAILABLE",
        message: "authoritative snapshot unavailable",
      });

      await expect
        .poll(async () => (await gateway.getRequests("plugins.list")).length)
        .toBeGreaterThan(initialCatalogReads);
      await expect.poll(() => toggle.isChecked()).toBe(true);
      await page.getByText("Needs attention", { exact: true }).first().waitFor();
      await page
        .getByText("Could not refresh Control UI configuration: authoritative snapshot unavailable")
        .waitFor();
      expect(await page.getByText("Could not update Active memory").count()).toBe(0);
      expect(pageErrors).toEqual([]);

      await capture(
        page,
        "03-addon-committed-refresh-warning.png",
        page.locator("openclaw-memory-settings"),
      );
    });
  });

  it("keeps a missing default engine labelled, first, and selected as unavailable", async () => {
    await suite.withPage(desktop, async ({ page }) => {
      await openSettings(
        page,
        "memory-core",
        "memory-hash-missing-default",
        memoryPlugins.filter((plugin) => plugin.id !== "memory-core"),
      );
      const engineGroup = page.getByRole("radiogroup").first();
      await engineGroup.waitFor();
      await expect
        .poll(async () =>
          (await engineGroup.locator("label").allTextContents()).map((label) => label.trim()),
        )
        .toEqual(["OpenClaw Memory (Unavailable)", "Memory LanceDB", "Off"]);
      await expect
        .poll(() =>
          engineGroup
            .getByRole("radio", { name: "OpenClaw Memory (Unavailable)", exact: true })
            .isChecked(),
        )
        .toBe(true);

      await capture(page, "02-configured-engine-unavailable.png");
    });
  });
});
