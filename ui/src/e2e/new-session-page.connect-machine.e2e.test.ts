import { expect, it } from "vitest";
import type { ControlUiMockGatewayScenario } from "../test-helpers/control-ui-e2e.ts";
import { createPageOpener } from "./new-session-page.scenario.test-support.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollCount,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const openPage = createPageOpener(suite);
function setupCode(id: string, versionNote?: string) {
  const joinUrl = `https://gateway.example.com/j/${id}`;
  const command = `openclaw connect '${joinUrl}' --service`;
  return {
    setupCode: "SYNTHETIC",
    joinUrl,
    command: `npx -y ${command} --session-host`,
    serviceCommand: `npx -y ${command}`,
    installedCommand: `${command} --session-host`,
    versionNote,
    expiresAtMs: Date.now() + 600_000,
  };
}
async function openConnection(scenario: ControlUiMockGatewayScenario) {
  const page = await openPage({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  });
  const gateway = await installMockGateway(page, scenario);
  await page.goto(`${suite.server.baseUrl}new`);
  await page.locator("#new-session-where-trigger").click();
  await page.getByRole("button", { name: "Connect a device" }).click();
  const request = await gateway.waitForRequest("device.pair.setupCode");
  expect(request.params).toEqual({ includeQr: false, joinUrl: true });
  const dialog = page.locator('openclaw-modal-dialog[label="Connect a machine"]');
  return { page, gateway, dialog };
}

suite.define(() => {
  it("shows bounded commands, command-only access, and the refreshed build warning", async () => {
    const first = setupCode("first-code?label=alpha&next=$(whoami)");
    const second = setupCode("second-code", "The exact npm release could not be confirmed.");
    const { dialog, gateway } = await openConnection({
      methodResponses: { "device.pair.setupCode": { sequence: [first, second] } },
    });
    const command = dialog.locator(".login-gate__command code").first();
    const installed = dialog.locator(".connect-machine-dialog__hint code");
    await expect.poll(() => command.textContent()).toBe(first.command);
    expect(await installed.textContent()).toBe(first.installedCommand);
    for (const text of [command, installed.locator("..")]) {
      expect(await text.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    }
    expect(await dialog.getByText(second.versionNote!, { exact: true }).count()).toBe(0);
    const commandOnly = dialog.getByText("Command access only (no agent sessions)", {
      exact: true,
    });
    await commandOnly.click();
    await dialog.getByText(first.serviceCommand, { exact: true }).waitFor();
    await commandOnly.click();
    await dialog.getByRole("button", { name: "Mint fresh code" }).click();
    await expect.poll(() => command.textContent()).toBe(second.command);
    expect(
      (await gateway.getRequests("device.pair.setupCode")).map(({ params }) => params),
    ).toEqual([
      { includeQr: false, joinUrl: true },
      { includeQr: false, joinUrl: true },
    ]);
    expect(await installed.textContent()).toBe(second.installedCommand);
    await dialog.getByText(second.versionNote!, { exact: true }).waitFor();
    expect(await dialog.getByText(first.command, { exact: true }).count()).toBe(0);
  });

  it("redacts sensitive connection-link failures before rendering them", async () => {
    const { gateway, dialog } = await openConnection({
      deferredMethods: ["device.pair.setupCode"],
    });
    const secret = "e2e-pairing-bearer-secret";
    await gateway.rejectDeferred("device.pair.setupCode", {
      message: `pairing failed: Authorization: Bearer ${secret}`,
    });
    const alert = dialog.getByRole("alert");
    await alert.waitFor();
    expect(await alert.textContent()).toContain("Authorization: [redacted]");
    expect(await alert.textContent()).not.toContain(secret);
  });

  it("closes an in-flight connection dialog when the Gateway reconnects", async () => {
    const { gateway, dialog } = await openConnection({
      deferredMethods: ["device.pair.setupCode"],
    });
    await dialog.getByText("Creating a secure connection link…", { exact: true }).waitFor();
    await gateway.closeLatest(1012, "test reconnect");
    await pollCount(dialog).toBe(0);
  });
});
