import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { GatewayBrowserClient } from "../api/gateway.ts";
import { captureI18nStateForTesting } from "../i18n/lib/translate.test-support.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import { setNativeControlHost } from "./native-web-chrome.ts";
import { resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, persistSessionToken, saveSettings } from "./settings.ts";

let runtime: ApplicationRuntime | undefined;
const originalUrl = window.location.href;
beforeEach(() => {
  onTestFinished(captureI18nStateForTesting());
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({})),
  );
  vi.spyOn(GatewayBrowserClient.prototype, "start").mockImplementation(() => {});
  resetServerUiPrefsSync();
  document.documentElement.setAttribute(
    CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
    JSON.stringify({
      basePath: "",
      assistantName: "Synthetic assistant",
      assistantAvatar: "",
      preferences: {
        profileId: "synthetic-operator",
        config: { ui: { prefs: { themeMode: "dark", locale: "de" } } },
        entries: {
          "ui.theme": "claw",
          "ui.themeMode": "light",
          "ui.railShortcuts": ["route:sessions"],
          "ui.personalSessionGroups": [
            { id: "focus", label: "Focus", sessionKeys: ["agent:main:work"] },
          ],
        },
      },
    }),
  );
  window.history.replaceState({}, "", "/chat/main/dashboard/synthetic-dashboard");
});
afterEach(async () => {
  runtime?.stop();
  runtime = undefined;
  resetServerUiPrefsSync();
  setNativeControlHost(false);
  document.documentElement.removeAttribute(CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE);
  await vi.dynamicImportSettled();
  window.history.replaceState({}, "", originalUrl);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("uses the viewer's document preferences before hello without loading editable config", () => {
  runtime = bootstrapApplication();
  expect(runtime.context.gateway.snapshot.phase).not.toBe("connected");
  expect(runtime.context.theme.settings).toMatchObject({
    theme: "claw",
    themeMode: "light",
    locale: "de",
    sidebarEntries: ["route:sessions"],
    personalSessionGroups: [{ id: "focus", label: "Focus", sessionKeys: ["agent:main:work"] }],
  });
  expect(document.documentElement.dataset.themeMode).toBe("light");
  expect(runtime.context.runtimeConfig.state.configSnapshot).toBeNull();
  expect(runtime.context.runtimeConfig.state.bootstrapConfig).toMatchObject({
    ui: { prefs: { locale: "de" } },
  });
});

it("does not adopt navigation-authenticated preferences for a selected bearer identity", () => {
  persistSessionToken(loadSettings().gatewayUrl, "synthetic-other-identity");
  runtime = bootstrapApplication();
  expect(runtime.context.runtimeConfig.state.bootstrapConfig).toBeNull();
  expect(runtime.context.theme.settings.themeMode).not.toBe("light");
  expect(runtime.context.theme.settings.personalSessionGroups).toEqual([]);
});

it.each([null, "synthetic-native-token"])(
  "keeps native target appearance and credentials (token: %s)",
  (token) => {
    const previous = loadSettings();
    const target = "wss://native-theme.example.test/";
    saveSettings({
      ...previous,
      gatewayUrl: target,
      theme: "space-pack/xenovessel",
      themeMode: "dark",
    });
    saveSettings({ ...previous, theme: "claw", themeMode: "system" }, { selectGateway: true });
    persistSessionToken(target, "synthetic-stored-token");
    window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl: target, token };
    runtime = bootstrapApplication();
    expect(runtime.context.gateway.connection.token).toBe(token ?? "");
    expect(loadSettings(target)).toMatchObject({
      theme: "space-pack/xenovessel",
      themeMode: "dark",
    });
    expect(runtime.context.theme.settings).toMatchObject({
      gatewayUrl: target,
      theme: "space-pack/xenovessel",
      themeMode: "dark",
    });
  },
);
