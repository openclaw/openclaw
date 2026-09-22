import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  TERMINAL_START_FEATURE_METHODS,
  cliAgentCatalog,
} from "./new-session-page.native-terminal.test-support.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  navigateInApp,
  pollLocatorText,
  WORKSPACE,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("replaces a native draft with the main terminal and keeps the dock independent", async () => {
    const context = await suite.browser.newContext({
      ...createControlUiE2eContextOptions(),
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      cliAgentsEnabled: true,
      terminalEnabled: true,
      workspace: WORKSPACE,
      operatorScopes: ["operator.read", "operator.write", "operator.admin"],
      featureMethods: [...TERMINAL_START_FEATURE_METHODS],
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [{ ...cliAgentCatalog(true), id: "codex", label: "Codex" }],
        },
        "sessions.catalog.startTerminal": {
          sessionId: "native-cli",
          agentId: "main",
          shell: "codex",
          cwd: WORKSPACE,
          confined: false,
        },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new?agent=main&catalog=codex`);
      const historyLength = await page.evaluate(() => history.length);
      await page.locator(".new-session-page__message").fill("Explain the project architecture");
      await page.locator(".new-session-page__message").press("Enter");
      await page.waitForURL(`${suite.server.baseUrl}terminal/native-cli`);
      const terminalPage = page.locator("openclaw-terminal-page");
      await terminalPage.locator(".tp-host canvas").waitFor();
      await terminalPage.locator(".tabstrip-tab.is-live").waitFor();
      expect(await page.locator(".new-session-page__message").count()).toBe(0);
      expect(await page.locator("openclaw-app-sidebar").isVisible()).toBe(true);
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
      const dock = page.locator("openclaw-terminal-panel").filter({
        has: page.locator(".tp-host"),
      });
      expect(await page.locator("openclaw-terminal-panel .tp-header:visible").count()).toBe(1);
      expect((await gateway.waitForRequest("sessions.catalog.startTerminal")).params).toMatchObject(
        {
          catalogId: "codex",
          initialMessage: "Explain the project architecture",
        },
      );
      expect(await gateway.getRequests("terminal.attach")).toHaveLength(0);
      expect(await gateway.getRequests("terminal.open")).toHaveLength(0);
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const artifactDir = createControlUiE2eArtifactDir(
          "catalog-terminal-after",
          path.resolve(".artifacts"),
        );
        await page.screenshot({
          path: path.join(artifactDir, "after.png"),
          animations: "disabled",
        });
      }

      await navigateInApp(page, "chat");
      await page.locator(".agent-chat__composer-combobox textarea").waitFor();
      expect(await terminalPage.count()).toBe(0);
      expect(await gateway.getRequests("terminal.close")).toHaveLength(0);
      await page.keyboard.press("Control+Backquote");
      await dock.locator(".tp-host canvas").waitFor();
      expect(await gateway.getRequests("terminal.open")).toHaveLength(1);
      const terminalTab = page.locator('[data-region-header="side"] .tabstrip-tab.is-live');
      await terminalTab.waitFor();
      expect(await terminalTab.count()).toBe(1);
      expect(await terminalTab.locator(".tabstrip-tab__label").textContent()).toBe("zsh");
      expect(await gateway.getRequests("terminal.attach")).toHaveLength(0);
      await page.keyboard.press("Control+Backquote");
      await terminalTab.waitFor({ state: "hidden" });

      await page.goBack();
      await page.waitForURL(`${suite.server.baseUrl}terminal/native-cli`);
      await terminalPage.locator(".tp-host canvas").waitFor();
      await terminalPage.locator(".tabstrip-tab.is-live").waitFor();
      expect(await terminalPage.locator(".tabstrip-tab").count()).toBe(1);
      await expect.poll(async () => (await gateway.getRequests("terminal.attach")).length).toBe(1);
      expect((await gateway.waitForRequest("terminal.attach")).params).toMatchObject({
        sessionId: "native-cli",
      });
      expect(await gateway.getRequests("terminal.close")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it.each(["row", "menu"])("opens a Codex catalog %s in the main terminal route", async (entry) => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    await page.addInitScript((storageKey) => {
      localStorage.setItem(storageKey, JSON.stringify({ catalogOpenTarget: "terminal" }));
    }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
    const catalog = cliAgentCatalog(true);
    const gateway = await installMockGateway(page, {
      cliAgentsEnabled: true,
      terminalEnabled: true,
      featureMethods: [...TERMINAL_START_FEATURE_METHODS],
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [
            {
              ...catalog,
              id: "codex",
              label: "Codex",
              hosts: [
                {
                  ...catalog.hosts[0],
                  sessions: [
                    {
                      threadId: "resume-thread",
                      name: "Resume the architecture review",
                      status: "stored",
                      archived: false,
                      canContinue: true,
                      canOpenTerminal: true,
                      canArchive: false,
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator(
        '[data-catalog-session-key="catalog:codex:gateway%3Alocal:resume-thread"]',
      );
      await row.waitFor();
      if (entry === "row") {
        await row.getByRole("link").click();
      } else {
        await row.click({ button: "right" });
        await page.locator('wa-dropdown-item[value="terminal"]').click();
      }
      await page.waitForURL(
        `${suite.server.baseUrl}terminal?catalog=codex&host=gateway%3Alocal&thread=resume-thread`,
      );
      await page.locator("openclaw-terminal-page .tp-host canvas").waitFor();
      await expect.poll(() => row.getByRole("link").getAttribute("aria-current")).toBe("page");
      expect(await page.locator("openclaw-terminal-panel .tp-header:visible").count()).toBe(1);
      expect((await gateway.waitForRequest("terminal.open")).params).toMatchObject({
        catalog: { catalogId: "codex", hostId: "gateway:local", threadId: "resume-thread" },
      });
    } finally {
      await context.close();
    }
  });

  it.each([
    { id: "codex", label: "Codex" },
    { id: "claude", label: "Claude Code" },
  ])(
    "updates $label native destinations automatically without losing the selected machine",
    async ({ id, label }) => {
      const context = await suite.browser.newContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const local = {
        hostId: "gateway:local",
        label: `Local ${label}`,
        kind: "gateway",
        connected: true,
        canStartTerminal: true,
        sessions: [],
      };
      const node = { ...local, hostId: "node:builder", label: "Build machine", kind: "node" };
      const result = (hosts: (typeof local)[]) => ({
        catalogs: [{ ...cliAgentCatalog(true), id, label, hosts }],
      });
      const gateway = await installMockGateway(page, {
        cliAgentsEnabled: true,
        featureMethods: [...TERMINAL_START_FEATURE_METHODS],
        methodResponses: { "sessions.catalog.list": result([local]) },
      });
      try {
        await page.goto(`${suite.server.baseUrl}new?agent=main&catalog=${id}`);
        await pollLocatorText(page.locator(".new-session-page__runtime")).toContain(label);
        const destination = page.getByRole("combobox", { name: "Where", exact: true });
        expect(await destination.count()).toBe(0);
        expect(await page.getByRole("button", { name: "Refresh", exact: true }).count()).toBe(0);
        const message = page.locator(".new-session-page__message");
        await message.fill("Keep this draft on the selected machine");

        await gateway.setMethodResponse("sessions.catalog.list", result([local, node]));
        await gateway.emitGatewayEvent("node.runnerInventory.changed", { nodeId: "builder" });
        await destination.waitFor();
        await destination.selectOption(node.hostId);
        const folder = page.getByRole("textbox", { name: "Existing absolute folder on this node" });
        await folder.fill("/workspace/native-project");
        expect(await page.getByRole("button", { name: "Refresh", exact: true }).count()).toBe(0);

        await gateway.setMethodResponse("sessions.catalog.list", result([local]));
        await gateway.emitGatewayEvent("presence", {
          presence: [{ deviceId: "builder", reason: "disconnect" }],
        });
        await expect.poll(() => destination.locator("option").count()).toBe(2);
        await expect.poll(() => destination.inputValue()).toBe(node.hostId);
        await expect.poll(() => folder.inputValue()).toBe("/workspace/native-project");
        await expect
          .poll(() =>
            page.getByRole("button", { name: "Start in terminal" }).getAttribute("aria-disabled"),
          )
          .toBe("true");

        await gateway.setOnline(false);
        await waitForControlUiGatewayReconnecting(page);
        await gateway.setMethodResponse("sessions.catalog.list", result([local, node]));
        await gateway.setOnline(true);
        await waitForControlUiGatewayReady(page);
        await expect
          .poll(() => destination.locator(`option[value="${node.hostId}"]`).isDisabled())
          .toBe(false);
        await expect.poll(() => destination.inputValue()).toBe(node.hostId);
        expect(await message.inputValue()).toBe("Keep this draft on the selected machine");
        expect(await folder.inputValue()).toBe("/workspace/native-project");
        expect(await gateway.getRequests("sessions.catalog.startTerminal")).toHaveLength(0);

        await gateway.setMethodResponse("sessions.catalog.list", result([]));
        await gateway.emitGatewayEvent("config.changed", {});
        await page.getByRole("status").filter({ hasText: "No native CLI is available" }).waitFor();
        expect(await destination.count()).toBe(0);
      } finally {
        await context.close();
      }
    },
  );

  it("selects the only native node without borrowing the Gateway workspace", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const catalog = cliAgentCatalog(true);
    catalog.hosts = [
      {
        ...catalog.hosts[0]!,
        hostId: "node:builder",
        label: "Build machine",
        kind: "node",
      },
    ];
    await installMockGateway(page, {
      cliAgentsEnabled: true,
      featureMethods: [...TERMINAL_START_FEATURE_METHODS],
      methodResponses: { "sessions.catalog.list": { catalogs: [catalog] } },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new?agent=main&catalog=claude`);
      const folder = page.getByRole("textbox", { name: "Existing absolute folder on this node" });
      await folder.waitFor();
      expect(await folder.inputValue()).toBe("");
      expect(await page.getByRole("combobox", { name: "Where", exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Refresh", exact: true }).count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
