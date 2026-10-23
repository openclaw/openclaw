import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type { Page } from "playwright";
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
function setupCode(joinUrl: string, version = "", quoted = false, versionNote?: string) {
  const target = quoted ? `'${joinUrl}'` : joinUrl;
  const connect = `npx -y openclaw${version ? `@${version}` : ""} connect ${target} --service`;
  return {
    setupCode: "SYNTHETIC",
    joinUrl,
    command: `${connect} --session-host`,
    serviceCommand: connect,
    installedCommand: `openclaw connect ${target} --service --session-host`,
    ...(versionNote ? { versionNote } : {}),
    gatewayUrl: "wss://gateway.example.com",
    auth: "token",
    urlSource: "test",
    access: "node",
    expiresAtMs: Date.now() + 10 * 60_000,
  };
}

async function openNewSession(
  scenario: ControlUiMockGatewayScenario = {},
  options?: Parameters<typeof openPage>[0],
) {
  const page = await openPage(options);
  const gateway = await installMockGateway(page, scenario);
  await page.goto(`${suite.server.baseUrl}new`);
  return { page, gateway };
}

async function openConnection(page: Page, gateway: Awaited<ReturnType<typeof installMockGateway>>) {
  await page.locator("#new-session-where-trigger").click();
  await page.getByRole("button", { name: "Connect a device" }).click();
  await gateway.waitForRequest("device.pair.setupCode");
  return page.locator('openclaw-modal-dialog[label="Connect a machine"]');
}

suite.define(() => {
  it("lets admins mint and refresh a one-paste machine connection", async () => {
    const firstJoinUrl = "https://gateway.example.com/j/first-code?label=alpha&next=$(whoami)";
    const secondJoinUrl = "https://gateway.example.com/j/second-code";
    const versionNote =
      "The machine needs a matching Gateway build; the exact npm release could not be confirmed.";
    const first = setupCode(firstJoinUrl, "2026.9.30", true);
    const second = setupCode(secondJoinUrl, "", false, versionNote);
    const { page, gateway } = await openNewSession(
      {
        methodResponses: {
          "device.pair.setupCode": { sequence: [first, second] },
        },
      },
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
    );
    const place = page.locator(".oc-popover.new-session-page__where-popover");
    await page.locator("#new-session-where-trigger").click();
    const connect = place.getByRole("button", { name: "Connect a device" });
    await connect.waitFor();
    expect(await place.getByText("Your devices", { exact: true }).isVisible()).toBe(true);

    await connect.click();

    const firstRequest = await gateway.waitForRequest("device.pair.setupCode");
    expect(firstRequest.params).toEqual({ includeQr: false, joinUrl: true });
    const dialog = page.locator('openclaw-modal-dialog[label="Connect a machine"]');
    await dialog.getByText(first.command, { exact: true }).waitFor();
    const installed = dialog
      .locator(".connect-machine-dialog__hint")
      .filter({ hasText: "Already have OpenClaw installed? Run:" });
    expect(await installed.locator("code").textContent()).toBe(first.installedCommand);
    expect(await dialog.getByText(versionNote, { exact: true }).count()).toBe(0);
    expect(
      await dialog
        .locator(".login-gate__command code")
        .first()
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    expect(await installed.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    const copy = dialog.locator("button.chat-copy-btn").first();
    expect(await dialog.locator("button.chat-copy-btn:visible").count()).toBe(1);
    expect(await copy.getAttribute("aria-label")).toBe("Copy command");
    await dialog
      .getByText(
        "Installs a background node service that pairs this machine with your team and can run agent sessions.",
        { exact: true },
      )
      .waitFor();
    await dialog.getByText(/This link is single-use and expires at/u).waitFor();
    expect(await dialog.getByRole("button", { name: "Manage devices" }).count()).toBe(1);

    await dialog.getByText("Command access only (no agent sessions)", { exact: true }).click();
    await dialog.getByText(first.serviceCommand, { exact: true }).waitFor();

    await dialog.getByText("Command access only (no agent sessions)", { exact: true }).click();

    await dialog.getByRole("button", { name: "Mint fresh code" }).click();
    await expect
      .poll(async () => (await gateway.getRequests("device.pair.setupCode")).length)
      .toBe(2);
    expect((await gateway.getRequests("device.pair.setupCode"))[1]?.params).toEqual({
      includeQr: false,
      joinUrl: true,
    });
    await dialog
      .locator(".login-gate__command code")
      .first()
      .filter({ hasText: second.command })
      .waitFor();
    expect(await dialog.locator(".login-gate__command code").first().textContent()).toBe(
      second.command,
    );
    expect(await installed.locator("code").textContent()).toBe(second.installedCommand);
    const note = dialog.getByText(versionNote, { exact: true });
    await note.waitFor();
    expect(await dialog.getByText(first.command, { exact: true }).count()).toBe(0);
  });

  it("hides machine connection from non-admin operators", async () => {
    const { page, gateway } = await openNewSession({
      operatorScopes: ["operator.read", "operator.write"],
    });

    const place = page.locator(".oc-popover.new-session-page__where-popover");
    await page.locator("#new-session-where-trigger").click();
    await place.locator('[data-value="gateway"]').waitFor();
    expect(await place.getByRole("button", { name: "Connect a device" }).count()).toBe(0);
    expect(await gateway.getRequests("device.pair.setupCode")).toEqual([]);
  });

  it("shows a retryable error when connection-link creation never responds", async () => {
    const joinUrl = "https://gateway.example.com/j/retried-code";
    const response = setupCode(joinUrl, "2026.9.30");
    const { page, gateway } = await openNewSession({
      methodResponses: {
        "device.pair.setupCode": response,
      },
    });

    await page.clock.install();
    await gateway.deferNext("device.pair.setupCode");
    const dialog = await openConnection(page, gateway);
    await dialog.getByText("Creating a secure connection link…", { exact: true }).waitFor();

    await page.clock.fastForward(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS + 1);
    await page.clock.runFor(100);

    await dialog
      .getByRole("alert")
      .filter({ hasText: "gateway request timed out after 30000ms: device.pair.setupCode" })
      .waitFor();
    expect(
      await dialog.getByText("Creating a secure connection link…", { exact: true }).count(),
    ).toBe(0);

    const retry = dialog.getByRole("button", { name: "Mint fresh code" });
    await retry.click();
    await dialog.getByText(response.command, { exact: true }).waitFor();
    expect(await gateway.getRequests("device.pair.setupCode")).toHaveLength(2);
  });

  it("redacts sensitive connection-link failures before rendering them", async () => {
    const { page, gateway } = await openNewSession({
      deferredMethods: ["device.pair.setupCode"],
    });
    const secret = "e2e-pairing-bearer-secret";

    const dialog = await openConnection(page, gateway);
    await gateway.rejectDeferred("device.pair.setupCode", {
      message: `pairing failed: Authorization: Bearer ${secret}`,
    });

    const alert = dialog.getByRole("alert");
    await alert.waitFor();
    expect(await alert.textContent()).toContain("Authorization: [redacted]");
    expect(await alert.textContent()).not.toContain(secret);
  });

  it("closes an in-flight connection dialog when the Gateway reconnects", async () => {
    const { page, gateway } = await openNewSession({
      deferredMethods: ["device.pair.setupCode"],
    });

    const dialog = await openConnection(page, gateway);
    await dialog.getByText("Creating a secure connection link…", { exact: true }).waitFor();

    await gateway.closeLatest(1012, "test reconnect");

    await pollCount(dialog).toBe(0);
  });
});
