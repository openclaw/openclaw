/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import type { ImportedCustomTheme } from "../../app/custom-theme.ts";
import { loadSettings, patchSettings, type UiSettings } from "../../app/settings.ts";
import { createImportedCustomThemeFixture } from "../../test-helpers/custom-theme.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { mountConfigPageState, publishConfigSource } from "./config-page.test-support.ts";
import * as customTheme from "./custom-theme-import.ts";

const importCustomThemeFromUrl = vi.fn<typeof customTheme.importCustomThemeFromUrl>();

function createCustomThemePage(settings: Partial<UiSettings> = {}) {
  patchSettings(settings);
  // SAFETY: completeConfigContext fills the unused capabilities for this focused page fixture.
  const context = {
    gateway: {
      connection: { gatewayUrl: "ws://gateway.test" },
      snapshot: { phase: "connected", selfUser: null },
    },
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
      patchForm: vi.fn(),
    },
    theme: { recordServerSelection: vi.fn(), refresh: vi.fn(), serverSelection: null },
  } as unknown as ApplicationContext;
  const page = mountConfigPageState(context, { pageId: "appearance" });
  return { page, context, props: page.state.configProps };
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
  cleanupSolid();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ConfigPage custom theme import ownership", () => {
  it("keeps Replace then Clear authoritative when the replacement resolves late", async () => {
    const existingTheme = customThemeFixture("Existing", "existing");
    const replacement = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(replacement.promise);
    const { props } = createCustomThemePage({ theme: "custom", customTheme: existingTheme });
    props().onCustomThemeImportUrlChange("replacement");

    props().onImportCustomTheme();
    props().onClearCustomTheme();
    flush();
    const clearMessage = props().customThemeImportMessage;

    replacement.resolve(customThemeFixture("Replacement", "replacement"));
    await replacement.promise;
    flush();

    expect(props().customThemeImportBusy).toBe(false);
    expect(loadSettings().theme).toBe("claw");
    expect(loadSettings().customTheme).toBeUndefined();
    expect(props().customThemeImportUrl).toBe("replacement");
    expect(props().customThemeImportMessage).toBe(clearMessage);
  });

  it("lets a newer import own state when the stale import settles first", async () => {
    const first = deferred<ImportedCustomTheme>();
    const second = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { props } = createCustomThemePage();
    props().onCustomThemeImportUrlChange("first");

    props().onImportCustomTheme();
    props().onCustomThemeImportUrlChange("second");
    props().onImportCustomTheme();
    first.resolve(customThemeFixture("First", "first"));
    await first.promise;
    flush();

    expect(props().customThemeImportBusy).toBe(true);
    expect(props().customThemeImportUrl).toBe("second");
    expect(props().customThemeImportMessage).toBeNull();
    expect(loadSettings().customTheme).toBeUndefined();

    const secondTheme = customThemeFixture("Second", "second");
    second.resolve(secondTheme);
    await second.promise;
    flush();

    expect(props().customThemeImportBusy).toBe(false);
    expect(props().customThemeImportUrl).toBe("");
    expect(props().customThemeImportMessage?.kind).toBe("success");
    expect(loadSettings().theme).toBe("custom");
    expect(loadSettings().customTheme).toEqual(secondTheme);
  });

  it("retires an import when navigation leaves Appearance", async () => {
    const pending = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(pending.promise);
    const { page, props } = createCustomThemePage();
    props().onCustomThemeImportUrlChange("first");
    props().onImportCustomTheme();

    page.update({ pageId: "security" });
    pending.resolve(customThemeFixture("First", "first"));
    await pending.promise;
    flush();

    expect(props().customThemeImportBusy).toBe(false);
    expect(props().customThemeImportUrl).toBe("first");
    expect(props().customThemeImportMessage).toBeNull();
    expect(loadSettings().theme).toBe("claw");
    expect(loadSettings().customTheme).toBeUndefined();
  });

  it("retires an import when the active Gateway scope changes", async () => {
    const pending = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(pending.promise);
    const { context, props } = createCustomThemePage();
    props().onCustomThemeImportUrlChange("first");
    props().onImportCustomTheme();

    context.gateway.connection.gatewayUrl = "ws://gateway-b.test";
    Object.assign(context.gateway.snapshot, { phase: "connecting" });
    publishConfigSource(context.gateway);
    pending.resolve(customThemeFixture("First", "first"));
    await pending.promise;
    flush();

    expect(props().customThemeImportBusy).toBe(false);
    expect(props().customThemeImportUrl).toBe("first");
    expect(props().customThemeImportMessage).toBeNull();
    expect(loadSettings().theme).toBe("claw");
    expect(loadSettings().customTheme).toBeUndefined();
  });

  it("preserves a built-in selection made after the first import starts", async () => {
    const first = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(first.promise);
    const { props } = createCustomThemePage();
    props().onCustomThemeImportUrlChange("first");

    props().onImportCustomTheme();
    props().setTheme("knot");
    first.resolve(customThemeFixture("First", "first"));
    await first.promise;
    flush();

    expect(props().customThemeImportBusy).toBe(false);
    expect(props().customThemeImportUrl).toBe("");
    expect(props().customThemeImportMessage?.kind).toBe("success");
    expect(loadSettings().theme).toBe("knot");
    expect(loadSettings().customTheme?.themeId).toBe("first");
  });

  it("refuses to race an older pending full-config write", () => {
    const { context, props } = createCustomThemePage();
    context.runtimeConfig.state.configFormDirty = true;
    publishConfigSource(context.runtimeConfig);
    props().onCustomThemeImportUrlChange("first");

    props().onImportCustomTheme();
    flush();

    expect(importCustomThemeFromUrl).not.toHaveBeenCalled();
    expect(props().customThemeImportBusy).toBe(false);
    expect(props().customThemeImportMessage).toEqual({
      kind: "error",
      text: "You have unsaved changes",
    });
  });

  it("waits for the initial canonical config before importing", () => {
    const { context, props } = createCustomThemePage();
    context.runtimeConfig.state.configLoading = true;
    context.runtimeConfig.state.configSnapshot = null;
    publishConfigSource(context.runtimeConfig);
    props().onCustomThemeImportUrlChange("first");

    props().onImportCustomTheme();
    flush();

    expect(importCustomThemeFromUrl).not.toHaveBeenCalled();
    expect(props().customThemeImportMessage).toEqual({ kind: "error", text: "Loading…" });
  });

  it("retires a pending import when a full-config edit begins", async () => {
    const pending = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(pending.promise);
    const { props } = createCustomThemePage();
    props().onCustomThemeImportUrlChange("first");
    props().onImportCustomTheme();

    props().onFormPatch(["gateway", "port"], 18800);
    pending.resolve(customThemeFixture("First", "first"));
    await pending.promise;
    flush();

    expect(loadSettings().customTheme).toBeUndefined();
    expect(props().customThemeImportMessage).toEqual({
      kind: "error",
      text: "You have unsaved changes",
    });
  });

  it("retires an import when the page disconnects", async () => {
    const first = deferred<ImportedCustomTheme>();
    importCustomThemeFromUrl.mockReturnValueOnce(first.promise);
    const { page, props } = createCustomThemePage();
    props().onCustomThemeImportUrlChange("first");
    props().onImportCustomTheme();

    page.dispose();
    first.resolve(customThemeFixture("First", "first"));
    await first.promise;
    flush();

    expect(loadSettings().theme).toBe("claw");
    expect(loadSettings().customTheme).toBeUndefined();
  });
});
