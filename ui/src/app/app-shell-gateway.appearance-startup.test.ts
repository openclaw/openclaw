/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createThemeDefinitionFixture } from "../../../test/helpers/theme-fixture.js";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  createProfileAppearanceGateway,
  holdProfileAppearanceRead,
} from "./app-shell-gateway.test-support.ts";
import { createApplicationTheme } from "./bootstrap-theme.ts";
import { resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
});
afterEach(() => {
  resetServerUiPrefsSync();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["before", "after"] as const)(
  "renders the saved plugin theme when invalidation starts %s runtime-config admission",
  async (ordering) => {
    const { context, owner, snapshot, request } = createProfileAppearanceGateway("profile-owner");
    const id = "space-pack/xenovessel";
    const entries = { "ui.theme": id, "ui.themeMode": "dark" };
    const descriptor = {
      id,
      name: "Synthetic plugin theme",
      source: "plugin",
      pluginId: "space-pack",
      modes: ["dark"],
    };
    const catalog = {
      themes: [descriptor],
      theme: descriptor,
      definition: createThemeDefinitionFixture(),
      current: { id, mode: "dark", scope: "profile", overrides: { id, mode: "dark" } },
    };
    // Fixed external I/O, with the production preference, catalog and DOM owners.
    Object.assign(context.gateway, {
      subscribe: () => () => {},
      subscribeEvents: () => () => {},
    });
    patchSettings({
      gatewayUrl: context.gateway.connection.gatewayUrl,
      theme: "claw",
      themeMode: "system",
    });
    const theme = createApplicationTheme(loadSettings(), context.gateway);
    Object.assign(context, { theme });
    const { readStarted, reply } = holdProfileAppearanceRead(request);
    request.mockImplementation(async (method?: string) => {
      if (method === "users.prefs.get") {
        return { status: "ok", entries };
      }
      if (method === "themes.list" || method === "themes.get") {
        return catalog;
      }
      throw new Error("Unexpected request: " + method);
    });
    const invalidate = () =>
      owner.handleGatewayEvent({
        type: "event",
        event: "users.prefs.changed",
        payload: { profileId: "profile-owner", keys: ["ui.theme"] },
      });
    try {
      let ready: Promise<void>;
      if (ordering === "before") {
        invalidate();
        await readStarted.promise;
        ready = owner.ensureRuntimeConfig(snapshot, context.runtimeConfig);
      } else {
        ready = owner.ensureRuntimeConfig(snapshot, context.runtimeConfig);
        await readStarted.promise;
      }
      reply.resolve({ status: "ok", entries });
      await ready;
      await vi.dynamicImportSettled();
      if (ordering === "after") {
        invalidate();
        await vi.dynamicImportSettled();
      }
      const startup = {
        selected: theme.settings.theme,
        rendered: document.documentElement.dataset.themeId,
        catalogReads: request.mock.calls.filter(([method]) => method === "themes.list").length,
      };
      // A later invalidation must recover without changing the server response.
      invalidate();
      await vi.dynamicImportSettled();
      expect(document.documentElement.dataset.themeId).toBe(id);
      expect(startup).toEqual({ selected: id, rendered: id, catalogReads: 1 });
    } finally {
      theme.dispose();
      document.getElementById("openclaw-custom-theme")?.remove();
      document.documentElement.removeAttribute("style");
    }
  },
);
