/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import type { ImportedCustomTheme } from "../../app/custom-theme.ts";
import { loadSettings, patchSettings, type UiSettings } from "../../app/settings.ts";
import { createImportedCustomThemeFixture } from "../../test-helpers/custom-theme.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  mountConfigPage,
  mountConfigPageState,
  publishConfigSource,
} from "./config-page.test-support.ts";
import * as customTheme from "./custom-theme-import.ts";

const importCustomThemeFromUrl = vi.fn<typeof customTheme.importCustomThemeFromUrl>();

function customThemeContext(profile?: { request: ReturnType<typeof vi.fn> }) {
  return {
    gateway: {
      connection: { gatewayUrl: "ws://gateway.test" },
      snapshot: profile
        ? {
            phase: "connected",
            client: profile,
            selfUser: { id: "profile-a" },
            hello: { auth: { role: "operator", scopes: ["operator.write"] } },
          }
        : { phase: "connected", selfUser: null },
    },
    runtimeConfig: {
      state: {
        configAutoSaveStatus: "idle",
        configSnapshot: { config: {}, valid: true, issues: [] },
        connected: true,
      },
      patchForm: vi.fn(),
    },
    theme: { recordServerSelection: vi.fn(), refresh: vi.fn(), rememberTheme: vi.fn() },
  } as unknown as ApplicationContext;
}

function createCustomThemePage(
  settings: Partial<UiSettings> = {},
  profile?: Parameters<typeof customThemeContext>[0],
) {
  patchSettings(settings);
  const context = customThemeContext(profile);
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
  const completion = view.props().onImportCustomTheme();
  return {
    ...view,
    async finish(this: void, theme = customThemeFixture("first")) {
      pending.resolve(theme);
      await completion;
      flush();
    },
  };
}

function expectNoTheme() {
  expect([loadSettings().theme, loadSettings().customTheme]).toEqual(["claw", undefined]);
}

function importState(props: ReturnType<typeof createCustomThemePage>["props"]) {
  const state = props();
  return [state.customThemeImportUrl, state.customThemeImportMessage];
}

function mountCustomThemeImporter() {
  patchSettings({ theme: "claw", customTheme: undefined });
  const { container } = mountConfigPage(customThemeContext(), { pageId: "appearance" });
  container.querySelector<HTMLButtonElement>('[data-theme-id="custom"]')!.click();
  flush();
  const input = container.querySelector<HTMLInputElement>("[data-custom-theme-import-input]")!;
  const submit = container.querySelector<HTMLButtonElement>(
    ".settings-theme-import__field .primary",
  )!;
  const start = async (url: string) => {
    input.value = url;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    await waitForSolid(() => expect(submit.disabled).toBe(false));
    submit.click();
    flush();
  };
  return { container, input, submit, start };
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
  await waitForSolid(() => expect(props().customThemeImportMessage?.kind).toBe("success"));
  const clearMessage = props().customThemeImportMessage;

  await finish(customThemeFixture("replacement"));
  expect(props()).toMatchObject({
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
  const completion = props().onImportCustomTheme();
  await finish();

  expect(importState(props)).toEqual(["second", null]);
  expect(loadSettings().customTheme).toBeUndefined();

  const secondTheme = customThemeFixture("second");
  second.resolve(secondTheme);
  await completion;
  flush();

  expect(importState(props)).toMatchObject(["", { kind: "success" }]);
  expect([loadSettings().theme, loadSettings().customTheme]).toEqual(["custom", secondTheme]);
});

it("keeps the rendered import pending across a retired request and later imports", async () => {
  patchSettings({ theme: "claw", customTheme: undefined });
  const first = deferred<ImportedCustomTheme>();
  const second = deferred<ImportedCustomTheme>();
  const third = deferred<ImportedCustomTheme>();
  importCustomThemeFromUrl
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(third.promise);
  const { submit, start } = mountCustomThemeImporter();
  try {
    await start("first");
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain("Importing");
    await start("second");
    second.resolve(customThemeFixture("second"));
    await waitForSolid(() => expect(submit.textContent).not.toContain("Importing"));
    await start("third");
    expect(importCustomThemeFromUrl).toHaveBeenCalledTimes(3);
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain("Importing");
    third.resolve(customThemeFixture("third"));
    await waitForSolid(() => expect(submit.textContent).not.toContain("Importing"));
    expect(loadSettings().customTheme?.themeId).toBe("third");
  } finally {
    first.resolve(customThemeFixture("first"));
    second.resolve(customThemeFixture("second"));
    third.resolve(customThemeFixture("third"));
    await Promise.all([first.promise, second.promise, third.promise]);
    flush();
  }
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
  expect(importState(props)).toEqual(["first", null]);
  expectNoTheme();
});

it.each([
  { state: { configFormDirty: true }, text: "You have unsaved changes" },
  { state: { configLoading: true, configSnapshot: null }, text: "Loading…" },
])("defers imports while config is blocked: $text", ({ state, text }) => {
  const { context, props } = createCustomThemePage();
  Object.assign(context.runtimeConfig.state, state);
  publishConfigSource(context.runtimeConfig);
  props().onCustomThemeImportUrlChange("first");
  void props().onImportCustomTheme();
  flush();
  expect(importCustomThemeFromUrl).not.toHaveBeenCalled();
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

it("saves a signed-in import as a personal theme instead of browser storage", async () => {
  const saved = { application: "saved", theme: { id: "user/tweakcn-amethyst-haze" } };
  const request = vi.fn(async () => saved);
  importCustomThemeFromUrl.mockResolvedValueOnce(customThemeFixture("Amethyst-Haze"));
  const { props, context } = createCustomThemePage(
    { theme: "claw", customTheme: undefined },
    { request },
  );
  props().onCustomThemeImportUrlChange("amethyst-haze");
  await props().onImportCustomTheme();
  flush();

  expect(request).toHaveBeenCalledWith("themes.import", {
    id: "tweakcn-amethyst-haze",
    definition: expect.objectContaining({
      name: "Amethyst-Haze",
      description: "https://tweakcn.com/themes/Amethyst-Haze",
    }),
  });
  // The saved palette reaches the theme owner before selection, so Claw never flashes.
  expect(context.theme.rememberTheme).toHaveBeenCalledWith(saved);
  expect(props().customThemeImportMessage).toEqual({
    kind: "success",
    text: "Imported Amethyst-Haze.",
  });
  // A fresh settings read holds only the profile selection, never the palette.
  expect([loadSettings().theme, loadSettings().customTheme]).toEqual([
    "user/tweakcn-amethyst-haze",
    undefined,
  ]);
});

it("retires an import when the page disconnects", async () => {
  const { page, finish } = startImport();
  page.dispose();
  await finish();
  expectNoTheme();
});
