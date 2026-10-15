import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { GatewayBrowserClient } from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import * as gatewayStore from "./gateway-store.ts";
import { resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, persistSessionToken } from "./settings.ts";

let runtime: ApplicationRuntime | undefined;
const originalUrl = window.location.href;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({})),
  );
  const createGateway = gatewayStore.createApplicationGateway;
  vi.spyOn(gatewayStore, "createApplicationGateway").mockImplementation(
    (settings, password, bootstrap, _factory, options) =>
      createGateway(
        settings,
        password,
        bootstrap,
        (opts) => {
          const client = new GatewayBrowserClient(opts);
          vi.spyOn(client, "start").mockImplementation(() => {});
          return client;
        },
        options,
      ),
  );
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
          "ui.railShortcuts": ["route:agents-home"],
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
    sidebarEntries: ["route:agents-home"],
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
});
