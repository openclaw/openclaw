import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  cliAgentCatalog,
  TERMINAL_START_FEATURE_METHODS,
} from "./new-session-page.native-terminal.test-support.ts";
import { WORKSPACE } from "./new-session-page.test-support.ts";

const CATALOG_ROW = '[data-catalog-session-key^="catalog:"]';
const suite = createControlUiE2eSuite({
  name: "native catalog terminal release",
});
async function expandCodingSection(page: Page) {
  const toggle = page.locator('[data-session-section="work"] .sidebar-session-group-toggle');
  await toggle.or(page.locator('[data-session-section^="catalog:"]')).first().waitFor();
  if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click();
  }
}
function codexCatalog(canContinue?: boolean) {
  const catalog = cliAgentCatalog(true);
  return {
    catalogs: [
      {
        ...catalog,
        id: "codex",
        label: "Codex",
        hosts: [
          {
            ...catalog.hosts[0],
            label: "Local Codex",
            sessions:
              canContinue === undefined
                ? []
                : [
                    {
                      threadId: "codex-terminal-session",
                      name: "Native Codex terminal",
                      status: "stored",
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
      items: [{ type: "agentMessage", text: "Native answer" }],
      nextCursor: "older",
    };
    const newerRead = {
      ...latestRead,
      items: [
        { type: "agentMessage", text: "After exit" },
        { type: "agentMessage", text: "Native answer" },
      ],
    };
    const gateway = await installMockGateway(page, {
      featureMethods: [
        ...TERMINAL_START_FEATURE_METHODS,
        "sessions.catalog.read",
        "sessions.catalog.continue",
      ],
      methodResponses: {
        "sessions.catalog.list": staleCatalog,
        "sessions.catalog.read": {
          sequence: [
            {
              hostId: "gateway:local",
              threadId: "codex-terminal-session",
              items: [{ type: "agentMessage", text: "Older answer" }],
            },
            latestRead,
            newerRead,
          ],
        },
        "sessions.catalog.continue": { sessionKey: "agent:main:continued-after-exit" },
        "terminal.list": { sessions: [] },
        "terminal.open": {
          agentId: "main",
          confined: false,
          cwd: "/workspace",
          sessionId: "codex-terminal-release",
          shell: "/bin/zsh",
        },
      },
      terminalEnabled: true,
    });
    const readCount = () =>
      gateway.getRequests("sessions.catalog.read").then((rows) => rows.length);
    await page.goto(`${suite.server.baseUrl}chat`);
    await expandCodingSection(page);
    const row = page.locator(CATALOG_ROW).filter({ hasText: "Native Codex terminal" });
    await gateway.deferNext("sessions.catalog.read");
    const readsBeforeRefresh = await readCount();
    await row.click();
    const pane = page.locator("openclaw-chat-pane").filter({ hasText: "Native answer" });
    const composer = pane.locator(".agent-chat__composer-combobox > textarea");
    await expect.poll(readCount).toBeGreaterThan(readsBeforeRefresh);
    const readsWhileLoading = await readCount();
    await row.click({ button: "right", force: true });
    await page.locator('wa-dropdown-item[value="terminal"]').click({ force: true });
    await gateway.waitForRequest("terminal.open");
    await gateway.setMethodResponse("sessions.catalog.list", {
      sequence: [staleCatalog, staleCatalog, staleCatalog, staleCatalog, codexCatalog(true)],
    });
    await gateway.emitGatewayEvent("terminal.exit", {
      sessionId: "codex-terminal-release",
      reason: "process_exit",
      exitCode: 0,
    });
    await page.clock.fastForward(5_100);
    await expect.poll(readCount).toBe(readsWhileLoading);
    await gateway.resolveDeferred("sessions.catalog.read", latestRead);
    await row.click();
    await page.clock.fastForward(28_100);
    await page.clock.fastForward(1_100);
    await expect.poll(() => composer.isEnabled()).toBe(true);
    expect(
      await pane.evaluate((element) =>
        Reflect.get(element, "catalogMessages").map(
          (message: { content: Array<{ text: string }> }) => message.content[0]?.text,
        ),
      ),
    ).toEqual(["Older answer", "Native answer", "After exit"]);
    await gateway.deferNext("sessions.catalog.continue");
    await composer.fill("Continue after exit");
    await composer.press("Enter");
    await gateway.waitForRequest("sessions.catalog.continue");
    await page.clock.fastForward(2_100);
    await gateway.resolveDeferred("sessions.catalog.continue");
    await expect.poll(() => page.url()).toContain("continued-after-exit");
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
        },
      },
      terminalEnabled: true,
      workspace: WORKSPACE,
    });
    await page.goto(`${suite.server.baseUrl}new?agent=main&catalog=codex`);
    const message = page.locator(".new-session-page__message");
    await message.fill("Explain the project architecture");
    await message.press("Enter");
    await page.waitForURL(`${suite.server.baseUrl}terminal/codex-new-terminal`);
    await page.locator(".tabstrip-tab").waitFor();
    await gateway.setMethodResponse("sessions.catalog.list", {
      sequence: [codexCatalog(), codexCatalog(), codexCatalog(true)],
    });
    await gateway.emitGatewayEvent("terminal.exit", {
      sessionId: "codex-new-terminal",
      reason: "process_exit",
      exitCode: 0,
    });
    await page.clock.fastForward(5_100);
    await page.clock.fastForward(28_100);
    expect(await page.locator(CATALOG_ROW).count()).toBe(0);
    await page.clock.fastForward(1_100);
    await expandCodingSection(page);
    const row = page.locator(CATALOG_ROW).filter({ hasText: "Native Codex terminal" });
    await row.click();
    const pane = page
      .locator("openclaw-chat-pane.chat-pane-cache__pane--visible")
      .filter({ hasText: "Native answer" });
    await expect
      .poll(() => pane.locator(".agent-chat__composer-combobox > textarea").isEnabled())
      .toBe(true);
  });
});
