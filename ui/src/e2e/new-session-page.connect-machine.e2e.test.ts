import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  captureUiProofEnabled,
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

async function captureProof(
  page: Page,
  fileName: string,
  presentation?: { surface: Locator; content: readonly Locator[] },
) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(path.join(suite.artifactDir, "connect-machine"), { recursive: true });
  if (page.video()) {
    await writeFile(
      path.join(suite.artifactDir, "connect-machine", fileName),
      await takeControlUiViewportScreenshot(
        page,
        presentation?.surface ?? page.locator(".shell"),
        presentation?.content ?? [page.locator(".new-session-page__message")],
      ),
    );
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(path.join(suite.artifactDir, "connect-machine"), fileName),
  });
}

suite.define(() => {
  it("lets admins mint and refresh a one-paste machine connection", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProofEnabled
        ? {
            recordVideo: {
              dir: path.join(suite.artifactDir, "connect-machine"),
              size: { height: 900, width: 1280 },
            },
          }
        : {}),
    });
    const page = await context.newPage();
    const firstJoinUrl = "https://gateway.example.com/j/first-code?label=alpha&next=$(whoami)";
    const secondJoinUrl = "https://gateway.example.com/j/second-code";
    const firstCommand = `npx -y openclaw@2026.9.30 connect '${firstJoinUrl}' --service --session-host`;
    const firstServiceCommand = `npx -y openclaw@2026.9.30 connect '${firstJoinUrl}' --service`;
    const firstInstalledCommand = `openclaw connect '${firstJoinUrl}' --service --session-host`;
    const secondCommand = `npx -y openclaw connect ${secondJoinUrl} --service --session-host`;
    const secondInstalledCommand = `openclaw connect ${secondJoinUrl} --service --session-host`;
    const versionNote =
      "The machine needs a matching Gateway build; the exact npm release could not be confirmed.";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "device.pair.setupCode": {
          sequence: [
            {
              setupCode: "FIRST",
              joinUrl: firstJoinUrl,
              command: firstCommand,
              serviceCommand: firstServiceCommand,
              installedCommand: firstInstalledCommand,
              gatewayUrl: "wss://gateway.example.com",
              auth: "token",
              urlSource: "test",
              access: "node",
              expiresAtMs: Date.now() + 10 * 60_000,
            },
            {
              setupCode: "SECOND",
              joinUrl: secondJoinUrl,
              command: secondCommand,
              serviceCommand: `npx -y openclaw connect ${secondJoinUrl} --service`,
              installedCommand: secondInstalledCommand,
              versionNote,
              gatewayUrl: "wss://gateway.example.com",
              auth: "token",
              urlSource: "test",
              access: "node",
              expiresAtMs: Date.now() + 10 * 60_000,
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const place = page.locator("wa-popover.new-session-page__where-popover");
      await page.locator("#new-session-where-trigger").click();
      const connect = place.getByRole("button", { name: "Connect a device" });
      await connect.waitFor();
      expect(await place.getByText("Your devices", { exact: true }).isVisible()).toBe(true);
      await captureProof(page, "01-picker-foot.png", {
        surface: place.locator('wa-popup [part="popup"]'),
        content: [connect],
      });
      await connect.click();

      const firstRequest = await gateway.waitForRequest("device.pair.setupCode");
      expect(firstRequest.params).toEqual({ includeQr: false, joinUrl: true });
      const dialog = page.locator('openclaw-modal-dialog[label="Connect a machine"]');
      await dialog.getByText(firstCommand, { exact: true }).waitFor();
      const installed = dialog
        .locator(".connect-machine-dialog__hint")
        .filter({ hasText: "Already have OpenClaw installed? Run:" });
      expect(await installed.locator("code").textContent()).toBe(firstInstalledCommand);
      expect(await dialog.getByText(versionNote, { exact: true }).count()).toBe(0);
      expect(
        await dialog
          .locator(".login-gate__command code")
          .first()
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      expect(
        await installed.evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
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
      await captureProof(page, "02-connect-dialog.png", {
        surface: dialog.locator("dialog"),
        content: [copy, installed],
      });
      await dialog.getByText("Command access only (no agent sessions)", { exact: true }).click();
      await dialog.getByText(firstServiceCommand, { exact: true }).waitFor();
      await captureProof(page, "02-connect-command-only.png", {
        surface: dialog.locator("dialog"),
        content: [dialog.getByText(firstServiceCommand, { exact: true }), installed],
      });
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
        .filter({ hasText: secondCommand })
        .waitFor();
      expect(await dialog.locator(".login-gate__command code").first().textContent()).toBe(
        secondCommand,
      );
      expect(await installed.locator("code").textContent()).toBe(secondInstalledCommand);
      const note = dialog.getByText(versionNote, { exact: true });
      await note.waitFor();
      expect(await dialog.getByText(firstCommand, { exact: true }).count()).toBe(0);
      await captureProof(page, "02-connect-development-build.png", {
        surface: dialog.locator("dialog"),
        content: [copy, installed, note],
      });
    } finally {
      await context.close();
    }
  });

  it("hides machine connection from non-admin operators", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.read", "operator.write"],
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const place = page.locator("wa-popover.new-session-page__where-popover");
      await page.locator("#new-session-where-trigger").click();
      await place.locator('[data-value="gateway"]').waitFor();
      expect(await place.getByRole("button", { name: "Connect a device" }).count()).toBe(0);
      expect(await gateway.getRequests("device.pair.setupCode")).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("shows a retryable error when connection-link creation never responds", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const joinUrl = "https://gateway.example.com/j/retried-code";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "device.pair.setupCode": {
          setupCode: "RETRIED",
          joinUrl,
          command: `npx -y openclaw@2026.9.30 connect ${joinUrl} --service --session-host`,
          serviceCommand: `npx -y openclaw@2026.9.30 connect ${joinUrl} --service`,
          installedCommand: `openclaw connect ${joinUrl} --service --session-host`,
          gatewayUrl: "wss://gateway.example.com",
          auth: "token",
          urlSource: "test",
          access: "node",
          expiresAtMs: Date.now() + 10 * 60_000,
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await page.clock.install();
      await gateway.deferNext("device.pair.setupCode");
      await page.locator("#new-session-where-trigger").click();
      await page.getByRole("button", { name: "Connect a device" }).click();
      await gateway.waitForRequest("device.pair.setupCode");
      const dialog = page.locator('openclaw-modal-dialog[label="Connect a machine"]');
      await dialog.getByText("Creating a secure connection link…", { exact: true }).waitFor();
      await captureProof(page, "03-connect-loading.png");

      await page.clock.fastForward(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS + 1);
      await page.clock.runFor(100);

      await dialog
        .getByRole("alert")
        .filter({ hasText: "gateway request timed out after 30000ms: device.pair.setupCode" })
        .waitFor();
      expect(
        await dialog.getByText("Creating a secure connection link…", { exact: true }).count(),
      ).toBe(0);
      await captureProof(page, "04-connect-timeout.png");
      const retry = dialog.getByRole("button", { name: "Mint fresh code" });
      await retry.click();
      await dialog
        .getByText(`npx -y openclaw@2026.9.30 connect ${joinUrl} --service --session-host`, {
          exact: true,
        })
        .waitFor();
      expect(await gateway.getRequests("device.pair.setupCode")).toHaveLength(2);
    } finally {
      await context.close();
    }
  });

  it("redacts sensitive connection-link failures before rendering them", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["device.pair.setupCode"],
    });
    const secret = "e2e-pairing-bearer-secret";

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator("#new-session-where-trigger").click();
      await page.getByRole("button", { name: "Connect a device" }).click();
      await gateway.waitForRequest("device.pair.setupCode");
      await gateway.rejectDeferred("device.pair.setupCode", {
        message: `pairing failed: Authorization: Bearer ${secret}`,
      });

      const alert = page
        .locator('openclaw-modal-dialog[label="Connect a machine"]')
        .getByRole("alert");
      await alert.waitFor();
      expect(await alert.textContent()).toContain("Authorization: [redacted]");
      expect(await alert.textContent()).not.toContain(secret);
    } finally {
      await context.close();
    }
  });

  it("closes an in-flight connection dialog when the Gateway reconnects", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["device.pair.setupCode"],
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator("#new-session-where-trigger").click();
      await page.getByRole("button", { name: "Connect a device" }).click();
      await gateway.waitForRequest("device.pair.setupCode");
      const dialog = page.locator('openclaw-modal-dialog[label="Connect a machine"]');
      await dialog.getByText("Creating a secure connection link…", { exact: true }).waitFor();

      await gateway.closeLatest(1012, "test reconnect");

      await expect.poll(() => dialog.count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
