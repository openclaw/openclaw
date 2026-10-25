import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import {
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import { catalogList, expectVisible, mockRequests } from "./sidebar-assertions.test-support.ts";

const suite = createSessionManagementE2eSuite();
const pageOptions = {
  colorScheme: "dark",
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 900, width: 1280 },
} as const;

const MAIN_KEY = "agent:main:main";
const RESEARCH_KEY = "agent:main:research";

function sessionsMock() {
  return {
    methodResponses: {
      "sessions.list": sessionsListResponse([
        sessionRow(MAIN_KEY, "Main", Date.parse("2026-07-01T16:00:00.000Z")),
        sessionRow(RESEARCH_KEY, "Research notes", Date.parse("2026-07-01T15:00:00.000Z")),
      ]),
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
      "sessions.catalog.list": catalogList({
        id: "codex",
        label: "Codex",
        host: "Local Codex",
        thread: "thread-sidebar-collapse",
        name: "Catalog session notes",
        status: "idle",
        archive: true,
      }),
      "sessions.catalog.read": {
        hostId: "gateway:local",
        threadId: "thread-sidebar-collapse",
        items: [{ id: "catalog-message", type: "userMessage", text: "Catalog transcript loaded" }],
      },
    },
  };
}

suite.define(() => {
  it.each([
    { catalog: false, gesture: "middle" },
    { catalog: true, gesture: "modifier" },
  ] as const)(
    "opens an expanded session tab (catalog: $catalog, gesture: $gesture)",
    async ({ catalog, gesture }) => {
      await suite.withPage(pageOptions, async ({ context, page }) => {
        const scenario = catalog ? catalogSessionsMock() : sessionsMock();
        // Browser-created tabs need the fixture before their first document loads.
        await context.route("**" + CONTROL_UI_BOOTSTRAP_CONFIG_PATH, (route) =>
          route.fulfill({ json: createControlUiMockBootstrapConfig(scenario) }),
        );
        await context.addInitScript({ content: createControlUiMockGatewayInitScript(scenario) });

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
          const requests = await mockRequests(sessionTab, "sessions.catalog.read");
          expect(requests[0]?.params).toMatchObject({
            catalogId: "codex",
            hostId: "gateway:local",
            threadId: "thread-sidebar-collapse",
          });
        }
        const sidebar = sessionTab.locator("openclaw-app-sidebar .sidebar-shell");
        await expectVisible(sidebar);
        expect(targetUrl.searchParams.has("nav")).toBe(false);
        expect(sessionTab.url()).toBe(targetUrl.href);
        expect(page.url()).toBe(originalUrl);
        expect(await composer.inputValue()).toBe("Keep this unsent draft in the original tab");

        await sessionTab.keyboard.press("ControlOrMeta+B");
        await expectVisible(sidebar, false);
        expect(await sessionTab.locator(".sidebar-rail").isVisible()).toBe(true);
        await expect
          .poll(async () => (await sessionTab.locator("main.content").boundingBox())?.x)
          .toBe(52);
        expect(await page.locator("openclaw-app-sidebar .sidebar-shell").isVisible()).toBe(true);
        await sessionTab.keyboard.press("ControlOrMeta+B");
        await sidebar.waitFor({ state: "visible" });

        await page.keyboard.press("ControlOrMeta+B");
        await expectVisible(page.locator("openclaw-app-sidebar .sidebar-shell"), false);
        expect(await sidebar.isVisible()).toBe(true);
        await sessionTab.reload();
        await tabComposer.waitFor({ state: "visible" });
        await sidebar.waitFor({ state: "visible" });
        expect(await page.locator("openclaw-app-sidebar .sidebar-shell").isVisible()).toBe(false);
      });
    },
  );
});
