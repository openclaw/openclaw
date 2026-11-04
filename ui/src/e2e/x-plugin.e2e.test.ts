import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  reconnectMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { openSidebarPages } from "./sidebar-customization.test-support.ts";

const pluginRoot = fileURLToPath(new URL("../../../extensions/x/", import.meta.url));
const suite = createControlUiE2eSuite({ name: "X native plugin" });
const desktop = { width: 1280, height: 1000 };

function snapshot(accountId = "primary", enabled = false) {
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
      enabled,
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
      { viewport: desktop, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const gateway = await installMockGateway(page, {
          nativePlugins: [{ pluginId: "x", rootDir: pluginRoot, source: "src/control-ui.tsx" }],
          operatorScopes: ["operator.admin"],
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "x.allowlist.list",
            "x.allowlist.add",
            "x.allowlist.remove",
            "x.guests.set",
          ],
          methodResponses: {
            "plugins.list": { plugins: [], diagnostics: [], mutationAllowed: true },
            "x.allowlist.list": snapshot(),
          },
        });
        await page.goto(`${suite.server.baseUrl}plugin?plugin=x&id=replies`);
        const surface = page.locator(".x-replies");
        const button = (name: string) => surface.getByRole("button", { name, exact: true });
        const expectMutation = async (method: string, fields: Record<string, unknown>) => {
          expect((await gateway.waitForRequest(method)).params).toEqual({
            accountId: "primary",
            ...fields,
          });
        };
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
          reports: [{ pluginId: "x", status: "activated" }],
        });

        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          for (const viewport of [desktop, { width: 390, height: 844 }]) {
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
          await page.setViewportSize(desktop);
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
        await button("Add account").click();
        await expectMutation("x.allowlist.add", { username: "@example_new" });
        await surface.getByText("@example_new", { exact: true }).waitFor();
        expect(await retainedRow?.evaluate((element) => element.isConnected)).toBe(true);
        await expect.poll(() => handle.inputValue()).toBe("");
        await surface.getByText("Account added. Its mentions can now receive replies.").waitFor();

        await gateway.setMethodResponse("x.allowlist.remove", snapshot());
        await button("Remove stored entry for @example_new").click();
        await expectMutation("x.allowlist.remove", { userId: "202" });
        await surface.getByText("@example_new", { exact: true }).waitFor({ state: "detached" });

        await gateway.setMethodResponse("x.guests.set", snapshot("primary", true));
        await guestMode.click();
        await expectMutation("x.guests.set", { enabled: true });
        await expect.poll(() => guestMode.getAttribute("aria-checked")).toBe("true");

        await gateway.setMethodResponse("x.allowlist.list", snapshot("secondary"));
        await account.selectOption("secondary");
        await gateway.waitForRequest("x.allowlist.list", { match: { accountId: "secondary" } });
        await surface.getByText("@example_helper", { exact: true }).waitFor();
        expect(await surface.getByText("@example_maint", { exact: true }).count()).toBe(0);

        const pending = await gateway.deferNext("x.allowlist.list");
        await button("Refresh").click();
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
        await button("Refresh").click();
        await gateway.waitForRequest("x.allowlist.list", { after: retired });
        const pages = await openSidebarPages(page);
        await pages.getByRole("link", { name: "Plugins", exact: true }).click();
        await surface.waitFor({ state: "detached" });
        await gateway.resolveDeferred("x.allowlist.list", added);
        await openSidebarPages(page);
        await pages.getByRole("link", { name: "X replies", exact: true }).click();
        await surface.getByText("@example_helper", { exact: true }).waitFor();
        expect(await surface.getByText("@example_new", { exact: true }).count()).toBe(0);
        expect(pageErrors).toEqual([]);
      },
    );
  });
});
