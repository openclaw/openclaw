/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { createApplicationTheme } from "../../app/bootstrap-theme.ts";
import type { ApplicationContext, ApplicationThemeServerSelection } from "../../app/context.ts";
import type { ImportedCustomTheme } from "../../app/custom-theme.ts";
import { loadSettings, patchSettings, type UiSettings } from "../../app/settings.ts";
import type { ThemeName } from "../../app/theme.ts";
import { createImportedCustomThemeFixture } from "../../test-helpers/custom-theme.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { completeConfigContext } from "./config-page.test-support.ts";
import { ConfigPageController } from "./config-page.ts";
import { ConfigPage } from "./config-page.tsx";
import type { CustomThemeImportOwner } from "./custom-theme-import-owner.ts";
import * as customTheme from "./custom-theme-import.ts";

const importCustomThemeFromUrl = vi.fn<typeof customTheme.importCustomThemeFromUrl>();

type CustomThemeImportState = {
  context: ApplicationContext;
  settings: UiSettings;
  customThemeImport: CustomThemeImportOwner["snapshot"];
  pageId: string;
  adoptThemeSettings: () => void;
  importCustomTheme: () => Promise<void>;
  clearCustomTheme: () => void;
  setCustomThemeImportUrl: (next: string) => void;
  setTheme: (theme: ThemeName) => void;
  customThemeImportOwner: CustomThemeImportOwner;
  retireCustomThemeImportForConfigMutation: () => void;
  synchronizeCustomThemeGatewayScope: (scope: string) => void;
};

function createCustomThemePage(settings: Partial<UiSettings> = {}) {
  const page = new ConfigPageController({} as ApplicationContext, () => {});
  const state = page as unknown as CustomThemeImportState;
  const gatewayUrl = "ws://gateway.test";
  state.context = {
    gateway: { connection: { gatewayUrl }, snapshot: { phase: "connected", selfUser: null } },
    runtimeConfig: {
      state: {
        configApplying: false,
        configAutoSaveStatus: "idle",
        configFormDirty: false,
        configLoading: false,
        configSaving: false,
        configSnapshot: { config: {}, valid: true, issues: [] },
        connected: true,
      },
    },
    theme: { recordServerSelection: vi.fn(), refresh: vi.fn(), serverSelection: null },
  } as unknown as ApplicationContext;
  state.customThemeImportOwner.connect(gatewayUrl, null);
  state.adoptThemeSettings = () => {
    state.settings = state.customThemeImportOwner.adoptSettings(
      state.settings,
      loadSettings(),
      state.context.theme.serverSelection,
    );
  };
  state.setCustomThemeImportUrl = (next) => state.customThemeImportOwner.setUrl(next);
  state.synchronizeCustomThemeGatewayScope = (scope) =>
    state.customThemeImportOwner.synchronizeScope(scope, state.context.theme.serverSelection);
  state.retireCustomThemeImportForConfigMutation = () =>
    state.customThemeImportOwner.retireForConfigMutation("You have unsaved changes");
  state.settings = { ...loadSettings(), ...settings };
  return { page, state };
}

function customThemeFixture(label: string, themeId: string): ImportedCustomTheme {
  return {
    ...createImportedCustomThemeFixture(),
    label,
    themeId,
    sourceUrl: `https://tweakcn.com/themes/${themeId}`,
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  importCustomThemeFromUrl.mockReset();
  vi.spyOn(customTheme, "importCustomThemeFromUrl").mockImplementation(importCustomThemeFromUrl);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ConfigPage custom theme import ownership", () => {
  it("keeps Replace then Clear authoritative when the replacement resolves late", async () => {
    const existingTheme = customThemeFixture("Existing", "existing");
    const replacement = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(replacement.promise);
    const { state } = createCustomThemePage({ theme: "custom", customTheme: existingTheme });
    state.setCustomThemeImportUrl("replacement");

    const pendingImport = state.importCustomTheme();
    state.clearCustomTheme();
    const clearMessage = state.customThemeImport.message;

    replacement.resolve(customThemeFixture("Replacement", "replacement"));
    await pendingImport;

    expect(state.customThemeImport.busy).toBe(false);
    expect(state.settings.theme).toBe("claw");
    expect(state.settings.customTheme).toBeUndefined();
    expect(state.customThemeImport.url).toBe("replacement");
    expect(state.customThemeImport.message).toBe(clearMessage);
  });

  it("lets a newer import own state when the stale import settles first", async () => {
    const first = deferred<ImportedCustomTheme>();
    const second = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { state } = createCustomThemePage();
    state.setCustomThemeImportUrl("first");

    const firstImport = state.importCustomTheme();
    state.setCustomThemeImportUrl("second");
    const secondImport = state.importCustomTheme();
    first.resolve(customThemeFixture("First", "first"));
    await firstImport;

    expect(state.customThemeImport.busy).toBe(true);
    expect(state.customThemeImport.url).toBe("second");
    expect(state.customThemeImport.message).toBeNull();
    expect(state.settings.customTheme).toBeUndefined();

    const secondTheme = customThemeFixture("Second", "second");
    second.resolve(secondTheme);
    await secondImport;

    expect(state.customThemeImport.busy).toBe(false);
    expect(state.customThemeImport.url).toBe("");
    expect(state.customThemeImport.message?.kind).toBe("success");
    expect(state.settings.theme).toBe("custom");
    expect(state.settings.customTheme).toBe(secondTheme);
  });

  it("preserves a newer server-applied theme when an older import settles", async () => {
    const pending = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(pending.promise);
    const { state } = createCustomThemePage();
    state.setCustomThemeImportUrl("first");
    const pendingImport = state.importCustomTheme();

    patchSettings({ theme: "knot" });
    state.adoptThemeSettings();
    pending.resolve(customThemeFixture("First", "first"));
    await pendingImport;

    expect(state.customThemeImport.busy).toBe(false);
    expect(state.customThemeImport.url).toBe("");
    expect(state.customThemeImport.message?.kind).toBe("success");
    expect(state.settings.theme).toBe("knot");
    expect(state.settings.customTheme?.themeId).toBe("first");
  });

  it("revokes activation when server intent changes but the local mirror is equal", async () => {
    const pending = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(pending.promise);
    const { gateway } = createApplicationGateway();
    patchSettings({ gatewayUrl: gateway.connection.gatewayUrl, theme: "claw" });
    const theme = createApplicationTheme(loadSettings(), gateway);
    const context: ApplicationContext = {
      ...completeConfigContext({
        gateway,
        runtimeConfig: {
          state: {
            connected: true,
            configSnapshot: { config: {}, valid: true, issues: [] },
          },
        },
      } as unknown as ApplicationContext),
      theme,
    };
    const provider = createSolidApplicationContextProvider(context);
    const view = mountSolid(
      () => createComponent(ConfigPage, { pageId: "appearance", routeData: null }),
      { wrapper: provider.wrapper },
    );
    try {
      flush();
      view.container.querySelector<HTMLButtonElement>(".settings-theme-card--custom")!.click();
      flush();
      const input = view.container.querySelector<HTMLInputElement>(
        "[data-custom-theme-import-input]",
      )!;
      input.scrollIntoView = vi.fn();
      input.value = "first";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
      view.container
        .querySelector<HTMLButtonElement>(".settings-theme-import__actions .primary")!
        .click();
      expect(importCustomThemeFromUrl).toHaveBeenCalledWith("first");

      theme.recordServerSelection("claw", gateway.connection.gatewayUrl);
      flush();
      pending.resolve(customThemeFixture("First", "first"));
      await waitForSolid(() =>
        expect(
          view.container.querySelector(".settings-theme-import__message--success"),
        ).toBeTruthy(),
      );

      expect(loadSettings().customTheme?.themeId).toBe("first");
      expect(loadSettings().theme).toBe("claw");
      expect(
        view.container.querySelector(".settings-theme-card--claw")?.getAttribute("aria-pressed"),
      ).toBe("true");
      expect(
        view.container.querySelector(".settings-theme-card--custom")?.getAttribute("aria-pressed"),
      ).toBe("false");
    } finally {
      view.unmount();
      theme.dispose();
    }
  });

  it("retires an import when navigation leaves Appearance", async () => {
    const pending = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(pending.promise);
    const { page, state } = createCustomThemePage();
    state.pageId = "appearance";
    state.setCustomThemeImportUrl("first");
    const pendingImport = state.importCustomTheme();

    page.updateRoute("security", null);
    pending.resolve(customThemeFixture("First", "first"));
    await pendingImport;

    expect(state.customThemeImport.busy).toBe(false);
    expect(state.customThemeImport.url).toBe("first");
    expect(state.customThemeImport.message).toBeNull();
    expect(state.settings.theme).toBe("claw");
    expect(state.settings.customTheme).toBeUndefined();
  });

  it("retires an import when the active Gateway scope changes", async () => {
    const pending = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(pending.promise);
    const { state } = createCustomThemePage();
    state.synchronizeCustomThemeGatewayScope("ws://gateway-a.test");
    state.setCustomThemeImportUrl("first");
    const pendingImport = state.importCustomTheme();

    state.synchronizeCustomThemeGatewayScope("ws://gateway-b.test");
    pending.resolve(customThemeFixture("First", "first"));
    await pendingImport;

    expect(state.customThemeImport.busy).toBe(false);
    expect(state.customThemeImport.url).toBe("first");
    expect(state.customThemeImport.message).toBeNull();
    expect(state.settings.theme).toBe("claw");
    expect(state.settings.customTheme).toBeUndefined();
  });

  it("preserves a built-in selection made after the first import starts", async () => {
    const first = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(first.promise);
    const { state } = createCustomThemePage();
    state.setCustomThemeImportUrl("first");

    const pendingImport = state.importCustomTheme();
    state.setTheme("knot");
    first.resolve(customThemeFixture("First", "first"));
    await pendingImport;

    expect(state.customThemeImport.busy).toBe(false);
    expect(state.customThemeImport.url).toBe("");
    expect(state.customThemeImport.message?.kind).toBe("success");
    expect(state.settings.theme).toBe("knot");
    expect(state.settings.customTheme?.themeId).toBe("first");
  });

  it("honors a newer server Custom selection after an intervening built-in selection", async () => {
    const pending = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(pending.promise);
    const { state } = createCustomThemePage();
    let serverSelection: ApplicationThemeServerSelection | null = {
      revision: 1,
      scope: "ws://gateway.test",
      theme: "claw",
    };
    state.context = {
      ...state.context,
      theme: {
        ...state.context.theme,
        get serverSelection() {
          return serverSelection;
        },
      },
    } as ApplicationContext;
    state.customThemeImportOwner.connect("ws://gateway.test", serverSelection);
    state.setCustomThemeImportUrl("first");
    const pendingImport = state.importCustomTheme();

    serverSelection = { revision: 2, scope: "ws://gateway.test", theme: "knot" };
    patchSettings({ theme: "knot" });
    state.adoptThemeSettings();
    serverSelection = { revision: 3, scope: "ws://gateway.test", theme: "custom" };
    state.adoptThemeSettings();
    pending.resolve(customThemeFixture("First", "first"));
    await pendingImport;

    expect(state.settings.theme).toBe("custom");
    expect(state.settings.customTheme?.themeId).toBe("first");
  });

  it("refuses to race an older pending full-config write", async () => {
    const { state } = createCustomThemePage();
    state.context = {
      ...state.context,
      runtimeConfig: {
        ...state.context.runtimeConfig,
        state: { ...state.context.runtimeConfig.state, configFormDirty: true },
      },
    } as ApplicationContext;
    state.setCustomThemeImportUrl("first");

    await state.importCustomTheme();

    expect(importCustomThemeFromUrl).not.toHaveBeenCalled();
    expect(state.customThemeImport.busy).toBe(false);
    expect(state.customThemeImport.message).toEqual({
      kind: "error",
      text: "You have unsaved changes",
    });
  });

  it("waits for the initial canonical config before importing", async () => {
    const { state } = createCustomThemePage();
    state.context = {
      ...state.context,
      runtimeConfig: {
        ...state.context.runtimeConfig,
        state: {
          ...state.context.runtimeConfig.state,
          configLoading: true,
          configSnapshot: null,
        },
      },
    } as ApplicationContext;
    state.setCustomThemeImportUrl("first");

    await state.importCustomTheme();

    expect(importCustomThemeFromUrl).not.toHaveBeenCalled();
    expect(state.customThemeImport.message).toEqual({ kind: "error", text: "Loading…" });
  });

  it("retires a pending import when a full-config edit begins", async () => {
    const pending = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(pending.promise);
    const { state } = createCustomThemePage();
    state.setCustomThemeImportUrl("first");
    const pendingImport = state.importCustomTheme();

    state.retireCustomThemeImportForConfigMutation();
    pending.resolve(customThemeFixture("First", "first"));
    await pendingImport;

    expect(state.settings.customTheme).toBeUndefined();
    expect(state.customThemeImport.message).toEqual({
      kind: "error",
      text: "You have unsaved changes",
    });
  });

  it("retires an import when the page disconnects", async () => {
    const first = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(first.promise);
    const { page, state } = createCustomThemePage();
    state.setCustomThemeImportUrl("first");
    const pendingImport = state.importCustomTheme();

    page.dispose();
    first.resolve(customThemeFixture("First", "first"));
    await pendingImport;

    expect(state.customThemeImport.busy).toBe(false);
    expect(state.customThemeImport.url).toBe("first");
    expect(state.customThemeImport.message).toBeNull();
    expect(state.settings.theme).toBe("claw");
    expect(state.settings.customTheme).toBeUndefined();
  });
});
