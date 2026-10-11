import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { buildPluginControlUi } from "../../../src/cli/plugins-control-ui-build.js";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  reconnectMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const pluginRoot = fileURLToPath(new URL("../../../extensions/x/", import.meta.url));
const assets = new Map<string, Buffer>();
const assetRoot = "/__openclaw__/plugins/control-ui/x/solid-proof";
let styles: string[] = [];
const suite = createControlUiE2eSuite({
  name: "X native plugin",
  resources: {
    async run() {
      const build = await buildPluginControlUi({
        rootDir: pluginRoot,
        source: "src/control-ui.tsx",
      });
      const directory = path.dirname(path.join(pluginRoot, build.entry));
      for (const name of await readdir(directory)) {
        assets.set(name, await readFile(path.join(directory, name)));
      }
      styles = (build.styles ?? []).map((file) => `${assetRoot}/${path.basename(file)}`);
    },
  },
});

function snapshot(accountId = "primary") {
  return {
    accountId,
    accounts: [
      { accountId: "primary", username: "example_bot" },
      { accountId: "secondary", username: "example_help" },
    ],
    entries: [
      {
        userId: "101",
        username: accountId === "primary" ? "example_maint" : "example_helper",
        name: "Example maintainer",
        configured: true,
        editable: false,
      },
    ],
    guests: {
      enabled: false,
      helpersAvailable: true,
      maxMentionsPerAuthorPerDay: 5,
      admittedToday: 2,
      rateLimitedToday: 1,
    },
    spend: {
      dayUsd: 0.25,
      cycleUsd: 2.5,
      dailyLimitUsd: 5,
      monthlyLimitUsd: 50,
      cycleStart: "2026-10-01",
    },
  };
}

suite.define(() => {
  it("builds and mounts X, manages accounts, and retires pending reads with their authority", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 1000 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const catalog = {
          revision: "solid-proof",
          diagnostics: [],
          plugins: [
            {
              pluginId: "x",
              name: "X",
              revision: "solid-proof",
              entryUrl: `${assetRoot}/index.js`,
              styles,
            },
          ],
        };
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.admin"],
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "plugins.controlUi.list",
            "plugins.controlUi.report",
            "x.allowlist.list",
            "x.allowlist.add",
            "x.allowlist.remove",
            "x.guests.set",
          ],
          methodResponses: {
            "plugins.list": { plugins: [], diagnostics: [], mutationAllowed: true },
            "plugins.catalog.browse": { items: [] },
            "plugins.catalog.categories": { categories: [] },
            "plugins.controlUi.list": catalog,
            "plugins.controlUi.report": { ok: true },
            "x.allowlist.list": snapshot(),
          },
        });
        await page.route(`**${assetRoot}/*`, async (route) => {
          const name = path.basename(new URL(route.request().url()).pathname);
          const body = assets.get(name);
          if (!body) {
            throw new Error(`Missing built X asset: ${name}`);
          }
          await route.fulfill({
            status: 200,
            contentType: name.endsWith(".css") ? "text/css" : "text/javascript",
            body,
          });
        });
        await page.goto(`${suite.server.baseUrl}plugin?plugin=x&id=replies`);
        const surface = page.locator(".x-replies");
        const account = surface.getByRole("combobox", { name: "Bot account" });
        const handle = surface.getByRole("textbox", { name: "Add by X handle" });
        const guestMode = surface.getByRole("switch", { name: "Guest mode" });
        await surface.getByText("@example_maint", { exact: true }).waitFor();
        const retainedRow = await surface
          .getByRole("row")
          .filter({ hasText: "@example_maint" })
          .elementHandle();
        expect(await account.inputValue()).toBe("primary");
        expect(await surface.getByText("Read-only", { exact: true }).count()).toBe(1);
        expect((await gateway.waitForRequest("plugins.controlUi.report")).params).toMatchObject({
          pluginId: "x",
          status: "activated",
        });

        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          for (const viewport of [
            { width: 1280, height: 1000 },
            { width: 390, height: 844 },
          ]) {
            const frame = await takeControlUiScreenshotFrame(
              page,
              surface,
              [surface.getByRole("heading", { name: "X replies", exact: true }), handle, guestMode],
              { animations: "disabled", viewport },
            );
            await writeFile(
              path.join(suite.artifactDir, `x-replies-${viewport.width}.png`),
              frame.png,
            );
          }
          await page.setViewportSize({ width: 1280, height: 1000 });
        }

        const added = snapshot();
        added.entries.push({
          userId: "202",
          username: "example_new",
          name: "Example contributor",
          configured: false,
          editable: true,
        });
        await gateway.setMethodResponse("x.allowlist.add", added);
        await handle.fill("@example_new");
        await surface.getByRole("button", { name: "Add account", exact: true }).click();
        expect((await gateway.waitForRequest("x.allowlist.add")).params).toEqual({
          accountId: "primary",
          username: "@example_new",
        });
        await surface.getByText("@example_new", { exact: true }).waitFor();
        expect(await retainedRow?.evaluate((element) => element.isConnected)).toBe(true);
        await expect.poll(() => handle.inputValue()).toBe("");
        await surface.getByText("Account added. Its mentions can now receive replies.").waitFor();

        await gateway.setMethodResponse("x.allowlist.remove", snapshot());
        await surface
          .getByRole("button", { name: "Remove stored entry for @example_new", exact: true })
          .click();
        expect((await gateway.waitForRequest("x.allowlist.remove")).params).toEqual({
          accountId: "primary",
          userId: "202",
        });
        await surface.getByText("@example_new", { exact: true }).waitFor({ state: "detached" });

        const guests = snapshot();
        guests.guests.enabled = true;
        await gateway.setMethodResponse("x.guests.set", guests);
        await guestMode.click();
        expect((await gateway.waitForRequest("x.guests.set")).params).toEqual({
          accountId: "primary",
          enabled: true,
        });
        await expect.poll(() => guestMode.getAttribute("aria-checked")).toBe("true");

        await gateway.setMethodResponse("x.allowlist.list", snapshot("secondary"));
        await account.selectOption("secondary");
        await gateway.waitForRequest("x.allowlist.list", { match: { accountId: "secondary" } });
        await surface.getByText("@example_helper", { exact: true }).waitFor();
        expect(await surface.getByText("@example_maint", { exact: true }).count()).toBe(0);

        const pending = await gateway.deferNext("x.allowlist.list");
        await surface.getByRole("button", { name: "Refresh", exact: true }).click();
        await gateway.waitForRequest("x.allowlist.list", { after: pending });
        await gateway.setOperatorScopes(["operator.read"]);
        await reconnectMockGateway(page, gateway);
        const denied = surface.getByText("Administrator access is required to manage X replies.");
        await denied.waitFor();
        await gateway.resolveDeferred("x.allowlist.list", added);
        expect(await handle.count()).toBe(0);
        expect(await denied.isVisible()).toBe(true);

        await gateway.setOperatorScopes(["operator.admin"]);
        await reconnectMockGateway(page, gateway);
        await surface.getByText("@example_helper", { exact: true }).waitFor();
        const retired = await gateway.deferNext("x.allowlist.list");
        await surface.getByRole("button", { name: "Refresh", exact: true }).click();
        await gateway.waitForRequest("x.allowlist.list", { after: retired });
        await page.getByRole("link", { name: "Plugins", exact: true }).click();
        await surface.waitFor({ state: "detached" });
        await gateway.resolveDeferred("x.allowlist.list", added);
        await page.getByRole("button", { name: "Pages", exact: true }).click();
        await page
          .locator(".sidebar-pages")
          .getByRole("link", { name: "X replies", exact: true })
          .click();
        await surface.getByText("@example_helper", { exact: true }).waitFor();
        expect(await surface.getByText("@example_new", { exact: true }).count()).toBe(0);
        expect(pageErrors).toEqual([]);
      },
    );
  });
});
