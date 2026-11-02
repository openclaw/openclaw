import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
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
        await entry.locator(".device-entry__menu-trigger").click();
        await entry.locator('[role="menuitem"][data-value="editAlias"]').click();
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
