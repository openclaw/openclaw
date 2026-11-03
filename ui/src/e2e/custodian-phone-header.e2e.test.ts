// Control UI tests cover the Custodian page's phone header against a mocked Gateway.
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/server-capabilities.js";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Custodian phone header mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
const phone = {
  ...createControlUiE2eContextOptions(),
  viewport: { width: 390, height: 844 },
};
const wizard = {
  sessionId: "e2e-phone-header",
  reply: "Paste the provider credential to continue.",
  action: "none",
  sensitive: true,
  wizardInputPending: true,
  step: { id: "credential", type: "text", message: "Credential", sensitive: true },
};

function install(page: Page, scenario: ControlUiMockGatewayScenario = {}) {
  return installMockGateway(page, {
    ...scenario,
    featureCapabilities: [GATEWAY_SERVER_CAPS.SYSTEM_AGENT_WIZARD_CANCEL],
    featureMethods: [
      "chat.metadata",
      "chat.startup",
      "openclaw.chat",
      "openclaw.chat.history",
      "openclaw.changes.list",
    ],
    methodResponses: {
      "openclaw.chat.history": { turns: [] },
      "openclaw.changes.list": {
        entries: [
          {
            id: "config-audit:phone",
            at: 1_700_000_000_000,
            kind: "config-write",
            source: "config-rpc",
            summary: "Updated the default model",
          },
        ],
      },
      "openclaw.chat": wizard,
      ...scenario.methodResponses,
    },
  });
}

async function expectInViewport(page: Page, locator: Locator) {
  await locator.waitFor();
  const box = await locator.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
}

suite.define(() => {
  it("moves History to the top bar and keeps the wizard's cancel on screen", async () => {
    await suite.withPage(phone, async ({ page }) => {
      await install(page);
      await page.goto(`${suite.server.baseUrl}custodian`);

      const history = page.locator(".topbar").getByRole("button", { name: "History", exact: true });
      await expectInViewport(page, history);
      expect(await page.locator(".custodian__header .btn").count()).toBe(0);
      await page
        .getByRole("heading", { name: "OpenClaw", level: 1 })
        .waitFor({ state: "attached" });

      await history.click();
      await page
        .getByRole("region", { name: "Recent changes" })
        .getByText("Updated the default model")
        .waitFor();
      expect(await history.getAttribute("aria-expanded")).toBe("true");
      await history.click();
      await page.getByRole("region", { name: "Recent changes" }).waitFor({ state: "detached" });

      const cancel = page.locator(".custodian__wizard-cancel");
      await expectInViewport(page, cancel);
      await cancel.click();
      await page.locator(".custodian__wizard-cancel").waitFor();

      await page.setViewportSize({ width: 620, height: 844 });
      await page.locator(".custodian__header .custodian__history-toggle").waitFor();
      expect(await page.locator(".topbar .custodian__history-toggle").count()).toBe(0);
      await page.setViewportSize({ width: 390, height: 844 });
      await expectInViewport(page, history);

      await page.setViewportSize({ width: 1280, height: 800 });
      await page.locator(".custodian__header .custodian__history-toggle").waitFor();
      expect(await page.locator(".topbar .custodian__history-toggle").count()).toBe(0);
    });
  });

  it("keeps setup mode's exit and History in the page", async () => {
    await suite.withPage(phone, async ({ page }) => {
      await install(page);
      await page.goto(`${suite.server.baseUrl}custodian?onboarding=1`);

      await page.locator(".custodian__header--minimal").waitFor();
      await expectInViewport(page, page.locator(".custodian__header .custodian__history-toggle"));
      expect(await page.locator(".topbar .custodian__history-toggle").count()).toBe(0);
      await expectInViewport(page, page.locator(".custodian__wizard-cancel"));

      const exit = page.getByRole("button", { name: "Exit setup", exact: true });
      await expectInViewport(page, exit);
      await exit.click();
      await page.waitForURL((url) => !url.pathname.endsWith("/custodian"));
    });
  });
});
