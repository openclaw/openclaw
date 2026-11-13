import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({ name: "Personal QR setup mocked Gateway" });
const person = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Ada",
  role: "viewer",
  effectiveRole: "viewer",
  avatarMime: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
  emails: [],
  githubIdentity: null,
  hasAvatar: false,
};
const roleConfig = {
  gateway: {
    roles: { default: "viewer", definitions: { viewer: { scopes: ["operator.sessions.read"] } } },
  },
};
const setup = {
  setupId: "synthetic-setup",
  setupCode: "synthetic-layout-only-not-a-credential",
  expiresAtMs: Date.now() + 600_000,
  gatewayUrl: "wss://gateway.example",
  auth: "token",
  urlSource: "test",
  access: "limited",
};
suite.define(() => {
  it.each([1280, 390])(
    "issues optional personal limited setup at %s px without claiming admission",
    async (width) => {
      await suite.withPage(
        { viewport: { width, height: 900 }, reducedMotion: "reduce" },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            methodResponses: {
              "device.pair.list": { pending: [], paired: [] },
              "node.list": { nodes: [] },
              "system-presence": [],
              "users.list": { profiles: [person] },
              "config.get": {
                valid: true,
                exists: true,
                hash: "synthetic-config",
                config: roleConfig,
                runtimeConfig: roleConfig,
              },
            },
          });
          await page.goto(suite.server.baseUrl + "settings/devices");
          await page.getByRole("button", { name: "Connect a device", exact: true }).click();
          const dialog = page.locator(".device-pair-setup");
          const generate = dialog.getByRole("button", { name: "Create setup code" });
          await generate.waitFor();
          expect(await gateway.getRequests("device.pair.setupCode")).toHaveLength(0);
          const choice = dialog.getByRole("combobox", { name: "Person represented (optional)" });
          await choice.selectOption(person.id);
          await dialog.getByText("Current person role: viewer.", { exact: false }).waitFor();
          await dialog.getByRole("radio", { name: "Limited access", exact: false }).check();
          if (width === 390) {
            await choice.selectOption("new");
            await dialog.getByRole("textbox", { name: "Name (optional)", exact: true }).fill("Ada");
            await dialog.getByText("Default local role: viewer.", { exact: false }).waitFor();
            await dialog
              .getByText("Combined operator scope ceiling: operator.sessions.read.", {
                exact: false,
              })
              .waitFor();
          }
          if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
            const dir = createControlUiE2eArtifactDir("personal-qr-after-" + width);
            const frame = await takeControlUiScreenshotFrame(page, dialog, [generate], {
              animations: "disabled",
              elements: [dialog],
            });
            await writeFile(path.join(dir, "page.png"), frame.png);
          }
          await gateway.deferNext("device.pair.setupCode");
          await generate.click();
          const first = await gateway.waitForRequest("device.pair.setupCode");
          expect(first.params).toEqual(
            width === 390
              ? {
                  bootstrapProfile: "limited",
                  enrollmentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
                  name: "Ada",
                }
              : { bootstrapProfile: "limited", profileId: person.id },
          );
          await gateway.rejectDeferred("device.pair.setupCode", {
            code: "UNAVAILABLE",
            message: "Synthetic uncertain issuance",
            retryable: true,
          });
          await dialog.getByText("Issuance may have completed.", { exact: false }).waitFor();
          expect(await choice.count()).toBe(0);
          expect(await gateway.getRequests("device.pair.setupCode")).toHaveLength(1);
          await gateway.deferNext("device.pair.setupCode");
          await dialog.getByRole("button", { name: "Reload", exact: true }).click();
          const retry = await gateway.waitForRequest("device.pair.setupCode", { after: 1 });
          expect(retry.params).toEqual(first.params);
          await gateway.resolveDeferred("device.pair.setupCode", setup);
          await dialog
            .getByText("The new client must still finish connecting", { exact: false })
            .waitFor();
          await gateway.emitGatewayEvent("device.pair.setup.completed", {
            setupId: setup.setupId,
            deviceName: "Synthetic phone",
            access: "limited",
          });
          await dialog
            .getByText("Setup delivered — finish connecting on the new device", { exact: false })
            .waitFor();
          expect(await dialog.getByText("Device connected", { exact: true }).count()).toBe(0);
        },
      );
    },
  );
  it("clears the personal draft for node-only issuance", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "device.pair.list": { pending: [], paired: [] },
          "node.list": { nodes: [] },
          "users.list": { profiles: [person] },
          "device.pair.setupCode": { ...setup, access: "node" },
        },
      });
      await page.goto(suite.server.baseUrl + "settings/devices");
      await page.getByRole("button", { name: "Connect a device", exact: true }).click();
      const dialog = page.locator(".device-pair-setup");
      await dialog.getByRole("combobox").selectOption(person.id);
      await dialog.getByRole("radio", { name: "Device Let agents", exact: false }).check();
      expect(await dialog.getByRole("combobox").count()).toBe(0);
      await dialog.getByRole("button", { name: "Create setup code", exact: true }).click();
      const request = await gateway.waitForRequest("device.pair.setupCode");
      expect(request.params).toEqual({ bootstrapProfile: "node", includeQr: false });
    });
  });
});
