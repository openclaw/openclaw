/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ThemesGetResult,
  ThemesListResult,
} from "../../../packages/gateway-protocol/src/schema/themes.ts";
import {
  BUILTIN_THEMES,
  type ThemeDescriptor,
} from "../../../packages/gateway-protocol/src/theme.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createThemeDefinitionFixture,
  createThemePaletteFixture,
} from "../../../test/helpers/theme-fixture.js";
import { renderAgentIdentityAvatar } from "../components/identity-avatar-view.ts";
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
  localStorage.clear();
  document.getElementById("openclaw-custom-theme")?.remove();
  document.documentElement.removeAttribute("style");
  vi.unstubAllGlobals();
});

it.each(["claw", "knot"] as const)(
  "resolves %s branding before the palette and catalog load",
  (id) => {
    patchSettings({ theme: id });
    setCurrentThemeBranding({ mascot: "none", critters: [] });
    const { gateway } = createGatewayStoreTestStore();
    const theme = createApplicationTheme(loadSettings(), gateway);
    try {
      expect(theme.branding).toEqual({
        mascot: "claw",
        workingPhrases: undefined,
        critters: [],
        avatarHat: undefined,
      });
      expect(currentThemeBranding()).toEqual(theme.branding);
    } finally {
      theme.dispose();
      document.getElementById(`openclaw-theme-palette-${id}`)?.remove();
    }
  },
);

it("notifies leaf branding consumers when a newly selected built-in palette loads", async () => {
  const { gateway, current } = createGatewayStoreTestStore();
  const theme = createApplicationTheme(loadSettings(), gateway);
  const container = document.createElement("div");
  const renderMark = vi.fn(() => render(renderAgentIdentityAvatar({ id: "openclaw" }), container));
  const unsubscribe = theme.subscribe(renderMark);
  gateway.start();
  current().request.mockResolvedValue(
    catalog({ ...definition, mascot: "none", avatarHat: "fedora" }),
  );
  current().opts.onHello?.(GATEWAY_STORE_TEST_HELLO);
  try {
    await vi.dynamicImportSettled();
    expect(container.querySelector(".identity-avatar--neutral")).not.toBeNull();
    renderMark.mockClear();
    patchSettings({ theme: "knot" });
    expect(theme.settings.theme).toBe("knot");
    expect(renderMark).toHaveBeenCalledTimes(1);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/favicon.svg");
    const palette = document.getElementById("openclaw-theme-palette-knot")!;
    expect(document.documentElement.dataset.themeId).toBe(descriptor.id);
    palette.dispatchEvent(new Event("load"));
    expect(renderMark).toHaveBeenCalledTimes(2);
    expect(document.documentElement.dataset.themeId).toBe("knot");
    expect(document.documentElement.dataset.themeAvatarHat).toBeUndefined();
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/favicon.svg");
  } finally {
    unsubscribe();
    theme.dispose();
    gateway.stop();
    render(nothing, container);
    document.getElementById("openclaw-theme-palette-knot")?.remove();
  }
});

it("applies routed profile updates and plugin hot reloads, restoring an unavailable selection", async () => {
  const { gateway, current, clients } = createGatewayStoreTestStore();
  const favicon = document.createElement("link");
  favicon.rel = "icon";
  favicon.type = "image/svg+xml";
  favicon.setAttribute("href", "/favicon.svg");
  document.head.append(favicon);
  const applicationTheme = createApplicationTheme(loadSettings(), gateway);
  gateway.start();
  let response = catalog();
  current().request.mockImplementation(async (method) => {
    if (method === "themes.list") {
      return response;
    }
    if (method === "plugins.uiDescriptors") {
      return { ok: true, generation: 1, descriptors: [], methods: [] };
    }
    throw new Error(`Unexpected request ${method}`);
  });
  current().opts.onHello?.({
    ...GATEWAY_STORE_TEST_HELLO,
    snapshot: { presence: [{ instanceId: current().instanceId, user: { id: "profile-alias" } }] },
  });
  try {
    await vi.waitFor(() => expect(document.documentElement.dataset.themeId).toBe(descriptor.id));
    expect(document.documentElement.dataset.themeMode).toBe("dark");
    expect(document.getElementById("openclaw-custom-theme")?.textContent).toContain(
      "--bg: #111122;",
    );
    expect(applicationTheme.catalog?.themes).toContainEqual(descriptor);
    expect(applicationTheme.branding.mascot).toBe("claw");

    response = catalog({
      ...definition,
      mascot: "none",
      workingPhrases: ["Building", "Compiling"],
      critters: ["penguin", "fedora"],
      avatarHat: "fedora",
      dark: createThemePaletteFixture({ background: "#221133" }),
    });
    current().opts.onEvent?.(
      createGatewayEvent("users.prefs.changed", {
        profileId: "canonical-profile",
        keys: ["ui.theme"],
      }),
    );
    await vi.waitFor(() =>
      expect(document.getElementById("openclaw-custom-theme")?.textContent).toContain(
        "--bg: #221133;",
      ),
    );
    expect(applicationTheme.branding).toEqual({
      mascot: "none",
      workingPhrases: ["Building", "Compiling"],
      critters: ["penguin", "fedora"],
      avatarHat: "fedora",
    });
    expect(document.documentElement.dataset.themeMascot).toBe("none");
    expect(document.documentElement.dataset.themeAvatarHat).toBe("fedora");
    await vi.dynamicImportSettled();
    expect(decodeURIComponent(favicon.href)).toContain("<rect");

    const artwork = {
      hats: {
        beret: { url: "/__openclaw__/plugin-theme-art/space-pack/xenovessel/hat/beret?v=1" },
      },
      critters: {
        ferris: {
          url: "/__openclaw__/plugin-theme-art/space-pack/xenovessel/critter/ferris?v=1",
          crossMs: 5000,
        },
      },
    };
    response = catalog({
      ...definition,
      mascot: "none",
      avatarHat: "beret",
      critters: ["ferris"],
      workingPhrases: [],
      dark: createThemePaletteFixture({ background: "#332244" }),
    });
    response.theme = { ...descriptor, artwork };
    current().opts.onEvent?.(createGatewayEvent("plugins.changed", { generation: 1 }));
    await vi.waitFor(() =>
      expect(document.getElementById("openclaw-custom-theme")?.textContent).toContain(
        "--bg: #332244;",
      ),
    );
    expect(applicationTheme.branding.artwork).toEqual(artwork);
    expect(currentThemeBranding().artwork).toEqual(artwork);
    expect(currentThemeBranding().avatarHat).toBe("beret");
    expect(currentThemeBranding().critters).toEqual(["ferris"]);

    response = {
      themes: [...BUILTIN_THEMES],
      theme: expectDefined(BUILTIN_THEMES[0], "default built-in theme"),
      current: { ...response.current, id: "claw", requestedId: descriptor.id },
    };
    current().opts.onEvent?.(createGatewayEvent("plugins.changed", { generation: 2 }));
    await vi.waitFor(() => expect(document.documentElement.dataset.themeId).toBe("claw"));
    expect(applicationTheme.settings.theme).toBe(descriptor.id);
    expect(applicationTheme.catalog?.unavailableId).toBe(descriptor.id);
    expect(applicationTheme.branding.mascot).toBe("claw");
    expect(document.documentElement.dataset.themeMascot).toBe("claw");
    expect(document.documentElement.dataset.themeAvatarHat).toBeUndefined();
    await vi.dynamicImportSettled();
    expect(favicon.getAttribute("href")).toBe("/favicon.svg");

    response = catalog();
    current().opts.onEvent?.(createGatewayEvent("plugins.changed", { generation: 3 }));
    await vi.waitFor(() => expect(document.documentElement.dataset.themeId).toBe(descriptor.id));
    expect(clients).toHaveLength(1);
    expect(current().stopped).toBe(0);
  } finally {
    applicationTheme.dispose();
    gateway.stop();
    favicon.remove();
  }
});

it("discards a palette response after the requesting profile changes", async () => {
  const { gateway, current } = createGatewayStoreTestStore();
  const applicationTheme = createApplicationTheme(loadSettings(), gateway);
  gateway.start();
  const retired = createDeferred<ThemesListResult>();
  current().request.mockReturnValue(retired.promise);
  current().opts.onHello?.({
    ...GATEWAY_STORE_TEST_HELLO,
    snapshot: { presence: [{ instanceId: current().instanceId, user: { id: "first" } }] },
  });
  try {
    await vi.waitFor(() => expect(current().request).toHaveBeenCalledWith("themes.list", {}));
    current().request.mockResolvedValue({
      themes: [...BUILTIN_THEMES],
      theme: expectDefined(BUILTIN_THEMES[0], "default built-in theme"),
      current: { id: "claw", mode: "system", scope: "profile", overrides: {} },
    } satisfies ThemesListResult);
    current().opts.onEvent?.(
      createGatewayEvent("presence", {
        presence: [{ instanceId: current().instanceId, user: { id: "second" } }],
      }),
    );
    await vi.waitFor(() => expect(applicationTheme.catalog?.themes).toEqual(BUILTIN_THEMES));
    retired.resolve(catalog());
    await retired.promise;
    expect(document.documentElement.dataset.themeId).toBe("claw");
    expect(applicationTheme.catalog?.themes.some((theme) => theme.id === descriptor.id)).toBe(
      false,
    );
  } finally {
    applicationTheme.dispose();
    gateway.stop();
  }
});

it("retries a failed selected palette only after an explicit catalog retry", async () => {
  const { gateway, current } = createGatewayStoreTestStore();
  const applicationTheme = createApplicationTheme(loadSettings(), gateway);
  gateway.start();
  let paletteReads = 0;
  current().request.mockImplementation(async (method) => {
    if (method === "themes.list") {
      return {
        themes: [...BUILTIN_THEMES, descriptor],
        theme: expectDefined(BUILTIN_THEMES[0], "default built-in theme"),
        current: { id: "claw", mode: "system", scope: "profile", overrides: {} },
      } satisfies ThemesListResult;
    }
    if (method === "themes.get") {
      paletteReads += 1;
      if (paletteReads === 1) {
        throw new Error("Theme palette temporarily unavailable");
      }
      return catalog();
    }
    throw new Error(`Unexpected request ${method}`);
  });
  current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
  try {
    await vi.waitFor(() =>
      expect(applicationTheme.catalog?.error).toBe("Theme palette temporarily unavailable"),
    );
    expect(document.documentElement.dataset.themeId).toBe("claw");
    patchSettings({ textScale: 110 });
    expect(applicationTheme.resolvedMode).toBe("light");
    expect(paletteReads).toBe(1);

    expectDefined(applicationTheme.retryCatalog, "theme catalog retry")();
    await vi.waitFor(() => expect(document.documentElement.dataset.themeId).toBe(descriptor.id));
    expect(applicationTheme.catalog?.error).toBeNull();
    expect(document.getElementById("openclaw-custom-theme")?.textContent).toContain(
      "--bg: #111122;",
    );
    expect(paletteReads).toBe(2);
  } finally {
    applicationTheme.dispose();
    gateway.stop();
  }
});

it("does not report a previous palette failure after a local theme switch", async () => {
  const replacement: ThemeDescriptor = {
    ...descriptor,
    id: "space-pack/afterglow",
    name: "Afterglow",
  };
  const replacementDefinition = createThemeDefinitionFixture({
    name: replacement.name,
    description: replacement.description,
    dark: createThemePaletteFixture({ background: "#332211" }),
  });
  const selected: ThemesGetResult = {
    theme: expectDefined(BUILTIN_THEMES[0], "default built-in theme"),
    current: { id: "claw", mode: "system", scope: "profile", overrides: {} },
  };
  const retired = createDeferred<ThemesGetResult>();
  const { gateway, current } = createGatewayStoreTestStore();
  const applicationTheme = createApplicationTheme(loadSettings(), gateway);
  gateway.start();
  let paletteReads = 0;
  current().request.mockImplementation((method, params) => {
    if (method === "themes.list") {
      return Promise.resolve({
        ...selected,
        themes: [...BUILTIN_THEMES, descriptor, replacement],
      } satisfies ThemesListResult);
    }
    if (method === "themes.get") {
      paletteReads += 1;
      if (paletteReads === 1) {
        expect(params).toEqual({ id: descriptor.id });
        return retired.promise;
      }
      expect(params).toEqual({ id: replacement.id });
      return Promise.resolve({
        current: selected.current,
        theme: replacement,
        definition: replacementDefinition,
      } satisfies ThemesGetResult);
    }
    return Promise.reject(new Error(`Unexpected request ${method}`));
  });
  current().opts.onHello?.({
    ...GATEWAY_STORE_TEST_HELLO,
    auth: { role: "operator", scopes: ["operator.read"] },
    snapshot: { presence: [{ instanceId: current().instanceId, user: { id: "read-only" } }] },
  });
  try {
    await vi.waitFor(() =>
      expect(current().request).toHaveBeenCalledWith("themes.get", { id: descriptor.id }),
    );
    patchSettings({ theme: replacement.id });
    await vi.waitFor(() => expect(document.documentElement.dataset.themeId).toBe(replacement.id));
    expect(applicationTheme.settings.theme).toBe(replacement.id);
    expect(document.getElementById("openclaw-custom-theme")?.textContent).toContain(
      "--bg: #332211;",
    );

    retired.reject(new Error("Previous palette is unavailable"));
    await retired.promise.catch(() => undefined);
    expect(document.documentElement.dataset.themeId).toBe(replacement.id);
    expect(applicationTheme.catalog?.error).toBeNull();
    expect(paletteReads).toBe(2);
  } finally {
    applicationTheme.dispose();
    gateway.stop();
  }
});

it("keeps a local palette selected during catalog refresh and reloads later versions", async () => {
  patchSettings({ theme: "claw" });
  const response: ThemesListResult = {
    themes: [...BUILTIN_THEMES, descriptor],
    theme: expectDefined(BUILTIN_THEMES[0], "default built-in theme"),
    current: { id: "claw", mode: "system", scope: "profile", overrides: {} },
  };
  const refreshing = createDeferred<ThemesListResult>();
  const { gateway, current } = createGatewayStoreTestStore();
  const applicationTheme = createApplicationTheme(loadSettings(), gateway);
  gateway.start();
  let lists = 0;
  let palette = definition;
  let paletteResponse: Promise<ThemesGetResult> | undefined;
  let paletteReads = 0;
  current().request.mockImplementation((method) => {
    if (method === "themes.list") {
      lists += 1;
      return lists === 2 ? refreshing.promise : Promise.resolve(response);
    }
    if (method === "themes.get") {
      paletteReads += 1;
      return paletteResponse ?? Promise.resolve({ ...catalog(palette), current: response.current });
    }
    if (method === "plugins.uiDescriptors") {
      return Promise.resolve({ ok: true, generation: 1, descriptors: [], methods: [] });
    }
    return Promise.reject(new Error(`Unexpected request ${method}`));
  });
  current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
  try {
    await vi.waitFor(() => expect(applicationTheme.catalog?.themes).toContainEqual(descriptor));
    current().opts.onEvent?.(createGatewayEvent("plugins.changed", { generation: 1 }));
    await vi.waitFor(() => expect(lists).toBe(2));
    patchSettings({ theme: descriptor.id });
    await vi.waitFor(() => expect(document.documentElement.dataset.themeId).toBe(descriptor.id));

    refreshing.resolve(response);
    await refreshing.promise;
    await vi.waitFor(() => expect(document.documentElement.dataset.themeId).toBe(descriptor.id));
    expect(applicationTheme.settings.theme).toBe(descriptor.id);

    palette = createThemeDefinitionFixture({
      dark: createThemePaletteFixture({ background: "#442244" }),
    });
    const delayed = createDeferred<ThemesGetResult>();
    paletteResponse = delayed.promise;
    current().opts.onEvent?.(createGatewayEvent("plugins.changed", { generation: 2 }));
    await vi.waitFor(() => expect(paletteReads).toBe(2));
    expect(document.documentElement.dataset.themeId).toBe(descriptor.id);
    expect(document.getElementById("openclaw-custom-theme")?.textContent).toContain(
      "--bg: #111122;",
    );
    delayed.resolve({ ...catalog(palette), current: response.current });
    await delayed.promise;
    await vi.waitFor(() =>
      expect(document.getElementById("openclaw-custom-theme")?.textContent).toContain(
        "--bg: #442244;",
      ),
    );

    const failed = createDeferred<ThemesGetResult>();
    paletteResponse = failed.promise;
    current().opts.onEvent?.(createGatewayEvent("plugins.changed", { generation: 3 }));
    await vi.waitFor(() => expect(paletteReads).toBe(3));
    failed.reject(new Error("Palette refresh temporarily failed"));
    await failed.promise.catch(() => undefined);
    expect(document.documentElement.dataset.themeId).toBe(descriptor.id);
    expect(document.getElementById("openclaw-custom-theme")?.textContent).toContain(
      "--bg: #442244;",
    );
    expect(applicationTheme.catalog?.error).toBe("Palette refresh temporarily failed");
    patchSettings({ textScale: 110 });
    expect(paletteReads).toBe(3);

    paletteResponse = undefined;
    palette = createThemeDefinitionFixture({
      dark: createThemePaletteFixture({ background: "#553355" }),
    });
    expectDefined(applicationTheme.retryCatalog, "theme catalog retry")();
    await vi.waitFor(() =>
      expect(document.getElementById("openclaw-custom-theme")?.textContent).toContain(
        "--bg: #553355;",
      ),
    );
    expect(applicationTheme.catalog?.error).toBeNull();
  } finally {
    applicationTheme.dispose();
    gateway.stop();
  }
});

it.each(["success", "failure"] as const)(
  "ignores a late palette %s after its plugin disappears during refresh",
  async (outcome) => {
    patchSettings({ theme: "claw" });
    const response: ThemesListResult = {
      themes: [...BUILTIN_THEMES, descriptor],
      theme: expectDefined(BUILTIN_THEMES[0], "default built-in theme"),
      current: { id: "claw", mode: "system", scope: "profile", overrides: {} },
    };
    const refreshing = createDeferred<ThemesListResult>();
    const retired = createDeferred<ThemesGetResult>();
    const { gateway, current } = createGatewayStoreTestStore();
    const applicationTheme = createApplicationTheme(loadSettings(), gateway);
    gateway.start();
    let lists = 0;
    current().request.mockImplementation((method) => {
      if (method === "themes.list") {
        return ++lists === 1 ? Promise.resolve(response) : refreshing.promise;
      }
      if (method === "themes.get") {
        return retired.promise;
      }
      if (method === "plugins.uiDescriptors") {
        return Promise.resolve({ ok: true, generation: 1, descriptors: [], methods: [] });
      }
      return Promise.reject(new Error(`Unexpected request ${method}`));
    });
    current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
    try {
      await vi.waitFor(() => expect(applicationTheme.catalog?.themes).toContainEqual(descriptor));
      current().opts.onEvent?.(createGatewayEvent("plugins.changed", { generation: 1 }));
      await vi.waitFor(() => expect(lists).toBe(2));
      patchSettings({ theme: descriptor.id });
      await vi.waitFor(() =>
        expect(current().request).toHaveBeenCalledWith("themes.get", { id: descriptor.id }),
      );
      refreshing.resolve({ ...response, themes: [...BUILTIN_THEMES] });
      await refreshing.promise;
      expect(applicationTheme.catalog?.themes).toEqual(BUILTIN_THEMES);

      if (outcome === "success") {
        retired.resolve({ ...catalog(), current: response.current });
      } else {
        retired.reject(new Error("Removed palette is unavailable"));
      }
      await retired.promise.catch(() => undefined);
      expect(applicationTheme.settings.theme).toBe(descriptor.id);
      expect(document.documentElement.dataset.themeId).toBe("claw");
      expect(document.getElementById("openclaw-custom-theme")).toBeNull();
      expect(applicationTheme.catalog?.error).toBeNull();
    } finally {
      applicationTheme.dispose();
      gateway.stop();
    }
  },
);

it.each(["profile", "client"] as const)(
  "discards a late personal palette after the requesting %s changes",
  async (boundary) => {
    const personal: ThemeDescriptor = {
      id: "user/personal",
      name: "Personal",
      description: "A profile-owned palette.",
      source: "user",
      modes: ["dark"],
    };
    patchSettings({ theme: personal.id });
    const response: ThemesListResult = {
      themes: [...BUILTIN_THEMES, personal],
      theme: expectDefined(BUILTIN_THEMES[0], "default built-in theme"),
      current: { id: "claw", mode: "system", scope: "profile", overrides: {} },
    };
    const retired = createDeferred<ThemesGetResult>();
    const { gateway, current } = createGatewayStoreTestStore();
    const applicationTheme = createApplicationTheme(loadSettings(), gateway);
    gateway.start();
    current().request.mockImplementation((method) =>
      method === "themes.get" ? retired.promise : Promise.resolve(response),
    );
    current().opts.onHello?.({
      ...GATEWAY_STORE_TEST_HELLO,
      snapshot: { presence: [{ instanceId: current().instanceId, user: { id: "first" } }] },
    });
    try {
      await vi.waitFor(() =>
        expect(current().request).toHaveBeenCalledWith("themes.get", { id: personal.id }),
      );
      if (boundary === "client") {
        gateway.connect();
      }
      current().request.mockResolvedValue({
        ...response,
        theme: personal,
        definition: createThemeDefinitionFixture({
          dark: createThemePaletteFixture({ background: "#443355" }),
        }),
        current: { ...response.current, id: personal.id },
      } satisfies ThemesListResult);
      if (boundary === "profile") {
        current().opts.onEvent?.(
          createGatewayEvent("presence", {
            presence: [{ instanceId: current().instanceId, user: { id: "second" } }],
          }),
        );
      } else {
        current().opts.onHello?.({
          ...GATEWAY_STORE_TEST_HELLO,
          snapshot: { presence: [{ instanceId: current().instanceId, user: { id: "first" } }] },
        });
      }
      await vi.waitFor(() =>
        expect(document.getElementById("openclaw-custom-theme")?.textContent).toContain(
          "--bg: #443355;",
        ),
      );
      retired.resolve({ ...response, theme: personal, definition });
      await retired.promise;
      expect(document.getElementById("openclaw-custom-theme")?.textContent).toContain(
        "--bg: #443355;",
      );
      expect(applicationTheme.catalog?.error).toBeNull();
    } finally {
      applicationTheme.dispose();
      gateway.stop();
    }
  },
);

it.each(["Appearance discovery", "profile selection"] as const)(
  "leaves built-in presentation quiet until %s needs the catalog",
  async (trigger) => {
    patchSettings({ theme: "claw" });
    const { gateway, current } = createGatewayStoreTestStore();
    const applicationTheme = createApplicationTheme(loadSettings(), gateway);
    const published = vi.fn();
    const unsubscribe = applicationTheme.subscribe(published);
    gateway.start();
    current().request.mockResolvedValue(catalog());
    current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
    try {
      await vi.dynamicImportSettled();
      expect(current().request).not.toHaveBeenCalled();
      expect(published).not.toHaveBeenCalled();
      expect(document.documentElement.dataset.themeId).toBe("claw");

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
        await vi.waitFor(() =>
          expect(document.documentElement.dataset.themeId).toBe(descriptor.id),
        );
      }
      await vi.waitFor(() => expect(applicationTheme.catalog?.themes).toContainEqual(descriptor));
      expect(current().request).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
      applicationTheme.dispose();
      gateway.stop();
    }
  },
);
