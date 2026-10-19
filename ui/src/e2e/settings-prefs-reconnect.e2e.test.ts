import type { Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  pauseVirtualClock,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI server prefs reconnect sync",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

function configResponse(prefs: Record<string, unknown>, hash: string) {
  const config = { ui: { prefs } };
  return {
    config,
    hash,
    configRevisionHash: hash,
    appliedConfigHash: hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeTruthy();
  expect(typeof value, label).toBe("object");
  expect(Array.isArray(value), label).toBe(false);
  return value as Record<string, unknown>;
}

function patchPrefs(request: MockGatewayRequest): Record<string, unknown> {
  const params = requireRecord(request.params, "config.patch params");
  expect(Object.hasOwn(params, "baseHash")).toBe(false);
  expect(typeof params.raw).toBe("string");
  const parsed = requireRecord(JSON.parse(String(params.raw)), "config.patch raw");
  const ui = requireRecord(parsed.ui, "config.patch ui");
  return requireRecord(ui.prefs, "config.patch ui.prefs");
}

function createContext(colorScheme?: "dark" | "light") {
  return suite.newBrowserContext({
    ...(colorScheme ? { colorScheme } : {}),
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
  });
}

function installPrefsGateway(page: Page, initial: ReturnType<typeof configResponse>) {
  return installMockGateway(page, { methodResponses: { "config.get": initial } });
}

const systemPrefs = { theme: "claw", themeMode: "system" };
const themePatch = { theme: "knot", accent: "theme" };
const knotPrefs = { ...themePatch, themeMode: "system" };

async function openAppearance(
  hash: string,
  prefs: Record<string, unknown> = systemPrefs,
  clock = false,
) {
  const context = await createContext();
  const page = await context.newPage();
  if (clock) {
    await page.clock.install();
  }
  const gateway = await installPrefsGateway(page, configResponse(prefs, hash));
  return { page, gateway };
}

async function visitAppearance(page: Page, gateway: MockGatewayControls, checkStatus = false) {
  const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
  if (checkStatus) {
    expect(response?.status()).toBe(200);
  }
  await themeCard(page, "claw").waitFor();
  await gateway.waitForRequest("config.get");
}

async function appearancePair(hash: string, prefs: Record<string, unknown>, shared = false) {
  const contextA = await createContext();
  const contextB = shared ? contextA : await createContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  if (shared) {
    await pageA.clock.install();
  }
  const initial = configResponse(prefs, hash);
  const gatewayA = await installPrefsGateway(pageA, initial);
  const gatewayB = await installPrefsGateway(pageB, initial);
  await Promise.all(
    [pageA, pageB].map((page) => page.goto(`${suite.server.baseUrl}settings/appearance`)),
  );
  await Promise.all([pageA, pageB].map((page) => themeCard(page, "claw").waitFor()));
  if (shared) {
    await Promise.all([gatewayA, gatewayB].map((gateway) => gateway.waitForRequest("config.get")));
  }
  return { pageA, pageB, gatewayA, gatewayB };
}

async function resolvePatch(
  gateway: MockGatewayControls,
  config: ReturnType<typeof configResponse>,
) {
  await gateway.setMethodResponse("config.get", config);
  await gateway.resolveDeferred("config.patch", config);
}

async function expectLightTheme(page: Page) {
  await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("light");
  await expect.poll(() => page.locator("html").getAttribute("data-theme-resolved")).toBe("light");
  await expectMirror(page, { theme: "claw", themeMode: "light" });
}

async function expectMirror(page: Page, prefs: Record<string, unknown>) {
  await expect.poll(() => readSettingsMirror(page)).toMatchObject(prefs);
}

async function waitForRequestCount(
  gateway: MockGatewayControls,
  method: string,
  count: number,
): Promise<void> {
  await expect
    .poll(async () => (await gateway.getRequests(method)).length, { timeout: 10_000 })
    .toBe(count);
}

async function proxyReconnect(
  page: Page,
  gateway: MockGatewayControls,
  whileDisconnected: () => Promise<void>,
): Promise<void> {
  await pauseVirtualClock(page);
  const socketCountBefore = await gateway.getSocketCount();
  await gateway.closeLatest(1001, "proxy idle timeout");
  await gateway.setOnline(false);
  await expectPhase(page, "reconnecting");
  await whileDisconnected();
  expect(await gateway.getRequests("config.patch")).toHaveLength(0);
  const retryDelay = await evaluateControlUiContext(
    page,
    ({ gateway: source }) => (source.snapshot.reconnectAt ?? Number.NaN) - Date.now(),
  );
  expect(retryDelay).toBeGreaterThan(0);
  await page.clock.fastForward(retryDelay);
  await expect
    .poll(() => gateway.getSocketCount(), { timeout: 10_000 })
    .toBeGreaterThan(socketCountBefore);
  expect(await gateway.getRequests("config.patch")).toHaveLength(0);
  await gateway.setOnline(true);
  await page.clock.resume();
  await expectPhase(page, "connected");
  await page.locator(".settings-page").waitFor({ timeout: 10_000 });
}

async function expectPhase(page: Page, phase: string) {
  await expect
    .poll(() => page.evaluate(() => window.openclawControlUi?.snapshot().gatewayPhase))
    .toBe(phase);
}

async function readSettingsMirror(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((candidate) =>
      candidate.startsWith("openclaw.control.settings.v1:"),
    );
    if (!key) {
      return null;
    }
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  });
}

async function readPendingPrefStorage(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith("openclaw.control.serverPrefs.pending.v1:"))
      .map((key) => JSON.parse(localStorage.getItem(key) ?? "null") as Record<string, unknown>),
  );
}

function themeCard(page: Page, theme: "claw" | "knot" | "dash") {
  return page.locator(`.settings-theme-card--${theme}`);
}

async function expectThemeActive(page: Page, theme: "claw" | "knot" | "dash"): Promise<void> {
  await expect
    .poll(() => themeCard(page, theme).getAttribute("class"), { timeout: 10_000 })
    .toContain("settings-theme-card--active");
}

function themeModeOption(page: Page, mode: "system" | "light" | "dark") {
  return page.locator(`input.settings-segmented__input[value="${mode}"]`);
}

suite.define(() => {
  it.each(["new", "chat"])(
    "keeps %s renders storage-free and applies cross-tab send preferences",
    async (route) => {
      const context = await createContext();
      const page = await context.newPage();
      const gateway = await installMockGateway(page, { agentModel: "openai/gpt-5.6-luna" });
      await page.goto(`${suite.server.baseUrl}${route}`);
      const selector =
        route === "new" ? ".new-session-page__message" : ".agent-chat__composer-combobox textarea";
      const textarea = page.locator(selector).first();
      await textarea.waitFor();
      await textarea.fill("Synthetic preference proof");
      const reads = await page.evaluate(
        async ({ activeRoute, selector: textareaSelector }) => {
          const owner = document.querySelector(
            activeRoute === "new" ? "openclaw-new-session-page" : "openclaw-chat-pane",
          ) as HTMLElement & { updateComplete: Promise<unknown> };
          const input = document.querySelector<HTMLTextAreaElement>(textareaSelector)!;
          const draft = input.value;
          const descriptor = Object.getOwnPropertyDescriptor(Storage.prototype, "getItem")!;
          const keys: string[] = [];
          Storage.prototype.getItem = function (key) {
            if (/^openclaw\.control\.(settings|currentGateway|token)\./u.test(key)) {
              keys.push(key);
            }
            return Reflect.apply(descriptor.value, this, [key]);
          };
          try {
            for (let index = 0; index < 10; index++) {
              input.value = index % 2 === 0 ? `${draft} ` : draft;
              input.dispatchEvent(new Event("input", { bubbles: true }));
              await owner.updateComplete;
            }
            return keys;
          } finally {
            Object.defineProperty(Storage.prototype, "getItem", descriptor);
          }
        },
        { activeRoute: route, selector },
      );
      expect(reads).toEqual([]);

      const otherTab = await context.newPage();
      // An inert same-origin document produces a real cross-tab storage event,
      // without a second app racing to write server preferences.
      await otherTab.route("**/preference-writer", (request) =>
        request.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Preference writer</title>",
        }),
      );
      await otherTab.goto(`${suite.server.baseUrl}preference-writer`);
      await otherTab.evaluate((key) => {
        const current = JSON.parse(localStorage.getItem(key) ?? "{}");
        localStorage.setItem(
          key,
          JSON.stringify({ ...current, chatSendShortcut: "modifier-enter" }),
        );
      }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
      await expect
        .poll(() =>
          evaluateControlUiContext(
            page,
            (application) => application.theme.settings.chatSendShortcut,
          ),
        )
        .toBe("modifier-enter");
      await textarea.press("Enter");
      expect(await textarea.inputValue()).toBe("Synthetic preference proof\n");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    },
  );

  it("preserves a profile's explicit light theme while reconnecting", async () => {
    const context = await createContext("dark");
    const page = await context.newPage();
    const initial = configResponse({}, "prefs-profile-light-1");
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": initial,
        "users.prefs.get": {
          entries: { "ui.theme": "claw", "ui.themeMode": "light" },
          status: "ok",
        },
      },
      presenceUsers: [{ id: "profile-theme-light", self: true }],
    });

    const response = await page.goto(`${suite.server.baseUrl}chat`);
    expect(response?.status()).toBe(200);
    await gateway.waitForRequest("config.get");
    await gateway.waitForRequest("users.prefs.get");
    await gateway.waitForRequest("chat.startup");
    await expectLightTheme(page);

    await gateway.setOnline(false);
    const identity = page.locator("openclaw-app-sidebar .sidebar-identity-card");
    await expect.poll(() => identity.getAttribute("data-connection-status")).toBe("reconnecting");
    expect(await identity.getAttribute("aria-label")).toContain("Reconnecting…");
    expect(await identity.getAttribute("title")).toBe(await identity.getAttribute("aria-label"));
    await page.locator(".agent-chat__input--offline").waitFor();

    await expectLightTheme(page);
  });

  it("replays an offline theme edit after a same-client reconnect", async () => {
    const { page, gateway } = await openAppearance("prefs-a-1", systemPrefs, true);
    const committed = configResponse(knotPrefs, "prefs-a-2");

    await visitAppearance(page, gateway, true);
    const configGetsBeforeEdit = (await gateway.getRequests("config.get")).length;
    await gateway.deferNext("config.patch");

    await proxyReconnect(page, gateway, async () => {
      await themeCard(page, "knot").click();
      await expectThemeActive(page, "knot");
      expect(await readPendingPrefStorage(page)).toEqual(
        expect.arrayContaining([expect.objectContaining(themePatch)]),
      );
    });

    // Reconnect owns one authoritative read even while the pending LWW preference shadows it.
    await waitForRequestCount(gateway, "config.get", configGetsBeforeEdit + 1);
    const patch = await gateway.waitForRequest("config.patch");
    expect(patchPrefs(patch)).toEqual(themePatch);

    await resolvePatch(gateway, committed);
    await expect
      .poll(() =>
        evaluateControlUiContext(
          page,
          (application) => application.runtimeConfig.state.configSnapshot,
        ),
      )
      .toMatchObject({ config: committed.config, hash: committed.hash });
    await expect.poll(() => readPendingPrefStorage(page)).toEqual([]);
    await expectThemeActive(page, "knot");
    expect(await gateway.getRequests("config.get")).toHaveLength(configGetsBeforeEdit + 1);
  });

  it("keeps offline intent through read-only reconnect and dispatches once after authorization", async () => {
    const { page, gateway } = await openAppearance("prefs-scope-1", systemPrefs, true);
    const committed = configResponse(knotPrefs, "prefs-scope-2");

    await visitAppearance(page, gateway, true);

    await proxyReconnect(page, gateway, async () => {
      await themeCard(page, "knot").click();
      await expectThemeActive(page, "knot");
      await gateway.setOperatorScopes(["operator.read"]);
    });

    await expectThemeActive(page, "knot");
    expect(await gateway.getRequests("config.patch")).toHaveLength(0);
    expect(await readPendingPrefStorage(page)).toEqual(
      expect.arrayContaining([expect.objectContaining(themePatch)]),
    );

    await gateway.deferNext("config.patch");
    await gateway.setMethodResponse("config.get", committed);
    await proxyReconnect(page, gateway, async () => {
      await gateway.setOperatorScopes(["operator.admin", "operator.read", "operator.write"]);
    });

    const patch = await gateway.waitForRequest("config.patch");
    expect(patchPrefs(patch)).toEqual(themePatch);
    await gateway.resolveDeferred("config.patch", committed);
    await expectThemeActive(page, "knot");
    await waitForRequestCount(gateway, "config.patch", 1);
  });

  it("does not resurrect an offline edit superseded browser-locally in another tab", async () => {
    const { pageA, pageB, gatewayA, gatewayB } = await appearancePair(
      "prefs-tabs-1",
      systemPrefs,
      true,
    );

    await proxyReconnect(pageB, gatewayB, async () => {
      await gatewayB.setOperatorScopes(["operator.read"]);
    });

    // Interacted tabs need foreground animation frames for click actionability.
    await pageA.bringToFront();
    await proxyReconnect(pageA, gatewayA, async () => {
      await themeCard(pageA, "knot").click();
      await expectThemeActive(pageA, "knot");
      expect(await readPendingPrefStorage(pageA)).toEqual([
        { theme: "knot", accent: "theme", fontUi: null, fontChat: null },
      ]);
      await pageB.bringToFront();
      await themeCard(pageB, "dash").click();
      await expectThemeActive(pageB, "dash");
      expect(await readPendingPrefStorage(pageB)).toEqual([]);
    });
    expect(await readPendingPrefStorage(pageA)).toEqual([]);

    await pageA.bringToFront();
    await themeModeOption(pageA, "dark").click();
    const patch = await gatewayA.waitForRequest("config.patch");
    expect(patchPrefs(patch)).toEqual({ themeMode: "dark" });
    expect(await gatewayA.getRequests("config.patch")).toHaveLength(1);
    expect(await gatewayB.getRequests("config.patch")).toHaveLength(0);
    await expectThemeActive(pageA, "dash");
    await expectThemeActive(pageB, "dash");
  });

  it("keeps disjoint edits from two pages after both hash-free patches", async () => {
    const { pageA, pageB, gatewayA, gatewayB } = await appearancePair("prefs-b-1", {
      theme: "claw",
    });
    await Promise.all([gatewayA.deferNext("config.patch"), gatewayB.deferNext("config.patch")]);

    await themeCard(pageA, "knot").click();
    const patchA = await gatewayA.waitForRequest("config.patch");
    const prefsA = patchPrefs(patchA);
    expect(prefsA).toEqual(themePatch);
    const themeCommitted = configResponse(prefsA, "prefs-b-2");
    await resolvePatch(gatewayA, themeCommitted);

    await pageB.locator("[data-settings-follow-up-mode]").selectOption("queue");
    const patchB = await gatewayB.waitForRequest("config.patch");
    const prefsB = patchPrefs(patchB);
    expect(prefsB).toEqual({ chatFollowUpMode: "queue" });
    expect(Object.keys(prefsA).some((key) => Object.hasOwn(prefsB, key))).toBe(false);
    const combined = configResponse({ ...prefsA, ...prefsB }, "prefs-b-3");
    await resolvePatch(gatewayB, combined);
    await gatewayA.setMethodResponse("config.get", combined);
    await gatewayA.emitGatewayEvent("config.changed", {
      path: "/tmp/openclaw.json",
      hash: "prefs-b-3",
      ts: Date.now(),
    });

    await expectThemeActive(pageA, "knot");
    await expectThemeActive(pageB, "knot");
    await expectMirror(pageA, { chatFollowUpMode: "queue", theme: "knot" });
    await expectMirror(pageB, { chatFollowUpMode: "queue", theme: "knot" });
  });

  it("applies a server delta without reverting a pending local key", async () => {
    const { page, gateway } = await openAppearance("prefs-c-1", { locale: "en", theme: "claw" });

    await visitAppearance(page, gateway);
    const initialConfigGets = (await gateway.getRequests("config.get")).length;
    await gateway.deferNext("config.patch");

    await themeCard(page, "knot").click();
    const patch = await gateway.waitForRequest("config.patch");
    expect(patchPrefs(patch)).toEqual(themePatch);

    const serverChanged = configResponse({ locale: "de", theme: "claw" }, "prefs-c-2");
    await gateway.setMethodResponse("config.get", serverChanged);
    await gateway.emitGatewayEvent("config.changed", {
      path: "/tmp/openclaw.json",
      hash: "prefs-c-2",
      ts: Date.now(),
    });
    await waitForRequestCount(gateway, "config.get", initialConfigGets + 1);

    await expectThemeActive(page, "knot");
    await expectMirror(page, { locale: "de", theme: "knot" });

    await gateway.rejectDeferred("config.patch", {
      code: "INVALID_REQUEST",
      message: "mock validation failure",
    });
    await expectThemeActive(page, "knot");
  });
});
