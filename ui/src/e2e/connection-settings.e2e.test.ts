import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI connection settings mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

function settingsSection(page: Page, title: string): Locator {
  return page.locator("openclaw-connection-page .settings-section").filter({
    has: page.locator(".settings-section__heading").getByText(title, { exact: true }),
  });
}

async function captureProof(page: Page, name: string) {
  if (captureUiProofEnabled) {
    await page.screenshot({
      animations: "disabled",
      path: path.join(suite.artifactDir, name),
    });
  }
}

suite.define(() => {
  it("saves the default session without reconnecting or applying a connection draft", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, { authMode: "trusted-proxy" });
      await page.goto(`${suite.server.baseUrl}settings/connection`);
      const connection = settingsSection(page, "Connection");
      const session = settingsSection(page, "Session");
      await connection.getByText("Connected", { exact: true }).waitFor();
      const socketCount = await gateway.getSocketCount();
      const url = connection.getByLabel("Gateway URL", { exact: true });
      const originalUrl = await url.inputValue();
      expect(await connection.getByRole("button", { name: "Connect", exact: true }).count()).toBe(
        0,
      );
      expect(
        await connection.getByRole("button", { name: "Apply and reconnect", exact: true }).count(),
      ).toBe(0);
      expect(await connection.locator(".settings-section__desc").textContent()).not.toContain(
        "30s",
      );
      await captureProof(page, "01-connected-unchanged.png");

      await url.fill("wss://other-gateway.example.test");
      await connection.getByRole("button", { name: "Apply and reconnect", exact: true }).waitFor();
      await connection.getByLabel("Gateway secret", { exact: true }).waitFor();
      const defaultSession = session.getByLabel("Default session", { exact: true });
      const savedSession = "agent:main:saved-default";
      await defaultSession.fill(savedSession);
      await session.getByRole("button", { name: "Save", exact: true }).click();
      await session.getByText("Saved", { exact: true }).waitFor();
      expect(await gateway.getSocketCount()).toBe(socketCount);
      expect(await url.inputValue()).toBe("wss://other-gateway.example.test");
      expect(
        await connection
          .getByRole("button", { name: "Apply and reconnect", exact: true })
          .isVisible(),
      ).toBe(true);
      await captureProof(page, "02-session-saved-connection-pending.png");

      await connection.getByRole("button", { name: "Discard changes", exact: true }).click();
      await expect.poll(() => url.inputValue()).toBe(originalUrl);
      expect(await defaultSession.inputValue()).toBe(savedSession);
      await defaultSession.fill(" ");
      await expect
        .poll(() => session.getByRole("button", { name: "Save", exact: true }).isDisabled())
        .toBe(true);
      await session.getByRole("button", { name: "Discard changes", exact: true }).click();
      await expect.poll(() => defaultSession.inputValue()).toBe(savedSession);
      expect(await gateway.getSocketCount()).toBe(socketCount);

      await page.reload();
      await connection.getByText("Connected", { exact: true }).waitFor();
      await expect.poll(() => defaultSession.inputValue()).toBe(savedSession);
      expect(await url.inputValue()).toBe(originalUrl);
      expect(await session.getByRole("button", { name: "Save", exact: true }).count()).toBe(0);
      await page.setViewportSize({ width: 390, height: 844 });
      await captureProof(page, "03-saved-session-mobile.png");
    });
  });

  it("reconnects only on an explicit apply or troubleshooting action and shows pending states", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, { authMode: "token" });
      await page.goto(`${suite.server.baseUrl}settings/connection`);
      const connection = settingsSection(page, "Connection");
      await connection.getByText("Connected", { exact: true }).waitFor();
      const socketCount = await gateway.getSocketCount();
      const secret = connection.getByLabel("Gateway secret", { exact: true });
      const originalSecret = await secret.inputValue();
      const apply = connection.getByRole("button", { name: "Apply and reconnect", exact: true });
      const details = connection.locator("details").filter({
        has: page.locator("summary").getByText("Connection details", { exact: true }),
      });
      await details.locator("summary").click();
      const reconnect = details.getByRole("button", { name: "Reconnect", exact: true });
      await expect.poll(() => reconnect.isEnabled()).toBe(true);
      expect(await details.textContent()).toContain("30s");
      await captureProof(page, "04-connection-details.png");

      await secret.fill("synthetic-draft-secret");
      await apply.waitFor();
      expect(await reconnect.isDisabled()).toBe(true);
      await secret.fill(originalSecret);
      await expect.poll(() => apply.count()).toBe(0);
      expect(await gateway.getSocketCount()).toBe(socketCount);

      await secret.fill("synthetic-applied-secret");
      const connectsBeforeApply = (await gateway.getRequests("connect")).length;
      await gateway.deferNext("connect");
      await apply.click();
      const handshake = await gateway.waitForRequest("connect", { after: connectsBeforeApply });
      expect(handshake.params).toMatchObject({ auth: { token: "synthetic-applied-secret" } });
      const reconnecting = connection.getByRole("button", { name: "Reconnecting…", exact: true });
      await reconnecting.waitFor();
      expect(await reconnecting.isDisabled()).toBe(true);
      expect(await gateway.getSocketCount()).toBe(socketCount + 1);
      await captureProof(page, "05-applying-connection.png");
      await gateway.resolveDeferred("connect");
      await connection.getByText("Connected", { exact: true }).waitFor();
      expect(await apply.count()).toBe(0);

      if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) {
        await details.locator("summary").click();
      }
      const connectsBeforeReconnect = (await gateway.getRequests("connect")).length;
      await gateway.deferNext("connect");
      await reconnect.click();
      await gateway.waitForRequest("connect", { after: connectsBeforeReconnect });
      await reconnecting.waitFor();
      expect(await reconnect.isDisabled()).toBe(true);
      expect(await gateway.getSocketCount()).toBe(socketCount + 2);
      await gateway.resolveDeferred("connect");
      await connection.getByText("Connected", { exact: true }).waitFor();

      await gateway.setOnline(false);
      await reconnecting.waitFor();
      expect(await reconnecting.isDisabled()).toBe(true);
      expect(await reconnect.isDisabled()).toBe(true);
      await captureProof(page, "06-automatic-reconnect.png");
      await gateway.setOnline(true);
      await connection.getByText("Connected", { exact: true }).waitFor();
      expect(await apply.count()).toBe(0);
      await captureProof(page, "07-reconnected.png");
    });
  });
  it("switches Gateway targets while the original connection is still retrying", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, { authMode: "token" });
      await page.goto(`${suite.server.baseUrl}settings/connection`);
      const connection = settingsSection(page, "Connection");
      await connection.getByText("Connected", { exact: true }).waitFor();
      const connectsBeforeRetry = (await gateway.getRequests("connect")).length;
      await gateway.deferNext("connect");
      await gateway.closeLatest(1006, "Original Gateway unavailable");
      await gateway.waitForRequest("connect", { after: connectsBeforeRetry });
      expect(
        await connection.getByRole("button", { name: "Reconnecting…", exact: true }).isDisabled(),
      ).toBe(true);

      // Leave the original handshake unanswered while connecting to the replacement target.
      const socketCount = await gateway.getSocketCount();
      const replacementUrl = "ws://127.0.0.1:19998";
      await connection.getByLabel("Gateway URL", { exact: true }).fill(replacementUrl);
      await connection.getByRole("button", { name: "Apply and reconnect", exact: true }).click();
      await connection.getByText("Connected", { exact: true }).waitFor();
      expect(await gateway.getSocketCount()).toBe(socketCount + 1);
      expect((await gateway.getSocketUrls()).at(-1)).toBe(replacementUrl);
      await gateway.resolveDeferred("connect");
      expect(await connection.getByLabel("Gateway URL", { exact: true }).inputValue()).toBe(
        replacementUrl,
      );
      expect(
        await connection.getByRole("button", { name: "Apply and reconnect", exact: true }).count(),
      ).toBe(0);
    });
  });
});
