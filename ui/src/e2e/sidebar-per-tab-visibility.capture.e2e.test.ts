import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import {
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

const MAIN_KEY = "agent:main:main";
const RESEARCH_KEY = "agent:main:research";

function sessionsMock() {
  return {
    methodResponses: {
      "sessions.list": sessionsListResponse([
        sessionRow(MAIN_KEY, "Main", Date.parse("2026-07-01T16:00:00.000Z")),
        sessionRow(RESEARCH_KEY, "Research notes", Date.parse("2026-07-01T15:00:00.000Z")),
      ]),
      "sessions.patch": {},
    },
    sessionKey: MAIN_KEY,
  } as const;
}

function catalogSessionsMock() {
  const scenario = sessionsMock();
  return {
    ...scenario,
    featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
    methodResponses: {
      ...scenario.methodResponses,
      "sessions.catalog.list": {
        catalogs: [
          {
            id: "codex",
            label: "Codex",
            capabilities: { continueSession: true, archive: true },
            hosts: [
              {
                hostId: "gateway:local",
                label: "Local Codex",
                kind: "gateway",
                connected: true,
                sessions: [
                  {
                    threadId: "thread-sidebar-collapse",
                    name: "Catalog session notes",
                    status: "idle",
                    archived: false,
                    canContinue: true,
                    canArchive: true,
                  },
                ],
              },
            ],
          },
        ],
      },
      "sessions.catalog.read": {
        hostId: "gateway:local",
        threadId: "thread-sidebar-collapse",
        items: [{ id: "catalog-message", type: "userMessage", text: "Catalog transcript loaded" }],
      },
    },
  };
}

suite.define(() => {
  it("keeps the sidebar on a bare /chat first load", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    try {
      await installMockGateway(page, sessionsMock());
      await page.goto(`${suite.server.baseUrl}chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.waitFor({ state: "visible", timeout: 10_000 });
      // The general chat surface is the app's main view; collapsing it here
      // would be a default-path regression, so this is the guard for it.
      await expect.poll(() => sidebar.isVisible()).toBe(true);
      await captureUiProof(suite, page, "per-tab-01-chat-root-sidebar-visible.png");
    } finally {
      await context.close();
    }
  });

  it("keeps the sidebar on an unmarked direct conversation link", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    try {
      await installMockGateway(page, sessionsMock());
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, RESEARCH_KEY));
      const sidebar = page.locator("openclaw-app-sidebar");
      const composer = page.getByPlaceholder("Message OpenClaw");
      await sidebar.waitFor({ state: "visible", timeout: 10_000 });
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => sidebar.isVisible()).toBe(true);
    } finally {
      await context.close();
    }
  });

  it.each([
    { catalog: false, gesture: "middle" },
    { catalog: false, gesture: "modifier" },
    { catalog: true, gesture: "middle" },
    { catalog: true, gesture: "modifier" },
  ] as const)(
    "opens an expanded session tab (catalog: $catalog, gesture: $gesture)",
    async ({ catalog, gesture }) => {
      const context = await suite.browser.newContext({
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      });
      const scenario = catalog ? catalogSessionsMock() : sessionsMock();
      // Browser-created tabs need the fixture before their first document loads.
      await context.route("**" + CONTROL_UI_BOOTSTRAP_CONFIG_PATH, (route) =>
        route.fulfill({ json: createControlUiMockBootstrapConfig(scenario) }),
      );
      await context.addInitScript({ content: createControlUiMockGatewayInitScript(scenario) });
      const page = await context.newPage();
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, MAIN_KEY));
        const composer = page.locator(".agent-chat__composer-combobox > textarea");
        await composer.fill("Keep this unsent draft in the original tab");
        const originalUrl = page.url();
        const link = page.locator(
          catalog
            ? '[data-session-section="catalog:codex"] .sidebar-recent-session__link'
            : '[data-session-key="agent:main:research"] .sidebar-recent-session__link',
        );
        await link.waitFor({ state: "visible" });
        const href = await link.getAttribute("href");
        expect(href).not.toBeNull();
        const targetUrl = new URL(href!, page.url());
        const [sessionTab] = await Promise.all([
          context.waitForEvent("page"),
          gesture === "middle"
            ? link.click({ button: "middle" })
            : link.click({ modifiers: ["ControlOrMeta"] }),
        ]);
        const tabComposer = sessionTab.locator(".agent-chat__composer-combobox > textarea");
        await tabComposer.waitFor({ state: "visible", timeout: 10_000 });
        if (catalog) {
          await sessionTab.getByText("Catalog transcript loaded", { exact: true }).waitFor();
          const requests = await sessionTab.evaluate(() => {
            const gateway = (
              window as Window & {
                openclawControlUiE2eGateway?: {
                  findRequests: (method: string) => MockGatewayRequest[];
                };
              }
            ).openclawControlUiE2eGateway;
            if (!gateway) {
              throw new Error("Mock Gateway is not installed");
            }
            return gateway.findRequests("sessions.catalog.read");
          });
          expect(requests[0]?.params).toMatchObject({
            catalogId: "codex",
            hostId: "gateway:local",
            threadId: "thread-sidebar-collapse",
          });
        }
        await captureUiProof(
          suite,
          sessionTab,
          (catalog ? "catalog" : "session") + "-" + gesture + "-new-tab.png",
        );
        const sidebar = sessionTab.locator("openclaw-app-sidebar");
        await expect.poll(() => sidebar.isVisible()).toBe(true);
        expect(targetUrl.searchParams.has("nav")).toBe(false);
        expect(sessionTab.url()).toBe(targetUrl.href);
        expect(page.url()).toBe(originalUrl);
        expect(await composer.inputValue()).toBe("Keep this unsent draft in the original tab");

        await sessionTab.keyboard.press("ControlOrMeta+B");
        await expect.poll(() => sidebar.isVisible()).toBe(false);
        expect(await page.locator("openclaw-app-sidebar").isVisible()).toBe(true);
        await sessionTab.keyboard.press("ControlOrMeta+B");
        await sidebar.waitFor({ state: "visible" });

        await page.keyboard.press("ControlOrMeta+B");
        await expect.poll(() => page.locator("openclaw-app-sidebar").isVisible()).toBe(false);
        expect(await sidebar.isVisible()).toBe(true);
        await sessionTab.reload();
        await tabComposer.waitFor({ state: "visible" });
        await sidebar.waitFor({ state: "visible" });
        expect(await page.locator("openclaw-app-sidebar").isVisible()).toBe(false);
      } finally {
        await context.close();
      }
    },
  );
});
