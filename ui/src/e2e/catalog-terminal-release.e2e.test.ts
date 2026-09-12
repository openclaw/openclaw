import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { resumableClaudeCatalog } from "./claude-sessions.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

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

suite.define(() => {
  it("refreshes the selected catalog pane after its terminal writer exits", async () => {
    const page = await suite.browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.clock.install();
    const staleCatalog = resumableClaudeCatalog();
    const staleSession = staleCatalog.catalogs.at(0)?.hosts.at(0)?.sessions.at(0);
    if (!staleSession) {
      throw new Error("expected the Claude catalog fixture to include one native session");
    }
    staleSession.canContinue = false;
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
          hostId: "gateway:local",
          threadId: "claude-terminal-session",
          items: [{ type: "agentMessage", text: "Native answer" }],
        },
        "terminal.list": { sessions: [] },
        "terminal.open": {
          agentId: "main",
          confined: false,
          cwd: "/workspace",
          sessionId: "claude-terminal-release",
          shell: "/bin/zsh",
          title: "claude --resume claude-terminal-session",
        },
      },
      terminalEnabled: true,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await expandCodingSection(page);
      const row = page.locator('[data-catalog-session-key^="catalog:"]').filter({
        hasText: "Native Claude terminal",
      });
      await row.click();
      const activePane = page
        .locator("openclaw-chat-pane.chat-pane-cache__pane--visible")
        .filter({ hasText: "Native answer" });
      await activePane.getByText("Native answer", { exact: true }).waitFor();
      await activePane.evaluate((element) => element.setAttribute("data-release-test", ""));
      const pane = page.locator("openclaw-chat-pane[data-release-test]");
      const composer = pane.locator(".agent-chat__composer-combobox > textarea");
      await expect.poll(() => composer.isDisabled()).toBe(true);

      await row.click({ button: "right", force: true });
      await page.locator('wa-dropdown-item[value="terminal"]').click({ force: true });
      await gateway.waitForRequest("terminal.open");
      await page.locator(".tabstrip-tab.is-connecting").waitFor();
      await gateway.emitGatewayEvent("terminal.data", {
        sessionId: "claude-terminal-release",
        seq: 1,
        data: "Claude Code ready\r\n",
      });
      await expect.poll(() => page.locator(".tabstrip-tab.is-live").count()).toBe(1);
      const listedBeforeExit = (await gateway.getRequests("sessions.catalog.list")).length;
      await gateway.setMethodResponse("sessions.catalog.list", resumableClaudeCatalog());
      await gateway.emitGatewayEvent("terminal.exit", {
        sessionId: "claude-terminal-release",
        reason: "process_exit",
        exitCode: 0,
      });
      await page.clock.fastForward(5_000);
      await page.clock.runFor(100);

      await expect
        .poll(() => gateway.getRequests("sessions.catalog.list").then((rows) => rows.length))
        .toBeGreaterThan(listedBeforeExit);
      await page.clock.runFor(100);
      expect(await page.locator(".tabstrip-tab.is-exited").count()).toBe(1);
      await row.click();
      await expect.poll(() => pane.getAttribute("aria-hidden")).toBe("false");
      await expect.poll(() => composer.isEnabled()).toBe(true);
      expect(await pane.getByText("Native answer", { exact: true }).count()).toBe(1);
    } finally {
      await page.close();
    }
  });
});
