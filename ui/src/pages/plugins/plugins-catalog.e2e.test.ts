import { afterAll, beforeAll, expect, it } from "vitest";
import {
  calendarPlugin,
  captureScreenshot,
  describeControlUiE2e,
  installMockGateway,
  inventory,
  newContext,
  pluginMethodResponses,
  pluginMethods,
  readOnlyConnectResponse,
  remoteIconPlugin,
  workboardDisabled,
  server,
  setupPluginsE2e,
  teardownPluginsE2e,
} from "./plugins.e2e.test-support.ts";

describeControlUiE2e("Control UI installed plugin catalog", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it("finds an installed plugin by scoped package identity and opens it by keyboard", async () => {
    const context = await newContext();
    const page = await context.newPage();
    await page.addInitScript(
      ({ gatewayUrl }) => {
        window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl };
      },
      { gatewayUrl: server.baseUrl.replace(/^http/u, "ws") },
    );
    await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.list": inventory([
          workboardDisabled,
          { ...remoteIconPlugin, installed: true, enabled: true, state: "enabled" },
        ]),
      },
    });
    let iconAuthorization = "";
    await page.route("**/__openclaw__/plugin-icon/remote-icon", async (route) => {
      iconAuthorization = route.request().headers().authorization ?? "";
      await route.fulfill({
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path fill="#f97316" d="M4 3h16v18H4z"/></svg>',
        contentType: "image/svg+xml",
        headers: {
          "content-disposition": 'attachment; filename="plugin-icon.svg"',
          "content-security-policy": "default-src 'none'; sandbox",
        },
        status: 200,
      });
    });
    try {
      await page.goto(`${server.baseUrl}settings/plugins`);
      const icon = page.locator('[data-plugin-icon-id="remote-icon"] img');
      await icon.waitFor();
      expect(iconAuthorization).toBe("Bearer e2e-device-token");
      await expect
        .poll(() =>
          icon.evaluate(async (image: HTMLImageElement) => {
            const response = await fetch(image.src);
            return (await response.blob()).type;
          }),
        )
        .toBe("image/png");
      await page
        .getByRole("searchbox", { name: "Search installed plugins" })
        .fill("@openclaw/workboard");
      const row = page.locator('[data-plugin-id="workboard"]');
      await row.waitFor();
      expect(await page.locator(".plugins-settings-row").count()).toBe(1);
      const link = row.getByRole("link");
      expect(await link.getAttribute("href")).toBe("/settings/plugins/workboard");
      await link.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { level: 1, name: "Workboard", exact: true }).waitFor();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/plugins/workboard");
      await captureScreenshot(page, "scoped-package-settings.png");
    } finally {
      await context.close();
    }
  });

  it("keeps installed plugin mutations unavailable to read-only operators", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        connect: readOnlyConnectResponse(),
        "plugins.list": inventory([calendarPlugin]),
      },
    });
    try {
      await page.goto(`${server.baseUrl}settings/plugins/calendar-plus#lifecycle`);
      const toggle = page.getByRole("switch", {
        name: "Enable or disable Calendar Plus",
        exact: true,
      });
      await toggle.waitFor();
      expect(await page.locator("wa-switch.settings-toggle").getAttribute("aria-disabled")).toBe(
        "true",
      );
      for (const name of ["Reload Calendar Plus", "Uninstall Calendar Plus"]) {
        const action = page.getByRole("button", { name, exact: true });
        await action.waitFor();
        expect(await action.getAttribute("aria-disabled")).toBe("true");
      }
      expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(0);
      expect(await gateway.getRequests("plugins.reload")).toHaveLength(0);
      expect(await gateway.getRequests("plugins.uninstall")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("shows an inventory failure and retries the authoritative request", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.list": {
          __mockError: {
            code: "UNAVAILABLE",
            message: "Plugin inventory unavailable",
            retryable: true,
          },
        },
      },
    });
    try {
      await page.goto(`${server.baseUrl}settings/plugins`);
      const error = page.locator(".plugins-settings-error");
      await error.getByText("Plugin inventory unavailable", { exact: true }).waitFor();
      const requests = (await gateway.getRequests("plugins.list")).length;
      await gateway.setMethodResponse("plugins.list", inventory([calendarPlugin]));
      await error.getByRole("button", { name: "Try again" }).click();
      expect((await gateway.waitForRequest("plugins.list", { after: requests })).params).toEqual(
        {},
      );
      await page.locator('[data-plugin-id="calendar-plus"]').waitFor();
      await error.waitFor({ state: "detached" });
    } finally {
      await context.close();
    }
  });
});
