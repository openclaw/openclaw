// Control UI tests cover memory engine ordering and serialized config writes.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createDarkDesktopControlUiContextOptions } from "./control-ui-browser-options.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI memory engine settings mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let uiProofArtifactDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    uiProofArtifactDir = createControlUiE2eArtifactDir("memory-settings-engine");
  }
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
  {
    id: "memory-lancedb",
    name: "Memory LanceDB",
    installed: true,
    enabled: true,
    state: "enabled",
    kind: ["memory"],
  },
  {
    id: "memory-core",
    // The UI owns this product label; catalog ids/names are implementation detail.
    name: "memory-core",
    installed: true,
    enabled: true,
    state: "enabled",
    kind: ["memory"],
  },
];

suite.define(() => {
  it.each(["success", "failure"] as const)(
    "keeps engine focus and blocks repeated selection until save %s",
    async (outcome) => {
      const viewport = { height: 900, width: 1440 };
      await suite.withPage(
        {
          colorScheme: "dark",
          locale: "en-US",
          serviceWorkers: "block",
          viewport,
          ...(captureUiProofEnabled
            ? { recordVideo: { dir: uiProofArtifactDir, size: viewport } }
            : {}),
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            methodResponses: {
              "config.get": configResponse("memory-lancedb", "focus-before"),
              "plugins.list": { plugins: memoryPlugins, diagnostics: [], mutationAllowed: true },
            },
          });
          await page.goto(`${suite.server.baseUrl}settings/memory/settings`);
          const engine = page.getByRole("combobox", { name: "Memory engine", exact: true });
          await expect.poll(() => engine.inputValue()).toBe("memory-lancedb");
          await engine.focus();
          await gateway.deferNext("plugins.setEnabled");
          await engine.selectOption("memory-core");
          await gateway.waitForRequest("plugins.setEnabled");
          await expect.poll(() => engine.getAttribute("aria-busy")).toBe("true");
          expect(await engine.evaluate((element) => document.activeElement === element)).toBe(true);
          await page.keyboard.press("ArrowDown");
          await page.keyboard.press("Enter");
          expect(await engine.evaluate((element) => document.activeElement === element)).toBe(true);
          expect(await engine.inputValue()).toBe("memory-core");
          if (captureUiProofEnabled) {
            const section = page.locator(".settings-section").filter({ has: engine });
            const frame = await takeControlUiScreenshotFrame(page, section, [engine], {
              animations: "disabled",
            });
            writeFileSync(path.join(uiProofArtifactDir, "saving.png"), frame.png);
          }
          await engine.selectOption("memory-lancedb");
          expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(1);
          expect(await engine.inputValue()).toBe("memory-core");
          if (outcome === "success") {
            await gateway.setMethodResponse(
              "config.get",
              configResponse("memory-core", "focus-after"),
            );
            await gateway.resolveDeferred("plugins.setEnabled", {
              ok: true,
              plugin: memoryPlugins[1],
              restartRequired: false,
            });
          } else {
            await gateway.rejectDeferred("plugins.setEnabled", {
              code: "UNAVAILABLE",
              message: "Memory setting could not be saved",
            });
            await page.getByText("Memory setting could not be saved", { exact: true }).waitFor();
          }
          await expect.poll(() => engine.getAttribute("aria-busy")).toBeNull();
          expect(await engine.inputValue()).toBe(
            outcome === "success" ? "memory-core" : "memory-lancedb",
          );
          expect(await engine.evaluate((element) => document.activeElement === element)).toBe(true);
          expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(1);
        },
      );
    },
  );

  it("config.set keeps the default engine first and drains Off before selecting it", async () => {
    await suite.withPage(createDarkDesktopControlUiContextOptions(), async ({ page }) => {
      const initialConfig = configResponse("memory-lancedb", "memory-hash-1");
      const selectedConfig = configResponse("memory-core", "memory-hash-2");
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": initialConfig,
          "plugins.list": { plugins: memoryPlugins, diagnostics: [], mutationAllowed: true },
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}settings/memory/settings`);
      expect(response?.status()).toBe(200);

      const engineGroup = page.getByRole("combobox", { name: "Memory engine", exact: true });
      await engineGroup.waitFor();
      await expect
        .poll(async () =>
          (await engineGroup.locator("option").allTextContents()).map((label) => label.trim()),
        )
        .toEqual(["OpenClaw Memory", "Memory LanceDB", "Off"]);

      await gateway.deferNext("config.set");
      await gateway.deferNext("plugins.setEnabled");
      await engineGroup.selectOption("");
      // Select again immediately, before the 800 ms autosave debounce. The
      // write barrier must flush Off first instead of letting the plugin RPC
      // race a still-scheduled config.set.
      await engineGroup.selectOption("memory-core");
      expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(0);

      const pendingOffSave = await gateway.waitForRequest("config.set");
      expect(pendingOffSave.params).toMatchObject({ baseHash: "memory-hash-1" });
      if (captureUiProofEnabled) {
        await page
          .locator(".settings-page > .settings-section")
          .first()
          .screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "00-off-write-draining.png"),
          });
      }
      await gateway.resolveDeferred("config.set");
      const enableRequest = await gateway.waitForRequest("plugins.setEnabled");
      expect(enableRequest.params).toEqual({ pluginId: "memory-core", enabled: true });

      await gateway.setMethodResponse("config.get", selectedConfig);
      await gateway.resolveDeferred("plugins.setEnabled", {
        ok: true,
        plugin: memoryPlugins[1],
        restartRequired: false,
      });

      await expect.poll(() => engineGroup.inputValue()).toBe("memory-core");
      await expect
        .poll(() => page.getByText("Couldn’t change the memory engine. Try again.").count())
        .toBe(0);

      if (captureUiProofEnabled) {
        await page
          .locator(".settings-page > .settings-section")
          .first()
          .screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "01-openclaw-memory-selected.png"),
          });
      }
    });
  });

  it("keeps a committed add-on enabled and makes a failed config refresh visible", async () => {
    await suite.withPage(createDarkDesktopControlUiContextOptions(), async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(String(error)));
      const activeMemory = {
        id: "active-memory",
        name: "Active memory",
        installed: true,
        enabled: false,
        state: "disabled",
      };
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": configResponse("memory-lancedb", "memory-refresh-hash-1"),
          "plugins.list": {
            plugins: [...memoryPlugins, activeMemory],
            diagnostics: [],
            mutationAllowed: true,
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/memory/settings`);
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
      await gateway.setMethodResponse("plugins.list", {
        plugins: [...memoryPlugins, committed],
        diagnostics: [],
        mutationAllowed: true,
      });
      await gateway.resolveDeferred("plugins.setEnabled", {
        ok: true,
        plugin: committed,
        restartRequired: false,
      });
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
        .getByText("Couldn’t refresh settings. Try again. authoritative snapshot unavailable")
        .waitFor();
      expect(await page.getByText("Couldn’t update Active memory. Try again.").count()).toBe(0);
      expect(pageErrors).toEqual([]);

      if (captureUiProofEnabled) {
        await page.locator("openclaw-memory-settings").screenshot({
          animations: "disabled",
          path: path.join(uiProofArtifactDir, "03-addon-committed-refresh-warning.png"),
        });
      }
    });
  });

  it("keeps a missing default engine labelled, first, and selected as unavailable", async () => {
    await suite.withPage(createDarkDesktopControlUiContextOptions(), async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "config.get": configResponse("memory-core", "memory-hash-missing-default"),
          "plugins.list": {
            plugins: memoryPlugins.filter((plugin) => plugin.id !== "memory-core"),
            diagnostics: [],
            mutationAllowed: true,
          },
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}settings/memory/settings`);
      expect(response?.status()).toBe(200);

      const engineGroup = page.getByRole("combobox", { name: "Memory engine", exact: true });
      await engineGroup.waitFor();
      await expect
        .poll(async () =>
          (await engineGroup.locator("option").allTextContents()).map((label) => label.trim()),
        )
        .toEqual(["OpenClaw Memory (Unavailable)", "Memory LanceDB", "Off"]);
      await expect.poll(() => engineGroup.inputValue()).toBe("memory-core");

      if (captureUiProofEnabled) {
        await page
          .locator(".settings-page > .settings-section")
          .first()
          .screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "02-configured-engine-unavailable.png"),
          });
      }
    });
  });
});
