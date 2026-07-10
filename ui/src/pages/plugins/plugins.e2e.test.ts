// Control UI tests cover plugin catalog browsing and lifecycle mutations.
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/version.js";
import {
  CLAWHUB_BROWSE_URL,
  type PluginCatalogItem,
  type PluginListResult,
  type PluginMutationResult,
  type PluginSearchResponse,
} from "../../lib/plugins/index.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const updateScreenshots = process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1";
const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/plugins");
const desktopViewport = { height: 1000, width: 1440 };
const mobileViewport = { height: 852, width: 393 };
const pluginMethods = ["plugins.list", "plugins.search", "plugins.install", "plugins.setEnabled"];

const workboardDisabled = {
  id: "workboard",
  name: "Workboard",
  description: "Dashboard workboard for agent-owned issues and sessions.",
  version: "2026.7.9",
  kind: ["productivity"],
  origin: "bundled",
  installed: true,
  enabled: false,
  state: "disabled",
  featured: true,
  order: 10,
} satisfies PluginCatalogItem;

const workboardEnabled = {
  ...workboardDisabled,
  enabled: true,
  state: "enabled",
} satisfies PluginCatalogItem;

const lobsterPlugin = {
  id: "lobster",
  name: "Lobster",
  description: "Run typed workflows with resumable approvals.",
  kind: ["plugin"],
  origin: "official",
  installed: false,
  enabled: false,
  state: "not-installed",
  featured: true,
  order: 50,
  install: { source: "clawhub", packageName: "@openclaw/lobster" },
} satisfies PluginCatalogItem;

const calendarPlugin = {
  id: "calendar-plus",
  name: "Calendar Plus",
  packageName: "calendar-plus",
  description: "Plan and coordinate work from a shared calendar.",
  version: "1.2.3",
  kind: ["productivity"],
  origin: "global",
  installed: true,
  enabled: true,
  state: "enabled",
} satisfies PluginCatalogItem;

const initialInventory = inventory([workboardDisabled, lobsterPlugin]);
const installedInventory = inventory([workboardDisabled, lobsterPlugin, calendarPlugin]);
const finalInventory = inventory([workboardEnabled, lobsterPlugin, calendarPlugin]);

const calendarSearchResponse = {
  results: [
    {
      score: 0.98,
      package: {
        name: "calendar-plus",
        displayName: "Calendar Plus",
        family: "code-plugin",
        channel: "community",
        isOfficial: false,
        summary: "Plan and coordinate work from a shared calendar.",
        latestVersion: "1.2.3",
      },
    },
  ],
} satisfies PluginSearchResponse;

const installResult = {
  ok: true,
  plugin: calendarPlugin,
  restartRequired: true,
} satisfies PluginMutationResult;

const enableWorkboardResult = {
  ok: true,
  plugin: workboardEnabled,
  restartRequired: false,
} satisfies PluginMutationResult;

let browser: Browser;
let server: ControlUiE2eServer;

function inventory(plugins: PluginCatalogItem[]): PluginListResult {
  return { plugins, diagnostics: [], mutationAllowed: true };
}

function configSnapshot(isWorkboardEnabled: boolean) {
  const config = {
    plugins: {
      entries: {
        workboard: { enabled: isWorkboardEnabled },
      },
    },
  };
  return {
    config,
    hash: isWorkboardEnabled ? "plugins-config-enabled" : "plugins-config-disabled",
    issues: [],
    path: "/tmp/openclaw-e2e/openclaw.json",
    raw: JSON.stringify(config, null, 2),
    resolved: config,
    sourceConfig: config,
    valid: true,
  };
}

function readOnlyConnectResponse() {
  return {
    auth: {
      deviceToken: "plugins-read-only-device-token",
      role: "operator",
      scopes: ["operator.read"],
    },
    features: { events: [], methods: pluginMethods },
    controlUiTabs: [],
    protocol: PROTOCOL_VERSION,
    server: { connId: "plugins-read-only", version: "e2e" },
    snapshot: {
      sessionDefaults: {
        defaultAgentId: "main",
        mainKey: "main",
        mainSessionKey: "main",
        scope: "agent",
      },
    },
    type: "hello-ok",
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
}

function requestParams(request: MockGatewayRequest): Record<string, unknown> {
  return requireRecord(request.params);
}

async function waitForNextRequest(
  gateway: MockGatewayControls,
  method: string,
  previousCount: number,
): Promise<MockGatewayRequest> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const requests = await gateway.getRequests(method);
    if (requests.length > previousCount) {
      const request = requests.at(-1);
      if (request) {
        return request;
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(`Timed out waiting for the next ${method} request`);
}

async function captureScreenshot(page: Page, name: string): Promise<void> {
  if (!updateScreenshots) {
    return;
  }
  await mkdir(artifactDir, { recursive: true });
  // UI transitions top out at 180ms; capture only after Chromium has painted
  // the settled catalog grid rather than a partially composited transition.
  await page.waitForTimeout(250);
  await page.locator(".content").screenshot({
    caret: "hide",
    path: path.join(artifactDir, name),
  });
}

async function newContext(viewport = desktopViewport): Promise<BrowserContext> {
  return browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
  });
}

function pluginMethodResponses() {
  return {
    "config.get": configSnapshot(false),
    "plugins.list": initialInventory,
    "plugins.search": {
      cases: [
        {
          match: { query: "calendar", limit: 20 },
          response: calendarSearchResponse,
        },
      ],
    },
    "plugins.install": {
      cases: [
        {
          match: {
            source: "clawhub",
            packageName: "calendar-plus",
            version: "1.2.3",
            acknowledgeClawHubRisk: true,
          },
          response: installResult,
        },
      ],
    },
    "plugins.setEnabled": {
      cases: [
        {
          match: { pluginId: "workboard", enabled: true },
          response: enableWorkboardResult,
        },
      ],
    },
  };
}

describeControlUiE2e("Control UI Plugins mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    if (updateScreenshots) {
      await rm(artifactDir, { force: true, recursive: true });
      await mkdir(artifactDir, { recursive: true });
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("browses the catalog, installs from ClawHub, enables Workboard, and refreshes authoritative state", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: pluginMethodResponses(),
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/plugins`);
      expect(response?.status()).toBe(200);
      await page.locator('[data-plugin-id="workboard"]').waitFor({ state: "visible" });
      await gateway.waitForRequest("config.get");

      const workboardCard = page.locator('[data-plugin-id="workboard"]');
      await page.getByRole("heading", { name: "Included with OpenClaw" }).waitFor();
      await page.getByRole("heading", { name: "Official picks" }).waitFor();
      const lobsterCard = page.locator('[data-plugin-id="lobster"]');
      await lobsterCard.getByRole("button", { name: "Install Lobster" }).waitFor();
      expect(await page.getByRole("link", { name: "Browse ClawHub" }).getAttribute("href")).toBe(
        CLAWHUB_BROWSE_URL,
      );
      expect(
        await workboardCard.getByRole("switch", { name: "Enable Workboard" }).isChecked(),
      ).toBe(false);
      expect(await workboardCard.textContent()).toContain("Disabled");
      await captureScreenshot(page, "01-catalog-desktop.png");

      await page.getByRole("tab", { name: /^ClawHub/u }).click();
      await page.getByRole("searchbox", { name: "Search plugins" }).fill("calendar");
      const searchRequest = await gateway.waitForRequest("plugins.search");
      expect(requestParams(searchRequest)).toEqual({ query: "calendar", limit: 20 });
      const searchRow = page.locator('[data-package-name="calendar-plus"]');
      await searchRow.waitFor({ state: "visible" });
      expect(await searchRow.textContent()).toContain("Calendar Plus");
      await page.getByRole("searchbox", { name: "Search plugins" }).blur();
      await captureScreenshot(page, "02-search-desktop.png");

      await gateway.deferNext("plugins.install");
      await searchRow.getByRole("button", { name: "Install Calendar Plus", exact: true }).click();
      const firstInstallRequest = await gateway.waitForRequest("plugins.install");
      expect(requestParams(firstInstallRequest)).toEqual({
        source: "clawhub",
        packageName: "calendar-plus",
      });
      await gateway.rejectDeferred("plugins.install", {
        code: "INVALID_REQUEST",
        message: "ClawHub requires acknowledgement before installing this release.",
        details: {
          clawhubTrustCode: "clawhub_risk_acknowledgement_required",
          version: "1.2.3",
          warning: "REVIEW REQUIRED - ClawHub found behavior that needs operator review.",
        },
      });

      const acknowledgeButton = searchRow.getByRole("button", {
        name: "Acknowledge risk and install",
      });
      await acknowledgeButton.waitFor({ state: "visible" });
      expect(await searchRow.getByRole("alert").textContent()).toContain("REVIEW REQUIRED");

      const listCountBeforeInstall = (await gateway.getRequests("plugins.list")).length;
      const configCountBeforeInstall = (await gateway.getRequests("config.get")).length;
      const installCountBeforeRetry = (await gateway.getRequests("plugins.install")).length;
      await gateway.deferNext("plugins.list");
      await gateway.deferNext("config.get");
      await acknowledgeButton.click();

      const retryInstallRequest = await waitForNextRequest(
        gateway,
        "plugins.install",
        installCountBeforeRetry,
      );
      expect(requestParams(retryInstallRequest)).toEqual({
        source: "clawhub",
        packageName: "calendar-plus",
        version: "1.2.3",
        acknowledgeClawHubRisk: true,
      });
      const postInstallListRequest = await waitForNextRequest(
        gateway,
        "plugins.list",
        listCountBeforeInstall,
      );
      const postInstallConfigRequest = await waitForNextRequest(
        gateway,
        "config.get",
        configCountBeforeInstall,
      );
      expect(requestParams(postInstallListRequest)).toEqual({});
      expect(requestParams(postInstallConfigRequest)).toEqual({});
      await expect.poll(() => searchRow.getAttribute("aria-busy")).toBe("true");
      expect(await searchRow.getByRole("status").textContent()).toContain(
        "A Gateway restart is required",
      );
      await gateway.resolveDeferred("plugins.list", installedInventory);
      await gateway.resolveDeferred("config.get", configSnapshot(false));
      await expect.poll(() => searchRow.getAttribute("aria-busy")).toBe("false");
      await searchRow.getByRole("switch", { name: "Disable Calendar Plus" }).waitFor({
        state: "attached",
      });

      await page.getByRole("tab", { name: /^Recommended/u }).click();
      await page.getByRole("searchbox", { name: "Search plugins" }).fill("");
      await workboardCard.waitFor({ state: "visible" });
      const listCountBeforeEnable = (await gateway.getRequests("plugins.list")).length;
      const configCountBeforeEnable = (await gateway.getRequests("config.get")).length;
      const enableCountBefore = (await gateway.getRequests("plugins.setEnabled")).length;
      await gateway.deferNext("plugins.list");
      await gateway.deferNext("config.get");
      await workboardCard.locator(".plugins-switch").click();

      const enableRequest = await waitForNextRequest(
        gateway,
        "plugins.setEnabled",
        enableCountBefore,
      );
      expect(requestParams(enableRequest)).toEqual({ pluginId: "workboard", enabled: true });
      const postEnableListRequest = await waitForNextRequest(
        gateway,
        "plugins.list",
        listCountBeforeEnable,
      );
      const postEnableConfigRequest = await waitForNextRequest(
        gateway,
        "config.get",
        configCountBeforeEnable,
      );
      expect(requestParams(postEnableListRequest)).toEqual({});
      expect(requestParams(postEnableConfigRequest)).toEqual({});
      await gateway.resolveDeferred("plugins.list", finalInventory);
      await gateway.resolveDeferred("config.get", configSnapshot(true));
      await expect.poll(() => workboardCard.getAttribute("aria-busy")).toBe("false");

      await page.getByRole("tab", { name: /^Installed/u }).click();
      await workboardCard.getByRole("switch", { name: "Disable Workboard" }).waitFor({
        state: "attached",
      });
      await page.locator('[data-plugin-id="calendar-plus"]').waitFor({ state: "visible" });
      await captureScreenshot(page, "03-enabled-installed-desktop.png");

      await page.setViewportSize(mobileViewport);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
              window.innerWidth,
          ),
        )
        .toBeLessThanOrEqual(1);
      await expect
        .poll(() =>
          page.locator(".shell-nav").evaluate((element) => element.getBoundingClientRect().right),
        )
        .toBeLessThanOrEqual(0);
      await workboardCard.waitFor({ state: "visible" });
      await captureScreenshot(page, "04-installed-mobile.png");

      await page.setViewportSize(desktopViewport);
      const settingsSidebar = page.locator(".settings-sidebar");
      if (await settingsSidebar.isVisible()) {
        await settingsSidebar.getByRole("button", { name: "Back to app" }).click();
      }
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.waitFor({ state: "visible" });
      const moreButton = sidebar.getByRole("button", { name: "More" });
      if ((await moreButton.getAttribute("aria-expanded")) !== "true") {
        await moreButton.click();
      }
      await sidebar.getByRole("link", { name: "Workboard" }).waitFor({ state: "visible" });
    } finally {
      await context.close();
    }
  });

  it("keeps plugin mutations unavailable to read-only operators while browse and search work", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        connect: readOnlyConnectResponse(),
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/plugins`);
      const workboardCard = page.locator('[data-plugin-id="workboard"]');
      await workboardCard.waitFor({ state: "visible" });
      expect(await page.getByRole("note").textContent()).toContain("operator.admin");
      expect(
        await workboardCard.getByRole("switch", { name: "Enable Workboard" }).isDisabled(),
      ).toBe(true);

      await page.getByRole("tab", { name: /^ClawHub/u }).click();
      await page.getByRole("searchbox", { name: "Search plugins" }).fill("calendar");
      const searchRequest = await gateway.waitForRequest("plugins.search");
      expect(requestParams(searchRequest)).toEqual({ query: "calendar", limit: 20 });
      const installButton = page
        .locator('[data-package-name="calendar-plus"]')
        .getByRole("button", { name: "Install Calendar Plus", exact: true });
      await installButton.waitFor({ state: "visible" });
      expect(await installButton.isDisabled()).toBe(true);
      expect(await gateway.getRequests("plugins.install")).toEqual([]);
      expect(await gateway.getRequests("plugins.setEnabled")).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("shows plugin list failures and retries the catalog request", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: pluginMethodResponses(),
    });

    try {
      await page.goto(`${server.baseUrl}settings/plugins`);
      await page.locator('[data-plugin-id="workboard"]').waitFor({ state: "visible" });
      const listCountBeforeFailure = (await gateway.getRequests("plugins.list")).length;
      await gateway.deferNext("plugins.list");
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      const failedListRequest = await waitForNextRequest(
        gateway,
        "plugins.list",
        listCountBeforeFailure,
      );
      expect(requestParams(failedListRequest)).toEqual({});
      await gateway.rejectDeferred("plugins.list", {
        code: "UNAVAILABLE",
        message: "Plugin inventory unavailable",
        retryable: true,
      });

      const error = page.locator(".plugins-page-error");
      await error.waitFor({ state: "visible" });
      expect(await error.textContent()).toContain("Plugin inventory unavailable");
      const listCountBeforeRetry = (await gateway.getRequests("plugins.list")).length;
      await gateway.deferNext("plugins.list");
      await error.getByRole("button", { name: "Try again" }).click();
      const retryListRequest = await waitForNextRequest(
        gateway,
        "plugins.list",
        listCountBeforeRetry,
      );
      expect(requestParams(retryListRequest)).toEqual({});
      await gateway.resolveDeferred("plugins.list", finalInventory);
      await error.waitFor({ state: "detached" });
      await page
        .locator('[data-plugin-id="workboard"]')
        .getByRole("switch", { name: "Disable Workboard" })
        .waitFor({ state: "attached" });
    } finally {
      await context.close();
    }
  });
});
