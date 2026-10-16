/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  const context = {
    gateway: {
      connection: { gatewayUrl: "ws://gateway.test" },
      snapshot: { phase: "connected", selfUser: null },
    },
    runtimeConfig: {
      state: {
        configAutoSaveStatus: "idle",
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

function customThemeFixture(themeId: string): ImportedCustomTheme {
  return {
    ...createImportedCustomThemeFixture(),
    label: themeId,
    themeId,
    sourceUrl: `https://tweakcn.com/themes/${themeId}`,
  };
}

function startImport(settings: Partial<UiSettings> = {}, url = "first") {
  const pending = deferred<ImportedCustomTheme>();
  importCustomThemeFromUrl.mockReturnValueOnce(pending.promise);
  const view = createCustomThemePage(settings);
  view.props().onCustomThemeImportUrlChange(url);
  view.props().onImportCustomTheme();
  return {
    ...view,
    async finish(this: void, theme = customThemeFixture("first")) {
      pending.resolve(theme);
      await pending.promise;
      flush();
    },
  };
}

function expectNoTheme() {
  expect([loadSettings().theme, loadSettings().customTheme]).toEqual(["claw", undefined]);
}

function importState(props: ReturnType<typeof createCustomThemePage>["props"]) {
  const state = props();
  return [state.customThemeImportBusy, state.customThemeImportUrl, state.customThemeImportMessage];
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

it("keeps Replace then Clear authoritative when the replacement resolves late", async () => {
  const { props, finish } = startImport(
    { theme: "custom", customTheme: customThemeFixture("existing") },
    "replacement",
  );
  props().onClearCustomTheme();
  flush();
  const clearMessage = props().customThemeImportMessage;

  await finish(customThemeFixture("replacement"));
  expect(props()).toMatchObject({
    customThemeImportBusy: false,
    customThemeImportUrl: "replacement",
  });
  expect(props().customThemeImportMessage).toBe(clearMessage);
  expectNoTheme();
});

it("lets a newer import own state when the stale import settles first", async () => {
  const { props, finish } = startImport();
  const second = deferred<ImportedCustomTheme>();
  importCustomThemeFromUrl.mockReturnValueOnce(second.promise);
  props().onCustomThemeImportUrlChange("second");
  props().onImportCustomTheme();
  await finish();

  expect(importState(props)).toEqual([true, "second", null]);
  expect(loadSettings().customTheme).toBeUndefined();

  const secondTheme = customThemeFixture("second");
  second.resolve(secondTheme);
  await second.promise;
  flush();

  expect(importState(props)).toMatchObject([false, "", { kind: "success" }]);
  expect([loadSettings().theme, loadSettings().customTheme]).toEqual(["custom", secondTheme]);
});

it.each(["navigation", "Gateway scope"])("retires an import on %s change", async (change) => {
  const { page, context, props, finish } = startImport();
  if (change === "navigation") {
    page.update({ pageId: "security" });
  } else {
    context.gateway.connection.gatewayUrl = "ws://gateway-b.test";
    Object.assign(context.gateway.snapshot, { phase: "connecting" });
    publishConfigSource(context.gateway);
  }
  await finish();
  expect(importState(props)).toEqual([false, "first", null]);
  expectNoTheme();
});

it("preserves a built-in selection made after the first import starts", async () => {
  const { props, finish } = startImport();
  props().setTheme("knot");
  await finish();

  expect(importState(props)).toMatchObject([false, "", { kind: "success" }]);
  expect(loadSettings()).toMatchObject({ theme: "knot", customTheme: { themeId: "first" } });
});

it.each([
  { state: { configFormDirty: true }, text: "You have unsaved changes" },
  { state: { configLoading: true, configSnapshot: null }, text: "Loading…" },
])("defers imports while config is blocked: $text", ({ state, text }) => {
  const { context, props } = createCustomThemePage();
  Object.assign(context.runtimeConfig.state, state);
  publishConfigSource(context.runtimeConfig);
  props().onCustomThemeImportUrlChange("first");
  props().onImportCustomTheme();
  flush();
  expect(importCustomThemeFromUrl).not.toHaveBeenCalled();
  expect(props().customThemeImportBusy).toBe(false);
  expect(props().customThemeImportMessage).toEqual({ kind: "error", text });
});

it("retires a pending import when a full-config edit begins", async () => {
  const { props, finish } = startImport();
  props().onFormPatch(["gateway", "port"], 18800);
  await finish();

  expect(loadSettings().customTheme).toBeUndefined();
  expect(props().customThemeImportMessage).toEqual({
    kind: "error",
    text: "You have unsaved changes",
  });
});

it("retires an import when the page disconnects", async () => {
  const { page, finish } = startImport();
  page.dispose();
  await finish();
  expectNoTheme();
});
