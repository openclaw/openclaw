import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { captureUiProof } from "./chat-flow.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI device alias rename mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

function waitForPhase(page: Page, phase: string) {
  return page.waitForFunction(
    (expected) => window.openclawControlUi?.snapshot().gatewayPhase === expected,
    phase,
  );
}

const DEVICE_ID = "synthetic-office-workstation";

function pairedDevice(operatorLabel?: string) {
  return {
    deviceId: DEVICE_ID,
    displayName: "office-workstation.example.test",
    ...(operatorLabel ? { operatorLabel } : {}),
    roles: ["node", "operator"],
  };
}

suite.define(() => {
  it("names the Gateway host in this browser without pairing or changing placement", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const machine = "IT-MAC-7284";
      const alias = "Work Mac";
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.write"],
        featureMethods: ["chat.startup", "chat.metadata", "sessions.create", "system.info"],
        methodResponses: {
          "environments.list": { environments: [], profiles: [] },
          "node.list": { nodes: [] },
          "system-presence": [{ host: machine, mode: "gateway", platform: "darwin", ts: 1 }],
          "sessions.create": { key: "agent:main:gateway-alias-proof" },
          "system.info": {
            machineName: machine,
            hostname: "it-mac-7284.local",
            platform: "darwin",
          },
        },
      });
      const where = page.locator("#new-session-where-trigger");
      const whereLabel = where.locator(".new-session-page__trigger-label");
      const local = page.locator('.new-session-page__where-popover [data-value="gateway"]');
      const openPlace = async (name: string) => {
        await expect.poll(() => whereLabel.textContent()).toBe(name);
        await where.click();
        await local.waitFor();
        expect(await local.textContent()).toContain(name);
      };
      const openDevices = async (name: string) => {
        await page.goto(suite.server.baseUrl + "settings/devices");
        await waitForControlUiRoute(page, { pathname: "/settings/devices", routeId: "devices" });
        const row = page.locator(".device-entry", { hasText: name });
        await row.locator(":scope > summary").click();
        return row;
      };
      await page.goto(suite.server.baseUrl + "new");
      await openPlace(machine);
      await captureUiProof(suite, page, "gateway-alias", "place-default.png");

      const row = await openDevices(machine);
      await captureUiProof(suite, page, "gateway-alias", "devices-default.png");
      const editAlias = row.getByRole("button", { name: "Edit alias", exact: true });
      await expect.poll(() => editAlias.isEnabled({ timeout: 200 })).toBe(true);
      await editAlias.click();
      const dialog = page.locator("openclaw-modal-dialog").last();
      const input = dialog.locator('input[name="value"]');
      const save = dialog.getByRole("button", { name: "Save", exact: true });
      await input.fill("x".repeat(65));
      await save.click();
      await dialog.getByRole("alert").waitFor();
      expect(await input.inputValue()).toHaveLength(65);
      await input.fill("  " + alias + "  ");
      await captureUiProof(suite, page, "gateway-alias", "edit-dialog.png");
      await save.click();
      await dialog.waitFor({ state: "hidden" });
      const renamed = page.locator(".device-entry", { hasText: alias });
      await renamed.locator(":scope > summary").getByText(alias, { exact: true }).waitFor();
      expect(await renamed.getByText(machine, { exact: true }).isVisible()).toBe(true);
      await captureUiProof(suite, page, "gateway-alias", "devices-alias.png");

      await page.goto(suite.server.baseUrl + "new");
      await openPlace(alias);
      await captureUiProof(suite, page, "gateway-alias", "place-alias.png");
      const search = page.getByRole("searchbox", { name: "Search devices" });
      await search.fill(machine);
      await local.click();
      await expect.poll(() => whereLabel.textContent()).toBe(alias);
      await page.reload();
      await openPlace(alias);
      await local.click();
      await page.locator(".new-session-page__message").fill("Keep running on the same machine");
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "Keep running on the same machine",
      });
      expect(create.params).not.toHaveProperty("execNode");
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);

      const persisted = await openDevices(alias);
      await persisted.getByRole("button", { name: "Edit alias", exact: true }).click();
      expect(await input.inputValue()).toBe(alias);
      await input.fill("Unsaved name");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await persisted.getByRole("button", { name: "Edit alias", exact: true }).click();
      expect(await input.inputValue()).toBe(alias);
      await input.fill("   ");
      await save.click();
      await dialog.waitFor({ state: "hidden" });
      await row.locator(":scope > summary").getByText(machine, { exact: true }).waitFor();
      await page.goto(suite.server.baseUrl + "new");
      await openPlace(machine);
      expect(await gateway.getRequests("device.pair.rename")).toHaveLength(0);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
    });
  });

  it("retries a rejected alias rename and retains unsaved edits until client replacement", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const rename = { deviceId: DEVICE_ID, label: "Office node" };
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "device.pair.list": { pending: [], paired: [pairedDevice()] },
          "device.pair.rename": rename,
          "environments.list": { environments: [] },
          "exec.approvals.get": {
            exists: false,
            file: { agents: {}, defaults: {}, version: 1 },
            hash: "e2e",
            path: "/tmp/exec-approvals.json",
          },
          "node.list": { nodes: [] },
          "system-presence": [],
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/devices`);
      await waitForControlUiRoute(page, { pathname: "/settings/devices", routeId: "devices" });

      const row = page.locator(".device-entry", { hasText: "office-workstation.example.test" });
      const openAlias = async (entry = row) => {
        // A row stays open through its own rename.
        if (!(await entry.evaluate((element) => (element as HTMLDetailsElement).open))) {
          await entry.locator(":scope > summary").click();
        }
        await entry.getByRole("button", { name: "Edit alias", exact: true }).click();
      };
      await row.waitFor();

      await openAlias();
      const dialog = page.locator("openclaw-modal-dialog").last();
      const input = dialog.locator('input[name="value"]');
      const save = dialog.getByRole("button", { name: "Save" });
      const submit = async (after: number) => {
        await save.click();
        const request = await gateway.waitForRequest("device.pair.rename", { after });
        expect(request.params).toEqual(rename);
      };
      await input.waitFor();
      await input.fill("Office node");
      const renamesBefore = await gateway.deferNext("device.pair.rename");
      await submit(renamesBefore);

      await gateway.rejectDeferred("device.pair.rename", { message: "Alias change rejected" });
      const failure = dialog.getByRole("alert");
      await failure.waitFor();
      expect(await failure.textContent()).toContain("Alias change rejected");
      expect(await input.inputValue()).toBe("Office node");
      expect(await save.isEnabled()).toBe(true);

      await submit(await gateway.deferNext("device.pair.rename"));
      // Publish the new list before releasing success so the refresh has no race.
      await gateway.setMethodResponse("device.pair.list", {
        pending: [],
        paired: [pairedDevice("Office node")],
      });
      await gateway.resolveDeferred("device.pair.rename", rename);

      await page
        .locator(".device-entry .settings-row__title", { hasText: "Office node" })
        .waitFor();
      await dialog.waitFor({ state: "hidden" });
      const renamedRow = page.locator(".device-entry", { hasText: "Office node" });
      await openAlias(renamedRow);
      await input.fill("Unsaved alias");
      const socketsBefore = await gateway.getSocketCount();
      const connectsBefore = await gateway.deferNext("connect");
      await gateway.closeLatest();
      await gateway.waitForRequest("connect", { after: connectsBefore });
      await waitForPhase(page, "reconnecting");
      expect(await dialog.isVisible()).toBe(true);
      expect(await input.inputValue()).toBe("Unsaved alias");
      expect(await input.isEditable()).toBe(true);
      await expect.poll(() => save.isEnabled()).toBe(false);
      expect(await renamedRow.isVisible()).toBe(true);

      await gateway.resolveDeferred("connect");
      await waitForPhase(page, "connected");
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketsBefore);
      await renamedRow.waitFor();
      expect(await input.inputValue()).toBe("Unsaved alias");
      await expect.poll(() => save.isEnabled()).toBe(true);
      expect(await gateway.getRequests("device.pair.rename")).toHaveLength(renamesBefore + 2);

      // A persisted pageshow replaces the client, retiring identity-scoped dialogs.
      const connectsBeforeReplacement = (await gateway.getRequests("connect")).length;
      await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
      await gateway.waitForRequest("connect", { after: connectsBeforeReplacement });
      await dialog.waitFor({ state: "hidden" });
      await waitForPhase(page, "connected");
      await waitForControlUiRoute(page, { pathname: "/settings/devices", routeId: "devices" });
      await openAlias(renamedRow);
      expect(await input.inputValue()).toBe("Office node");
      expect(await gateway.getRequests("device.pair.rename")).toHaveLength(renamesBefore + 2);
    });
  });
});
