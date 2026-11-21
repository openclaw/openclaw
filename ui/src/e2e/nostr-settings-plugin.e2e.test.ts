import { expect } from "playwright/test";
import { it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import {
  configSchema,
  configSnapshot,
  objectSchema,
} from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Packaged Nostr Settings" });
suite.define(() => {
  it("retains the packaged profile editor and uses the real host configuration slot", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 1000 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const initialConfig = { channels: { nostr: { enabled: true } } };
        const snapshot = (revision: number) =>
          configSnapshot(initialConfig, `nostr-config-${revision}`);
        const errors: string[] = [],
          assets: Array<{ url: string; status: number }> = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("response", (response) => {
          if (response.url().includes("/assets/plugins/nostr/")) {
            assets.push({ url: new URL(response.url()).pathname, status: response.status() });
          }
        });
        const writes: Array<[method: string, path: string, body: unknown]> = [];
        await page.route("**/api/channels/nostr/**", async (route) => {
          const request = route.request();
          writes.push([request.method(), new URL(request.url()).pathname, request.postDataJSON()]);
          await route.fulfill({ json: { ok: true, persisted: true } });
        });
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "plugins.list": { plugins: [], diagnostics: [], mutationAllowed: true },
            "plugins.controlUi.list": { plugins: [], diagnostics: [], revision: "empty" },
            "channels.status": {
              ts: 1,
              channelOrder: ["nostr", "other"],
              channelLabels: { nostr: "Nostr", other: "Other" },
              channels: {
                nostr: {
                  configured: true,
                  running: true,
                  publicKey: "npub1examplepublickey",
                  profile: { name: "Alice" },
                },
                other: { configured: true },
              },
              channelAccounts: {
                nostr: [{ accountId: "main/account", configured: true, running: true }],
              },
              channelDefaultAccountId: { nostr: "main/account" },
            },
            "config.get": snapshot(1),
            "config.schema": configSchema(
              objectSchema("", {
                channels: objectSchema("", {
                  nostr: objectSchema("", { enabled: { type: "boolean", title: "Enabled" } }),
                }),
              }),
              { "channels.nostr.enabled": { advanced: false } },
            ),
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/channels`);
        await waitForControlUiRoute(page, { routeId: "channels" });
        const open = async (name = "Nostr") => {
          await page
            .locator("button.channels-item, button.channels-item__detail", { hasText: name })
            .first()
            .click();
          await expect(page.locator(".channels-detail")).toBeVisible();
        };
        await open();
        const detail = page.locator(".channels-detail");
        await expect(detail.getByRole("heading", { name: "Nostr", exact: true })).toBeVisible();
        await detail.getByRole("button", { name: "Edit Profile", exact: true }).waitFor();
        expect(assets.some((asset) => asset.url.endsWith(".js"))).toBe(true);
        expect(assets.every((asset) => asset.status === 200)).toBe(true);
        await expect(detail.locator(".settings-row").first()).toHaveCSS("display", "flex");
        await detail.getByRole("button", { name: "Edit Profile", exact: true }).click();
        await detail.locator("#nostr-profile-name").fill("Alice Updated");
        await detail.locator(".oc-dialog__close").click();
        await open("Other");
        await detail.locator(".oc-dialog__close").click();
        await open();
        await expect(detail.locator("#nostr-profile-name")).toHaveValue("Alice Updated");
        await detail.getByRole("button", { name: "Save & Publish", exact: true }).click();
        await expect(detail).toContainText("Profile published to relays.");
        const emptyProfile = Object.fromEntries(
          ["displayName", "about", "picture", "banner", "website", "nip05", "lud16"].map((key) => [
            key,
            "",
          ]),
        );
        expect(writes).toEqual([
          [
            "PUT",
            "/api/channels/nostr/main%2Faccount/profile",
            { name: "Alice Updated", ...emptyProfile },
          ],
        ]);
        const enabled = detail.getByRole("switch", { name: "Enabled" });
        await expect(enabled).toBeChecked();
        await enabled.click();
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
        const refreshAfter = async (action: () => Promise<unknown>, probe: boolean) => {
          const after = (await gateway.getRequests("channels.status", { probe })).length;
          await action();
          await gateway.waitForRequest("channels.status", { after, match: { probe } });
        };
        await gateway.setMethodResponse("config.patch", {
          ok: true,
          config: { channels: { nostr: { enabled: false } } },
          hash: "nostr-config-1b",
        });
        await refreshAfter(async () => {
          await detail.getByRole("button", { name: "Save", exact: true }).click();
          const saved = await gateway.waitForRequest("config.patch");
          expect(saved.params).toMatchObject({ baseHash: "nostr-config-1" });
          expect(JSON.parse((saved.params as { raw: string }).raw)).toEqual({
            channels: { nostr: { enabled: false } },
          });
        }, true);
        // A change made elsewhere reaches the open form without a manual reload.
        await gateway.setMethodResponse("config.get", snapshot(2));
        const beforeChange = (await gateway.getRequests("config.get")).length;
        await gateway.emitGatewayEvent("config.changed", {});
        await gateway.waitForRequest("config.get", { after: beforeChange });
        await expect(enabled).toBeChecked();
        await refreshAfter(
          () => detail.getByRole("button", { name: "Check connection", exact: true }).click(),
          true,
        );
        expect(await gateway.getRequests("plugins.controlUi.report")).toHaveLength(0);
        expect(errors).toEqual([]);
      },
    );
  });
});
