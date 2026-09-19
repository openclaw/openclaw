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
      items: [
        { id: "native-answer", type: "agentMessage", text: "Native answer" },
        { id: "older-answer", type: "agentMessage", text: "Older answer" },
      ],
      nextCursor: "older",
    };
    const newerRead = {
      ...latestRead,
      items: [
        { id: "after-exit", type: "agentMessage", text: "After exit" },
        { id: "native-answer", type: "agentMessage", text: "Native answer finalized" },
        { id: "older-answer", type: "agentMessage", text: "Older answer" },
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
        "sessions.catalog.read": latestRead,
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
    const catalogListCount = () =>
      gateway.getRequests("sessions.catalog.list").then((rows) => rows.length);
    await page.goto(`${suite.server.baseUrl}chat`);
    await gateway.waitForRequest("sessions.catalog.list");
    await expandCodingSection(page);
    const row = page.locator(CATALOG_ROW).filter({ hasText: "Native Codex terminal" });
    await gateway.deferNext("sessions.catalog.read");
    const readsBeforeRefresh = await readCount();
    await row.click();
    const pane = page
      .locator("openclaw-chat-pane.chat-pane-cache__pane--visible")
      .filter({ hasText: "Native answer" });
    const composer = pane.locator(".agent-chat__composer-combobox > textarea");
    await expect.poll(readCount).toBeGreaterThan(readsBeforeRefresh);
    const readsWhileLoading = await readCount();
    await row.click({ button: "right", force: true });
    await page.locator('wa-dropdown-item[value="terminal"]').click({ force: true });
    await gateway.waitForRequest("terminal.open");
    const listsBeforeRelease = await catalogListCount();
    await gateway.emitGatewayEvent("terminal.exit", {
      sessionId: "codex-terminal-release",
      reason: "process_exit",
      exitCode: 0,
    });
    await page.clock.fastForward(5_100);
    await gateway.waitForRequest("sessions.catalog.list", { after: listsBeforeRelease });
    await expect.poll(readCount).toBe(readsWhileLoading);
    await gateway.resolveDeferred("sessions.catalog.read", latestRead);
    await expect.poll(() => pane.getByText("Native answer").count()).toBe(1);
    const readsBeforeReturn = await readCount();
    await gateway.deferNext("sessions.catalog.read");
    await row.click();
    await page.waitForURL(/\/chat/u);
    await gateway.waitForRequest("sessions.catalog.read", { after: readsBeforeReturn });
    await gateway.resolveDeferred("sessions.catalog.read", latestRead);
    await expect
      .poll(() => pane.evaluate((element) => Reflect.get(element, "catalogLoading")))
      .toBe(false);
    await gateway.setMethodResponse("sessions.catalog.list", codexCatalog(true));
    await gateway.setMethodResponse("sessions.catalog.read", newerRead);
    const listsBeforeReconcile = await catalogListCount();
    const readsBeforeReconcile = await readCount();
    await page.clock.fastForward(28_100);
    await gateway.waitForRequest("sessions.catalog.list", { after: listsBeforeReconcile });
    await gateway.waitForRequest("sessions.catalog.read", { after: readsBeforeReconcile });
    await expect.poll(() => composer.isEnabled()).toBe(true);
    expect(
      await pane.evaluate((element) =>
        Reflect.get(element, "catalogMessages").map(
          (message: { content: Array<{ text: string }> }) => message.content[0]?.text,
        ),
      ),
    ).toEqual(["Older answer", "Native answer finalized", "After exit"]);
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
    await gateway.waitForRequest("sessions.catalog.list");
    const start = page.locator(".new-session-page__start-submit");
    const message = page.locator(".new-session-page__message");
    await message.fill("Explain the project architecture");
    await expect.poll(() => start.isEnabled()).toBe(true);
    await message.press("Enter");
    await gateway.waitForRequest("sessions.catalog.startTerminal");
    await page.waitForURL(`${suite.server.baseUrl}terminal/codex-new-terminal`);
    await page.locator(".tabstrip-tab").waitFor();
    await page.clock.install();
    const listsBeforeRelease = (await gateway.getRequests("sessions.catalog.list")).length;
    await gateway.emitGatewayEvent("terminal.exit", {
      sessionId: "codex-new-terminal",
      reason: "process_exit",
      exitCode: 0,
    });
    await page.clock.fastForward(5_100);
    await gateway.waitForRequest("sessions.catalog.list", { after: listsBeforeRelease });
    expect(await page.locator(CATALOG_ROW).count()).toBe(0);
    await gateway.setMethodResponse("sessions.catalog.list", codexCatalog(true));
    const listsBeforeReconcile = (await gateway.getRequests("sessions.catalog.list")).length;
    await page.clock.fastForward(28_100);
    await gateway.waitForRequest("sessions.catalog.list", { after: listsBeforeReconcile });
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
