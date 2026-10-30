import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { pageRunner } from "./config-composer-fixtures.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI connection settings mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const withPage = pageRunner(suite, createControlUiE2eContextOptions);
const button = (section: Locator, name: string) =>
  section.getByRole("button", { name, exact: true });
const field = (section: Locator, name: string) => section.getByLabel(name, { exact: true });
const connected = (section: Locator) => section.getByText("Connected", { exact: true }).waitFor();

async function openConnection(page: Page, authMode: "token" | "trusted-proxy") {
  const gateway = await installMockGateway(page, { authMode });
  await page.goto(`${suite.server.baseUrl}settings/connection`);
  const connection = settingsSection(page, "Connection");
  await connected(connection);
  return { gateway, connection };
}

function settingsSection(page: Page, title: string): Locator {
  return page.locator("openclaw-connection-page .settings-section").filter({
    has: page.locator(".settings-section__heading").getByText(title, { exact: true }),
  });
}

suite.define(() => {
  it("persists the default session without applying a connection draft", async () => {
    await withPage(async ({ page }) => {
      const { gateway, connection } = await openConnection(page, "trusted-proxy");
      const session = settingsSection(page, "Session");
      const socketCount = await gateway.getSocketCount();
      const url = field(connection, "Gateway URL");
      const originalUrl = await url.inputValue();
      const apply = button(connection, "Apply and reconnect");

      await url.fill("wss://other-gateway.example.test");
      await apply.waitFor();
      await field(connection, "Gateway secret").waitFor();
      const defaultSession = field(session, "Default session");
      const savedSession = "agent:main:saved-default";
      await defaultSession.fill(savedSession);
      await button(session, "Save").click();
      await session.getByText("Saved", { exact: true }).waitFor();
      expect(await gateway.getSocketCount()).toBe(socketCount);
      expect(await url.inputValue()).toBe("wss://other-gateway.example.test");
      expect(await apply.isVisible()).toBe(true);

      await page.reload();
      await connected(connection);
      await expect.poll(() => defaultSession.inputValue()).toBe(savedSession);
      expect(await url.inputValue()).toBe(originalUrl);
      expect(await button(session, "Save").count()).toBe(0);
    });
  });

  it("switches Gateway targets while the original connection is still retrying", async () => {
    await withPage(async ({ page }) => {
      const { gateway, connection } = await openConnection(page, "token");
      const connectsBeforeRetry = (await gateway.getRequests("connect")).length;
      await gateway.deferNext("connect");
      await gateway.closeLatest(1006, "Original Gateway unavailable");
      await gateway.waitForRequest("connect", { after: connectsBeforeRetry });
      expect(await button(connection, "Reconnecting…").isDisabled()).toBe(true);

      // Leave the original handshake unanswered while connecting to the replacement target.
      const socketCount = await gateway.getSocketCount();
      const replacementUrl = "ws://127.0.0.1:19998";
      await field(connection, "Gateway URL").fill(replacementUrl);
      const apply = button(connection, "Apply and reconnect");
      await apply.click();
      await connected(connection);
      expect(await gateway.getSocketCount()).toBe(socketCount + 1);
      expect((await gateway.getSocketUrls()).at(-1)).toBe(replacementUrl);
      await gateway.resolveDeferred("connect");
      expect(await field(connection, "Gateway URL").inputValue()).toBe(replacementUrl);
      expect(await apply.count()).toBe(0);
    });
  });
});
