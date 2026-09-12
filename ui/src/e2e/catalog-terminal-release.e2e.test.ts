import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { TERMINAL_START_FEATURE_METHODS } from "./new-session-page.native-terminal.test-support.ts";
import { WORKSPACE } from "./new-session-page.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "native catalog terminal release",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
async function expandCodingSection(page: Page) {
  const toggle = page.locator('[data-session-section="work"] .sidebar-session-group-toggle');
  await page.waitForFunction(
    () =>
      Boolean(
        document.querySelector('[data-session-section="work"]') ??
        document.querySelector('[data-session-section^="catalog:"]'),
      ),
    undefined,
    { timeout: 30_000 },
  );
  if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click();
  }
}
function codexCatalog(canContinue?: boolean) {
  return {
    catalogs: [
      {
        id: "codex",
        label: "Codex",
        capabilities: { continueSession: true, archive: false, startTerminal: true },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local Codex",
            kind: "gateway",
            connected: true,
            canStartTerminal: true,
            sessions:
              canContinue === undefined
                ? []
                : [
                    {
                      threadId: "codex-terminal-session",
                      name: "Native Codex terminal",
                      status: "stored",
                      source: "codex-cli",
                      archived: false,
                      canContinue,
                      canArchive: false,
                      canOpenTerminal: true,
                    },
                  ],
          },
        ],
      },
    ],
  };
}
suite.define(() => {
  it("refreshes the selected catalog pane after its terminal writer exits", async () => {
    const page = await suite.browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.clock.install();
    const staleCatalog = codexCatalog(false);
    const latestRead = {
      hostId: "gateway:local",
      threadId: "codex-terminal-session",
      items: [{ id: "new", type: "agentMessage", text: "Native answer" }],
      nextCursor: "older",
    };
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.catalog.list",
        "sessions.catalog.read",
        "terminal.open",
      ],
      methodResponses: {
        "sessions.catalog.list": staleCatalog,
        "sessions.catalog.read": {
          sequence: [
            latestRead,
            {
              hostId: "gateway:local",
              threadId: "codex-terminal-session",
              items: [{ id: "old", type: "agentMessage", text: "Older answer" }],
            },
            latestRead,
          ],
        },
        "terminal.list": { sessions: [] },
        "terminal.open": {
          agentId: "main",
          confined: false,
          cwd: "/workspace",
          sessionId: "codex-terminal-release",
          shell: "/bin/zsh",
          title: "codex resume codex-terminal-session",
        },
      },
      terminalEnabled: true,
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await expandCodingSection(page);
      const row = page.locator('[data-catalog-session-key^="catalog:"]').filter({
        hasText: "Native Codex terminal",
      });
      await row.click();
      const pane = page.locator("openclaw-chat-pane").filter({ hasText: "Native answer" });
      await pane.getByText("Native answer", { exact: true }).waitFor();
      await pane.getByText("Older answer", { exact: true }).waitFor();
      const composer = pane.locator(".agent-chat__composer-combobox > textarea");
      await expect.poll(() => composer.isDisabled()).toBe(true);

      await row.click({ button: "right", force: true });
      await page.locator('wa-dropdown-item[value="terminal"]').click({ force: true });
      await gateway.waitForRequest("terminal.open");
      await page.locator(".tabstrip-tab.is-connecting").waitFor();
      await gateway.emitGatewayEvent("terminal.data", {
        sessionId: "codex-terminal-release",
        seq: 1,
        data: "Codex ready\r\n",
      });
      await expect.poll(() => page.locator(".tabstrip-tab.is-live").count()).toBe(1);
      const listedBeforeExit = (await gateway.getRequests("sessions.catalog.list")).length;
      await gateway.setMethodResponse("sessions.catalog.list", {
        sequence: [staleCatalog, staleCatalog, staleCatalog, staleCatalog, codexCatalog(true)],
      });
      await gateway.emitGatewayEvent("terminal.exit", {
        sessionId: "codex-terminal-release",
        reason: "process_exit",
        exitCode: 0,
      });
      await page.clock.fastForward(5_100);
      await expect
        .poll(() => gateway.getRequests("sessions.catalog.list").then((rows) => rows.length))
        .toBeGreaterThan(listedBeforeExit);
      await expect.poll(() => composer.isDisabled()).toBe(true);
      await page.clock.fastForward(28_100);
      await expect.poll(() => composer.isDisabled()).toBe(true);
      await page.clock.fastForward(1_100);
      expect(await page.locator(".tabstrip-tab.is-exited").count()).toBe(1);
      await row.click();
      await expect.poll(() => pane.getAttribute("aria-hidden")).toBe("false");
      await expect.poll(() => composer.isEnabled()).toBe(true);
      expect(await pane.getByText("Native answer", { exact: true }).count()).toBe(1);
      expect(await pane.getByText("Older answer", { exact: true }).count()).toBe(1);
    } finally {
      await page.close();
    }
  });
  it("discovers a New Session terminal after writer exit and opens it continuable", async () => {
    const page = await suite.browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.clock.install();
    const gateway = await installMockGateway(page, {
      cliAgentsEnabled: true,
      featureMethods: [...TERMINAL_START_FEATURE_METHODS, "sessions.catalog.read"],
      methodResponses: {
        "sessions.catalog.list": codexCatalog(),
        "sessions.catalog.read": {
          hostId: "gateway:local",
          threadId: "codex-terminal-session",
          items: [{ type: "agentMessage", text: "Native answer" }],
        },
        "sessions.catalog.startTerminal": {
          agentId: "main",
          confined: false,
          cwd: WORKSPACE,
          sessionId: "codex-new-terminal",
          shell: "codex",
          title: "codex exec",
        },
      },
      terminalEnabled: true,
      workspace: WORKSPACE,
    });
    try {
      await page.goto(`${suite.server.baseUrl}new?agent=main&catalog=codex`);
      const message = page.locator(".new-session-page__message");
      await message.fill("Explain the project architecture");
      await message.press("Enter");
      await page.waitForURL(`${suite.server.baseUrl}terminal/codex-new-terminal`);
      await gateway.waitForRequest("sessions.catalog.startTerminal");
      await page.locator(".tabstrip-tab").waitFor();
      await gateway.emitGatewayEvent("terminal.data", {
        sessionId: "codex-new-terminal",
        seq: 1,
        data: "Native answer\r\n",
      });
      await expect.poll(() => page.locator(".tabstrip-tab.is-live").count()).toBe(1);
      const listedBeforeExit = (await gateway.getRequests("sessions.catalog.list")).length;
      await gateway.setMethodResponse("sessions.catalog.list", {
        sequence: [codexCatalog(), codexCatalog(), codexCatalog(true)],
      });
      await gateway.emitGatewayEvent("terminal.exit", {
        sessionId: "codex-new-terminal",
        reason: "process_exit",
        exitCode: 0,
      });
      await page.clock.fastForward(5_100);
      await expect
        .poll(() => gateway.getRequests("sessions.catalog.list").then((rows) => rows.length))
        .toBeGreaterThan(listedBeforeExit);
      expect(await page.locator('[data-catalog-session-key^="catalog:"]').count()).toBe(0);
      await page.clock.fastForward(28_100);
      expect(await page.locator('[data-catalog-session-key^="catalog:"]').count()).toBe(0);
      await page.clock.fastForward(1_100);
      expect(await page.locator(".tabstrip-tab.is-exited").count()).toBe(1);
      await expandCodingSection(page);
      const row = page.locator('[data-catalog-session-key^="catalog:"]').filter({
        hasText: "Native Codex terminal",
      });
      await row.click();
      const pane = page
        .locator("openclaw-chat-pane.chat-pane-cache__pane--visible")
        .filter({ hasText: "Native answer" });
      await pane.getByText("Native answer", { exact: true }).waitFor();
      await expect
        .poll(() => pane.locator(".agent-chat__composer-combobox > textarea").isEnabled())
        .toBe(true);
    } finally {
      await page.close();
    }
  });
});
