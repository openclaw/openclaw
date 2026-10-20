import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  type ControlUiMockGatewayScenario,
  type MockGatewayControls,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent selection persistence",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

const agentsList = {
  agents: Object.entries({ dummy: "Dummy", openclaw: "OpenClaw" }).map(([id, name]) => ({
    id,
    identity: { name },
    kind: "agent",
    name,
  })),
  defaultId: "dummy",
  mainKey: "main",
  scope: "global",
};

const scenario: ControlUiMockGatewayScenario = {
  assistantAgentId: "dummy",
  assistantName: "Dummy",
  defaultAgentId: "dummy",
  sessionKey: "global",
  sessionScope: "global",
  methodResponses: {
    "agent.identity.get": {
      cases: agentsList.agents.map(({ id: agentId, name }) => ({
        match: { agentId },
        response: { agentId, avatar: "", emoji: name[0], name },
      })),
    },
    "agents.list": agentsList,
    "chat.startup": {
      agentsList,
      messages: [],
      metadata: { models: [] },
      sessionId: "control-ui-agent-selection-persistence",
      thinkingLevel: null,
    },
    "sessions.list": {
      count: 1,
      defaults: {},
      path: "",
      sessions: [{ key: "global", kind: "global", updatedAt: 1 }],
      ts: 1,
    },
  },
};

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await page.waitForTimeout(600);
  await writeFile(
    path.join(suite.artifactDir, name),
    await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
      page.locator(".sidebar-agent-card__main"),
    ]),
  );
}

const selectedAgentName = async (page: Page) =>
  (
    (await page.locator("openclaw-app-sidebar .sidebar-agent-card__name").textContent()) ?? ""
  ).trim();

async function expectOpenClaw(page: Page) {
  await expect.poll(() => selectedAgentName(page)).toBe("OpenClaw");
  await expect.poll(() => page.getByRole("heading", { name: "OpenClaw" }).isVisible()).toBe(true);
}

async function hasOpenClawStartup(gateway: MockGatewayControls): Promise<boolean> {
  return (await gateway.getRequests("chat.startup")).some((request) => {
    const params = request.params as
      | { agentId?: unknown; limit?: unknown; sessionKey?: unknown }
      | undefined;
    return (
      params?.agentId === "openclaw" &&
      params.sessionKey === "agent:openclaw:main" &&
      params.limit === 80
    );
  });
}

async function persistCanonicalGlobalSession(page: Page): Promise<void> {
  await page.evaluate(
    ({ gatewayUrl, settingsKey }) => {
      const settings = JSON.parse(localStorage.getItem(settingsKey) ?? "{}") as {
        sessionsByGateway?: Record<string, { lastActiveSessionKey?: string; sessionKey?: string }>;
      };
      const session = settings.sessionsByGateway?.[gatewayUrl];
      if (!session) {
        throw new Error("Bundled Gateway session selection was not persisted");
      }
      session.sessionKey = "global";
      session.lastActiveSessionKey = "global";
      localStorage.setItem(settingsKey, JSON.stringify(settings));
    },
    {
      gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
      settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
    },
  );
}

async function openPage(
  context: BrowserContext,
): Promise<{ gateway: MockGatewayControls; page: Page }> {
  const page = await context.newPage();
  const gateway = await installMockGateway(page, scenario);
  await page.goto(`${suite.server.baseUrl}chat`);
  await page.locator("openclaw-app-sidebar").waitFor();
  return { gateway, page };
}

suite.define(() => {
  it("restores the selected agent when a fresh shell reopens the canonical global session", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
      ...(captureUiProof
        ? { recordVideo: { dir: suite.artifactDir, size: { height: 900, width: 1440 } } }
        : {}),
    });
    try {
      const { gateway: firstGateway, page: firstPage } = await openPage(context);
      const sidebar = firstPage.locator("openclaw-app-sidebar");
      await firstGateway.waitForRequest("chat.startup");
      await expect.poll(() => selectedAgentName(firstPage)).toBe("Dummy");
      await screenshot(firstPage, "01-default-agent.png");

      await sidebar.getByRole("button", { name: /Switch agent/ }).click();
      await sidebar
        .locator(".sidebar-agent-menu")
        .getByRole("menuitem", { name: "OpenClaw" })
        .click();
      await waitForControlUiRoute(firstPage, { pathname: "/chat/openclaw", routeId: "chat" });
      await expectOpenClaw(firstPage);
      await screenshot(firstPage, "02-selected-openclaw.png");

      // The macOS host reopens the Gateway's canonical session key. Unlike the
      // browser-only route alias, `global` cannot encode which agent owns it.
      await persistCanonicalGlobalSession(firstPage);

      await firstPage.close();
      const { gateway: reopenedGateway, page: reopenedPage } = await openPage(context);
      await reopenedGateway.waitForRequest("chat.startup");
      await waitForControlUiRoute(reopenedPage, { pathname: "/chat/openclaw", routeId: "chat" });
      await screenshot(reopenedPage, "03-reopened-agent.png");
      await expect.poll(() => hasOpenClawStartup(reopenedGateway)).toBe(true);
      await expectOpenClaw(reopenedPage);
      await screenshot(reopenedPage, "04-verified-reopened-agent.png");
      await reopenedPage.getByRole("link", { name: "New conversation", exact: true }).click();
      await waitForControlUiRoute(reopenedPage, {
        routeId: "new-session",
        search: "?agent=openclaw",
      });
      await reopenedPage.locator(".new-session-page__message").waitFor();
      expect(await reopenedGateway.getRequests("sessions.create")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
