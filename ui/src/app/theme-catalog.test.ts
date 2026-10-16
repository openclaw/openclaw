import { expectDefined } from "@openclaw/normalization-core";
/* @vitest-environment jsdom */
import { createComponent } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ThemesGetResult,
  ThemesListResult,
} from "../../../packages/gateway-protocol/src/schema/themes.ts";
import type { UsersSelfResult } from "../../../packages/gateway-protocol/src/schema/users.ts";
import {
  BUILTIN_THEMES,
  resolveThemeBranding,
  type ThemeDefinition,
  type ThemeDescriptor,
} from "../../../packages/gateway-protocol/src/theme.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createThemeDefinitionFixture,
  createThemePaletteFixture,
} from "../../../test/helpers/theme-fixture.js";
import { AgentIdentityAvatar } from "../components/solid/identity-avatar.tsx";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { createApplicationTheme } from "./bootstrap-theme.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
} from "./gateway-store.test-support.ts";
import { loadSettings, patchSettings } from "./settings.ts";
import { currentThemeBranding, setCurrentThemeBranding } from "./theme-branding.ts";

const descriptor: ThemeDescriptor = {
  id: "space-pack/xenovessel",
  name: "Xenovessel",
  description: "Alien indigo surfaces with lime controls and monospace typography.",
  source: "plugin",
  modes: ["dark"],
  pluginId: "space-pack",
};
const definition = createThemeDefinitionFixture({
  name: descriptor.name,
  description: descriptor.description,
  dark: createThemePaletteFixture({ background: "#111122" }),
});

function paletteWithBackground(background: string) {
  return createThemeDefinitionFixture({ dark: createThemePaletteFixture({ background }) });
}
const waitForTheme = (id: string) => vi.waitFor(() => expect(themeId()).toBe(id));

function selfProfile(id: string): UsersSelfResult {
  return {
    profile: {
      id,
      displayName: null,
      emails: [],
      avatarMime: null,
      hasAvatar: false,
      githubIdentity: null,
      mergedInto: null,
      createdAt: 1,
      updatedAt: 2,
    },
  };
}

function catalog(themeDefinition = definition): ThemesListResult {
  return {
    themes: [...BUILTIN_THEMES, descriptor],
    theme: descriptor,
    definition: themeDefinition,
    current: {
      id: descriptor.id,
      mode: "system",
      scope: "profile",
      overrides: { id: descriptor.id },
    },
  };
}

function builtinCatalog(themes: readonly ThemeDescriptor[] = [descriptor]): ThemesListResult {
  return {
    themes: [...BUILTIN_THEMES, ...themes],
    theme: expectDefined(BUILTIN_THEMES[0], "default built-in theme"),
    current: { id: "claw", mode: "system", scope: "profile", overrides: {} },
  };
}

const cleanups: (() => void)[] = [];
const pluginRequests = {
  "plugins.uiDescriptors": async () => ({ ok: true, generation: 1, descriptors: [], methods: [] }),
};
function createThemeHarness(start = true) {
  const fixture = createGatewayStoreTestStore();
  const applicationTheme = createApplicationTheme(loadSettings(), fixture.gateway);
  if (start) {
    fixture.gateway.start();
  }
  cleanups.push(() => {
    applicationTheme.dispose();
    fixture.gateway.stop();
  });
  return {
    ...fixture,
    applicationTheme,
    hello: (user?: string, readOnly = false) =>
      fixture.current().opts.onHello?.({
        ...GATEWAY_STORE_TEST_HELLO,
        ...(readOnly ? { auth: { role: "operator", scopes: ["operator.read"] } } : {}),
        ...(user
          ? {
              snapshot: {
                presence: [{ instanceId: fixture.current().instanceId, user: { id: user } }],
              },
            }
          : {}),
      }),
    requests: (routes: Record<string, (params: unknown) => Promise<unknown>>) =>
      fixture.current().request.mockImplementation((method, params) => {
        if (!routes[method]) {
          return Promise.reject(new Error(`Unexpected request ${method}`));
        }
        return routes[method](params);
      }),
    changed: (generation: number) =>
      fixture.current().opts.onEvent?.(createGatewayEvent("plugins.changed", { generation })),
  };
}
function expectPalette(background: string) {
  expect(document.getElementById("openclaw-custom-theme")?.textContent).toContain(
    `--bg: ${background};`,
  );
}
const waitForPalette = (background: string) => vi.waitFor(() => expectPalette(background));
const themeId = () => document.documentElement.dataset.themeId;

beforeEach((testContext) => {
  const existingFontLinks = new Set(document.querySelectorAll('link[id^="openclaw-typeface-"]'));
  testContext.onTestFinished(() => {
    for (const link of document.querySelectorAll('link[id^="openclaw-typeface-"]')) {
      if (!existingFontLinks.has(link)) {
        link.remove();
      }
    }
  });
  localStorage.clear();
  sessionStorage.clear();
  patchSettings({ theme: descriptor.id, themeMode: "light" });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  localStorage.clear();
  document.getElementById("openclaw-custom-theme")?.remove();
  document.documentElement.removeAttribute("style");
  vi.unstubAllGlobals();
});

it("resolves built-in branding before the palette and catalog load", () => {
  const id = "knot";
  patchSettings({ theme: id });
  setCurrentThemeBranding(resolveThemeBranding({ mascot: "none", critters: [] }));
  const { applicationTheme: theme } = createThemeHarness(false);
  cleanups.push(() => document.getElementById(`openclaw-theme-palette-${id}`)?.remove());
  expect(theme.branding).toEqual({
    ...resolveThemeBranding(undefined),
    mascot: "claw",
    workingPhrases: undefined,
    critters: [],
    avatarHat: undefined,
  });
  expect(currentThemeBranding()).toEqual(theme.branding);
});

it("notifies leaf branding consumers when a newly selected built-in palette loads", async () => {
  const { current, applicationTheme: theme, hello } = createThemeHarness();
  const { container, unmount } = mountSolid(() =>
    createComponent(AgentIdentityAvatar, { agent: { id: "openclaw" } }),
  );
  const renderMark = vi.fn();
  const unsubscribe = theme.subscribe(renderMark);
  cleanups.push(() => {
    unsubscribe();
    unmount();
    document.getElementById("openclaw-theme-palette-knot")?.remove();
  });
  current().request.mockResolvedValue(
    catalog({ ...definition, mascot: "none", avatarHat: "fedora" }),
  );
  hello();
  await vi.dynamicImportSettled();
  flush();
  expect(container.querySelector(".identity-avatar--neutral")).not.toBeNull();
  renderMark.mockClear();
  patchSettings({ theme: "knot" });
  flush();
  expect(theme.settings.theme).toBe("knot");
  expect(renderMark).toHaveBeenCalledTimes(1);
  expect(container.querySelector("img")?.getAttribute("src")).toBe("/favicon.svg");
  const palette = document.getElementById("openclaw-theme-palette-knot")!;
  expect(themeId()).toBe(descriptor.id);
  palette.dispatchEvent(new Event("load"));
  flush();
  expect(renderMark).toHaveBeenCalledTimes(2);
  expect(themeId()).toBe("knot");
  expect(document.documentElement.dataset.themeAvatarHat).toBeUndefined();
  expect(container.querySelector("img")?.getAttribute("src")).toBe("/favicon.svg");
});

it("applies routed profile updates and plugin hot reloads, restoring an unavailable selection", async () => {
  const { current, clients, applicationTheme, hello, requests, changed } = createThemeHarness();
  const favicon = document.createElement("link");
  favicon.rel = "icon";
  favicon.type = "image/svg+xml";
  favicon.setAttribute("href", "/favicon.svg");
  document.head.append(favicon);
  cleanups.push(() => favicon.remove());
  let response = catalog();
  requests({ ...pluginRequests, "themes.list": async () => response });
  hello("profile-alias");
  await waitForTheme(descriptor.id);
  expect(document.documentElement.dataset.themeMode).toBe("dark");
  expectPalette("#111122");
  expect(applicationTheme.catalog?.themes).toContainEqual(descriptor);
  expect(applicationTheme.branding.mascot).toBe("claw");

  const preferences = {
    mascot: "none",
    workingPhrases: ["Building", "Compiling"],
    critters: ["penguin", "fedora"],
    avatarHat: "fedora",
  } satisfies Partial<ThemeDefinition>;
  response = catalog({ ...paletteWithBackground("#221133"), ...preferences });
  current().opts.onEvent?.(
    createGatewayEvent("users.prefs.changed", {
      profileId: "canonical-profile",
      keys: ["ui.theme"],
    }),
  );
  await waitForPalette("#221133");
  expect(applicationTheme.branding).toEqual({
    ...resolveThemeBranding({ mascot: "none" }),
    ...preferences,
  });
  expect(document.documentElement.dataset).toMatchObject({
    themeMascot: "none",
    themeAvatarHat: "fedora",
  });
  await vi.dynamicImportSettled();
  expect(decodeURIComponent(favicon.href)).toContain("<rect");

  const artUrl = (asset: string) => ({
    url: `/__openclaw__/plugin-theme-art/space-pack/xenovessel/${asset}?v=1`,
  });
  const artwork = {
    icons: { compass: artUrl("icon/compass") },
    hats: { beret: artUrl("hat/beret") },
    critters: { ferris: { ...artUrl("critter/ferris"), crossMs: 5000 } },
  };
  const brand = {
    brandName: "Northstar",
    brandIcon: "compass",
    workingIndicator: "brand",
    lobsterdex: false,
    communityLinks: false,
  } as const;
  response = catalog({
    ...paletteWithBackground("#332244"),
    ...brand,
    mascot: "none",
    avatarHat: "beret",
    critters: ["ferris"],
    workingPhrases: [],
  });
  response.theme = { ...descriptor, artwork };
  changed(1);
  await waitForPalette("#332244");
  expect([applicationTheme.branding.artwork, currentThemeBranding().artwork]).toEqual([
    artwork,
    artwork,
  ]);
  expect(applicationTheme.branding).toMatchObject(brand);
  expect(currentThemeBranding()).toMatchObject({
    avatarHat: "beret",
    critters: ["ferris"],
  });

  response = {
    ...builtinCatalog([]),
    current: { ...response.current, id: "claw", requestedId: descriptor.id },
  };
  changed(2);
  await waitForTheme("claw");
  expect(applicationTheme.settings.theme).toBe(descriptor.id);
  expect(applicationTheme.catalog?.unavailableId).toBe(descriptor.id);
  expect(applicationTheme.branding.mascot).toBe("claw");
  expect(document.documentElement.dataset.themeMascot).toBe("claw");
  expect(document.documentElement.dataset.themeAvatarHat).toBeUndefined();
  await vi.dynamicImportSettled();
  expect(favicon.getAttribute("href")).toBe("/favicon.svg");

  response = catalog();
  changed(3);
  await waitForTheme(descriptor.id);
  expect(clients).toHaveLength(1);
  expect(current().stopped).toBe(0);
});

it("retries a failed selected palette only after an explicit catalog retry", async () => {
  const { applicationTheme, requests, hello } = createThemeHarness();
  const get = vi
    .fn(async () => catalog())
    .mockRejectedValueOnce(new Error("Theme palette temporarily unavailable"));
  requests({ "themes.list": async () => builtinCatalog(), "themes.get": get });
  hello();
  await vi.waitFor(() =>
    expect(applicationTheme.catalog?.error).toBe("Theme palette temporarily unavailable"),
  );
  expect(themeId()).toBe("claw");
  patchSettings({ textScale: 110 });
  expect(applicationTheme.resolvedMode).toBe("light");
  expect(get).toHaveBeenCalledTimes(1);

  expectDefined(applicationTheme.retryCatalog, "theme catalog retry")();
  await waitForTheme(descriptor.id);
  expect(applicationTheme.catalog?.error).toBeNull();
  expectPalette("#111122");
  expect(get).toHaveBeenCalledTimes(2);
});

it("does not report a previous palette failure after a local theme switch", async () => {
  const replacement: ThemeDescriptor = {
    ...descriptor,
    id: "space-pack/afterglow",
    name: "Afterglow",
  };
  const replacementDefinition = {
    ...paletteWithBackground("#332211"),
    name: replacement.name,
    description: replacement.description,
  };
  const selected = builtinCatalog([descriptor, replacement]);
  const retired = createDeferred<ThemesGetResult>();
  const { current, applicationTheme, hello, requests } = createThemeHarness();
  const get = vi
    .fn(async (_params: unknown): Promise<ThemesGetResult> => ({
      current: selected.current,
      theme: replacement,
      definition: replacementDefinition,
    }))
    .mockReturnValueOnce(retired.promise);
  requests({ "themes.list": async () => selected, "themes.get": get });
  hello("read-only", true);
  await vi.waitFor(() =>
    expect(current().request).toHaveBeenCalledWith("themes.get", { id: descriptor.id }),
  );
  patchSettings({ theme: replacement.id });
  await waitForTheme(replacement.id);
  expect(applicationTheme.settings.theme).toBe(replacement.id);
  expectPalette("#332211");

  retired.reject(new Error("Previous palette is unavailable"));
  await retired.promise.catch(() => undefined);
  expect(themeId()).toBe(replacement.id);
  expect(applicationTheme.catalog?.error).toBeNull();
  expect(get.mock.calls).toEqual([[{ id: descriptor.id }], [{ id: replacement.id }]]);
});

it("keeps a local palette selected during catalog refresh and reloads later versions", async () => {
  patchSettings({ theme: "claw" });
  const response = builtinCatalog();
  const refreshing = createDeferred<ThemesListResult>();
  const delayed = createDeferred<ThemesGetResult>();
  const failed = createDeferred<ThemesGetResult>();
  const { applicationTheme, hello, requests, changed } = createThemeHarness();
  const result = (background: string) => ({
    ...catalog(paletteWithBackground(background)),
    current: response.current,
  });
  const list = vi
    .fn(async () => response)
    .mockResolvedValueOnce(response)
    .mockReturnValueOnce(refreshing.promise);
  const get = vi
    .fn(async () => result("#553355"))
    .mockResolvedValueOnce(result("#111122"))
    .mockReturnValueOnce(delayed.promise)
    .mockReturnValueOnce(failed.promise);
  requests({ ...pluginRequests, "themes.list": list, "themes.get": get });
  hello();
  await vi.waitFor(() => expect(applicationTheme.catalog?.themes).toContainEqual(descriptor));
  changed(1);
  await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  patchSettings({ theme: descriptor.id });
  await waitForTheme(descriptor.id);

  refreshing.resolve(response);
  await refreshing.promise;
  await waitForTheme(descriptor.id);
  expect(applicationTheme.settings.theme).toBe(descriptor.id);

  changed(2);
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  expect(themeId()).toBe(descriptor.id);
  expectPalette("#111122");
  delayed.resolve(result("#442244"));
  await delayed.promise;
  await waitForPalette("#442244");

  changed(3);
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(3));
  failed.reject(new Error("Palette refresh temporarily failed"));
  await failed.promise.catch(() => undefined);
  expect(themeId()).toBe(descriptor.id);
  expectPalette("#442244");
  expect(applicationTheme.catalog?.error).toBe("Palette refresh temporarily failed");
  patchSettings({ textScale: 110 });
  expect(get).toHaveBeenCalledTimes(3);

  expectDefined(applicationTheme.retryCatalog, "theme catalog retry")();
  await waitForPalette("#553355");
  expect(applicationTheme.catalog?.error).toBeNull();
});

it.each([
  { boundary: "profile", pending: "catalog" },
  { boundary: "profile", pending: "palette" },
  { boundary: "client", pending: "palette" },
] as const)(
  "discards a late $pending after the requesting $boundary changes",
  async ({ boundary, pending }) => {
    const personal: ThemeDescriptor = {
      id: "user/personal",
      name: "Personal",
      description: "A profile-owned palette.",
      source: "user",
      modes: ["dark"],
    };
    const palette = pending === "palette";
    if (palette) {
      patchSettings({ theme: personal.id });
    }
    const response = builtinCatalog([personal]);
    const retired = createDeferred<ThemesGetResult | ThemesListResult>();
    const { gateway, current, applicationTheme, hello } = createThemeHarness();
    current().request.mockImplementation((method) =>
      method === "users.self"
        ? Promise.resolve(selfProfile("first"))
        : !palette || method === "themes.get"
          ? retired.promise
          : Promise.resolve(response),
    );
    hello("first", true);
    await vi.waitFor(() =>
      expect(current().request).toHaveBeenCalledWith(
        palette ? "themes.get" : "themes.list",
        palette ? { id: personal.id } : {},
      ),
    );
    if (boundary === "client") {
      gateway.connect();
    }
    const nextCatalog: ThemesListResult = palette
      ? {
          ...response,
          theme: personal,
          definition: paletteWithBackground("#443355"),
          current: { ...response.current, id: personal.id },
        }
      : builtinCatalog([]);
    current().request.mockImplementation(async (method) =>
      method === "users.self"
        ? selfProfile(boundary === "profile" ? "second" : "first")
        : nextCatalog,
    );
    if (boundary === "profile") {
      current().opts.onEvent?.(
        createGatewayEvent("sessions.changed", { reason: "profile-identity" }),
      );
    } else {
      hello("first", true);
    }
    if (palette) {
      await waitForPalette("#443355");
    } else {
      await vi.waitFor(() => expect(applicationTheme.catalog?.themes).toEqual(BUILTIN_THEMES));
    }
    retired.resolve(palette ? { ...response, theme: personal, definition } : catalog());
    await retired.promise;
    if (palette) {
      expectPalette("#443355");
      expect(applicationTheme.catalog?.error).toBeNull();
    } else {
      expect(themeId()).toBe("claw");
      expect(applicationTheme.catalog?.themes.some((theme) => theme.id === descriptor.id)).toBe(
        false,
      );
    }
  },
);

it.each(["Appearance discovery", "profile selection"] as const)(
  "leaves built-in presentation quiet until %s needs the catalog",
  async (trigger) => {
    patchSettings({ theme: "claw" });
    const { current, applicationTheme, hello } = createThemeHarness();
    const published = vi.fn();
    const unsubscribe = applicationTheme.subscribe(published);
    cleanups.push(unsubscribe);
    current().request.mockResolvedValue(catalog());
    hello();
    await vi.dynamicImportSettled();
    expect(current().request).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
    expect(themeId()).toBe("claw");

    if (trigger === "Appearance discovery") {
      expect(applicationTheme.catalog).toBeUndefined();
      expect(applicationTheme.catalog).toBeUndefined();
    } else {
      patchSettings({ theme: descriptor.id });
    }
    await vi.waitFor(() =>
      expect(current().request).toHaveBeenCalledExactlyOnceWith("themes.list", {}),
    );
    if (trigger === "profile selection") {
      await waitForTheme(descriptor.id);
    }
    await vi.waitFor(() => expect(applicationTheme.catalog?.themes).toContainEqual(descriptor));
    expect(current().request).toHaveBeenCalledOnce();
  },
);
