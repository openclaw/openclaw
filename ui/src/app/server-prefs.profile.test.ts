/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeUiAppearancePreference,
  UI_APPEARANCE_PREFERENCE_KEYS,
} from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createImportedCustomThemeFixture } from "../test-helpers/custom-theme.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { changedServerUiPrefs, selectThemeSettings } from "./server-prefs-intent.ts";
import {
  extractServerUiPrefs,
  resolveServerUiPrefStateFromSnapshot,
} from "./server-prefs-state.ts";
import { configWithPrefs, createServerPrefsWriter } from "./server-prefs.test-support.ts";
import {
  applyServerUiPrefs,
  flushServerUiPrefs,
  pushServerUiPrefs,
  refreshProfileAppearancePrefs,
  resetServerUiPref,
  resetServerUiPrefsSync,
  resolveServerUiPrefState,
} from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";
import type { ThemeName } from "./theme.ts";

const profileId = "profile-ada";
const scope = "ws://profiles";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
  patchSettings({ gatewayUrl: scope });
});

afterEach(() => {
  resetServerUiPrefsSync();
  vi.unstubAllGlobals();
});

describe("profile-bound appearance preferences", () => {
  it("persists a selected theme's defaults above gateway accents and keeps later customizations", async () => {
    const config = configWithPrefs({ theme: "claw", accent: "#123456" });
    const entries: Record<string, unknown> = {
      "ui.theme": "dash",
      "ui.fontUi": "geist",
      "ui.fontChat": "geist",
      "ui.accent": "#abcdef",
    };
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "users.prefs.set" || method === "themes.set") {
        const theme = params as { id: string; appearance: Record<string, unknown> };
        const patch =
          method === "themes.set"
            ? {
                "ui.theme": theme.id,
                ...Object.fromEntries(
                  Object.entries(theme.appearance).map(([key, value]) => [`ui.${key}`, value]),
                ),
              }
            : (params as { entries: Record<string, unknown> }).entries;
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) {
            delete entries[key];
          } else {
            entries[key] = value;
          }
        }
      }
      return { status: "ok" as const, entries: { ...entries } };
    });
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    const options = {
      client: writer.state.client!,
      profileId,
      scope,
      configObject: config,
      onApplied: vi.fn(),
    };
    await refreshProfileAppearancePrefs(options);
    patchSettings({ themeMode: "system", locale: "en", textScale: 125, chatShowThinking: false });
    const before = loadSettings();
    const selected = selectThemeSettings("absolutely");
    expect(selected).toMatchObject({
      theme: "absolutely",
      accent: "theme",
      themeMode: "system",
      locale: "en",
      textScale: 125,
      chatShowThinking: false,
    });
    expect(selected.fontUi).toBeUndefined();
    expect(selected.fontChat).toBeUndefined();
    const patch = changedServerUiPrefs(before, selected)!;
    expect(patch).toEqual({ theme: "absolutely", accent: "theme", fontUi: null, fontChat: null });
    const committed = vi.fn();
    pushServerUiPrefs(writer, patch, { profileId, canWrite: true, afterCommit: committed });
    await waitForFast(() => expect(committed).toHaveBeenCalled());
    expect(entries).toEqual({ "ui.theme": "absolutely", "ui.accent": "theme" });
    await refreshProfileAppearancePrefs(options);
    expect(loadSettings()).toMatchObject({ theme: "absolutely", accent: "theme" });
    expect(loadSettings().fontUi).toBeUndefined();
    expect(loadSettings().fontChat).toBeUndefined();
    expect(request.mock.calls.every(([method]) => method !== "config.patch")).toBe(true);

    const customized = patchSettings({ fontUi: "geist", fontChat: "lora", accent: "#654321" });
    expect(selectThemeSettings("absolutely")).toEqual(customized);
    expect(changedServerUiPrefs(customized, loadSettings())).toBeNull();
    patchSettings({ themeMode: "light" });
    expect(loadSettings()).toMatchObject({ fontUi: "geist", fontChat: "lora", accent: "#654321" });
  });

  it("preserves imported definitions and only resets design overrides when activation changes", () => {
    const customTheme = createImportedCustomThemeFixture();
    patchSettings({
      theme: "dash",
      fontUi: "geist",
      fontChat: "lora",
      accent: "#123456",
      customTheme,
    });
    const selected = selectThemeSettings("custom");
    expect(selected.customTheme).toEqual(customTheme);
    expect(selected).toMatchObject({ theme: "custom", accent: "theme" });
    expect(selected.fontUi).toBeUndefined();
    const customized = patchSettings({ fontUi: "geist", accent: "#123456" });
    expect(selectThemeSettings("custom", { customTheme })).toEqual(customized);
    const cleared = selectThemeSettings("claw", { customTheme: undefined });
    expect(cleared.customTheme).toBeUndefined();
    expect(cleared.fontUi).toBeUndefined();
    expect(cleared.accent).toBe("theme");
    patchSettings({ fontUi: "geist", accent: "#123456", customTheme });
    expect(selectThemeSettings("claw", { customTheme: undefined })).toMatchObject({
      fontUi: "geist",
      accent: "#123456",
    });
  });

  it("clears profile font keys even when the boot mirror has not loaded them", () => {
    const before = patchSettings({ theme: "dash", fontUi: undefined, fontChat: undefined });
    expect(changedServerUiPrefs(before, selectThemeSettings("absolutely"))).toEqual({
      theme: "absolutely",
      accent: "theme",
      fontUi: null,
      fontChat: null,
    });
  });

  it("stores every Control UI theme name the profile wire contract knows", () => {
    // Record<ThemeName, boolean> turns a theme added to the UI but missing from
    // this table into a compile error, and the loop turns a wire-contract
    // mismatch into a runtime failure — a mismatch silently drops profile
    // themes. "custom" is the deliberate exception: its palette is
    // browser-local, so the selection must never follow the profile.
    const profileStorable: Record<ThemeName, boolean> = {
      claw: true,
      knot: true,
      dash: true,
      absolutely: true,
      tide: true,
      beacon: true,
      phosphor: true,
      crt: true,
      manuscript: true,
      rose: true,
      miami: true,
      custom: false,
    };
    for (const [theme, storable] of Object.entries(profileStorable)) {
      expect(normalizeUiAppearancePreference(UI_APPEARANCE_PREFERENCE_KEYS.theme, theme)).toBe(
        storable ? theme : undefined,
      );
    }
  });

  it("keeps a profile-bound custom theme selection in this browser only", async () => {
    const request = vi.fn(async () => ({ status: "ok" as const }));
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    const afterCommit = vi.fn();

    pushServerUiPrefs(
      writer,
      { theme: "custom", accent: "#123456" },
      { profileId, canWrite: true, afterCommit },
    );

    // The accent still syncs; the custom theme is retained browser-local and
    // never reaches users.prefs.set.
    await waitForFast(() =>
      expect(request).toHaveBeenCalledExactlyOnceWith("users.prefs.set", {
        entries: { "ui.accent": "#123456" },
      }),
    );
    expect(afterCommit).toHaveBeenCalledWith({ needsRefresh: false, retainedLocal: true });
  });

  it("overlays profile appearance values without changing anonymous snapshot resolution", () => {
    const config = configWithPrefs({ theme: "claw" });
    const settings = { ...loadSettings(), theme: "knot" as const };

    expect(
      resolveServerUiPrefStateFromSnapshot(config, "theme", null, settings, true, {
        theme: "knot",
      }),
    ).toEqual({
      overridden: true,
      provenance: "profile",
      resetValue: "claw",
      value: "knot",
    });
    expect(resolveServerUiPrefStateFromSnapshot(config, "theme", null, settings, true)).toEqual({
      overridden: true,
      provenance: "device-local",
      resetValue: "claw",
      value: "knot",
    });
  });

  it("normalizes profile overrides above config while rejecting malformed stored values", async () => {
    const config = configWithPrefs({
      theme: "claw",
      themeMode: "dark",
      accent: "#123456",
      fontUi: "unsupported",
      fontChat: "lora",
    });
    const request = vi.fn(async () => ({
      status: "ok" as const,
      entries: {
        "ui.theme": "knot",
        "ui.themeMode": { mode: "light" },
        "ui.accent": "#AbC123",
        "ui.fontUi": "geist",
        "ui.fontChat": { family: "lora" },
      },
    }));
    const writer = createServerPrefsWriter(request, scope);
    const onApplied = vi.fn();

    await refreshProfileAppearancePrefs({
      client: writer.state.client!,
      profileId,
      configObject: config,
      scope,
      onApplied,
    });

    expect(request).toHaveBeenCalledExactlyOnceWith("users.prefs.get", {
      keys: ["ui.theme", "ui.themeMode", "ui.accent", "ui.fontUi", "ui.fontChat"],
    });
    expect(onApplied).toHaveBeenCalledWith({
      theme: "knot",
      themeMode: "dark",
      accent: "#abc123",
      fontUi: "geist",
    });
    expect(loadSettings().fontChat).toBeUndefined();
    expect(extractServerUiPrefs(config)).toEqual({
      theme: "claw",
      themeMode: "dark",
      accent: "#123456",
    });
    for (const [key, value, resetValue] of [
      ["fontUi", "geist", undefined],
      ["fontChat", undefined, undefined],
      ["theme", "knot", "claw"],
      ["accent", "#abc123", "#123456"],
    ] as const) {
      expect(
        resolveServerUiPrefState(config, key, scope, loadSettings(), { profileId }),
        key,
      ).toEqual({
        overridden: value !== undefined,
        provenance: value === undefined ? "default" : "profile",
        resetValue,
        value,
      });
    }
    expect(
      resolveServerUiPrefState(config, "themeMode", scope, loadSettings(), { profileId })
        .provenance,
    ).toBe("synced");
  });

  it("reuses profile preferences across repeated reads until a save invalidates them", async () => {
    const request = vi.fn(async (method: string) =>
      method === "users.prefs.get"
        ? { status: "ok" as const, entries: { "ui.theme": "knot" } }
        : { status: "ok" as const },
    );
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    const options = {
      client: writer.state.client!,
      profileId,
      scope,
      configObject: configWithPrefs({}),
      onApplied: vi.fn(),
    };
    await refreshProfileAppearancePrefs(options);
    await refreshProfileAppearancePrefs(options);
    expect(request.mock.calls.filter(([method]) => method === "users.prefs.get")).toHaveLength(1);
    const committed = vi.fn();
    pushServerUiPrefs(
      writer,
      { theme: "dash" },
      { profileId, canWrite: true, afterCommit: committed },
    );
    await waitForFast(() => expect(committed).toHaveBeenCalledOnce());
    await refreshProfileAppearancePrefs(options);
    expect(request.mock.calls.filter(([method]) => method === "users.prefs.get")).toHaveLength(2);
  });

  it.each(["override", "empty", "unavailable"] as const)(
    "retains the boot mirror while the profile is unresolved, then handles %s",
    async (outcome) => {
      const config = configWithPrefs({
        theme: "absolutely",
        themeMode: "light",
        chatShowThinking: false,
      });
      const mirror = { theme: "rose" as const, themeMode: "dark" as const, accent: "#123456" };
      patchSettings(mirror);
      const lastSeenKey = `openclaw.control.serverPrefs.v1:${scope}:profile:${profileId}`;
      localStorage.setItem(lastSeenKey, JSON.stringify(mirror));
      const { promise, resolve } = createDeferred<unknown>();
      const request = vi.fn(() => promise);
      const writer = createServerPrefsWriter(request, scope);
      const options = {
        client: writer.state.client!,
        profileId,
        configObject: config,
        scope,
        onApplied: vi.fn(),
      };

      applyServerUiPrefs(config, options);
      const refresh = refreshProfileAppearancePrefs(options);

      expect(loadSettings()).toMatchObject({ ...mirror, chatShowThinking: false });
      expect(JSON.parse(localStorage.getItem(lastSeenKey)!)).toEqual({
        ...mirror,
        chatShowThinking: false,
      });
      resolve(
        outcome === "unavailable"
          ? { status: "unavailable" }
          : {
              status: "ok",
              entries:
                outcome === "override"
                  ? { "ui.theme": "rose", "ui.themeMode": "dark", "ui.accent": "#123456" }
                  : {},
            },
      );
      await refresh;
      expect(loadSettings()).toMatchObject(
        outcome === "empty"
          ? { theme: "absolutely", themeMode: "light", accent: undefined, chatShowThinking: false }
          : { ...mirror, chatShowThinking: false },
      );
    },
  );

  it("writes profile-bound appearance without requiring config-admin access", async () => {
    const request = vi.fn(async () => ({ status: "ok" as const }));
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);

    pushServerUiPrefs(writer, { theme: "knot" }, { profileId, canWrite: true });

    await waitForFast(() =>
      expect(request).toHaveBeenCalledExactlyOnceWith("themes.set", {
        id: "knot",
      }),
    );
  });

  it.each([
    ["accent", "#123456", "#abcdef"],
    ["theme", "rose", "absolutely"],
    ["fontUi", "geist", undefined],
  ] as const)("persists a %s reset during profile loading", async (key, saved, fallback) => {
    const preferenceKey = UI_APPEARANCE_PREFERENCE_KEYS[key];
    const config = configWithPrefs({ [key]: fallback });
    const savedEntries = { [preferenceKey]: saved };
    let entries: Record<string, string> = { ...savedEntries };
    const initial = createServerPrefsWriter(
      vi.fn(async () => ({ status: "ok", entries })),
      scope,
    );
    const options = {
      profileId,
      configObject: config,
      scope,
      onApplied: vi.fn(),
    };
    await refreshProfileAppearancePrefs({ ...options, client: initial.state.client! });
    resetServerUiPrefsSync();

    const delayed = createDeferred<unknown>();
    let firstRead = true;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "users.prefs.get") {
        if (firstRead) {
          firstRead = false;
          return delayed.promise;
        }
        return { status: "ok", entries };
      }
      expect(method).toBe(key === "theme" ? "themes.set" : "users.prefs.set");
      expect(params).toEqual(
        key === "theme"
          ? { id: null, appearance: { accent: "theme", fontUi: null, fontChat: null } }
          : { entries: { [preferenceKey]: null } },
      );
      entries = key === "theme" ? { "ui.accent": "theme" } : {};
      return { status: "ok" };
    });
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    Object.assign(writer.state, { configSnapshot: { config } });
    applyServerUiPrefs(config, options);
    const pending = refreshProfileAppearancePrefs({ ...options, client: writer.state.client! });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    const previous = loadSettings();
    const state = resolveServerUiPrefState(config, key, scope, previous, { profileId });
    const next = resetServerUiPref(key, state, scope, profileId);
    expect(next[key]).toBe(fallback);
    const delta = changedServerUiPrefs(previous, next);
    expect(delta).toEqual({
      [key]: null,
      ...(key === "theme" ? { accent: "theme", fontUi: null, fontChat: null } : {}),
    });
    const committed = vi.fn();
    pushServerUiPrefs(writer, delta!, { profileId, canWrite: true, afterCommit: committed });
    await waitForFast(() => expect(committed).toHaveBeenCalledOnce());

    // users.prefs.changed forces a fresh read before an older response can publish.
    await refreshProfileAppearancePrefs({ ...options, client: writer.state.client! });
    delayed.resolve({ status: "ok", entries: savedEntries });
    await pending;
    expect(loadSettings()[key]).toBe(fallback);
    expect(entries).toEqual(key === "theme" ? { "ui.accent": "theme" } : {});

    resetServerUiPrefsSync();
    const reloaded = createServerPrefsWriter(request, scope);
    await refreshProfileAppearancePrefs({ ...options, client: reloaded.state.client! });
    expect(loadSettings()[key]).toBe(fallback);
  });

  it.each([profileId, null])(
    "cancels a queued profile edit when reset after disconnect (%s)",
    async (profileIdAtEdit) => {
      const config = configWithPrefs({ accent: "#abcdef" });
      const request = vi.fn(async (_method: string) => ({
        status: "ok",
        entries: { "ui.accent": "#123456" },
      }));
      const writer = createServerPrefsWriter(request, scope);
      await refreshProfileAppearancePrefs({
        client: writer.state.client!,
        profileId,
        configObject: config,
        scope,
        onApplied: vi.fn(),
      });
      Object.assign(writer.state, { connected: false });
      patchSettings({ accent: "#654321" });
      pushServerUiPrefs(
        writer,
        { accent: "#654321" },
        { profileId: profileIdAtEdit, canWrite: true },
      );
      const previous = loadSettings();
      const state = resolveServerUiPrefState(undefined, "accent", scope, previous, {
        canSync: null,
      });
      const next = resetServerUiPref("accent", state, scope);
      expect(next.accent).toBe("#123456");
      expect(changedServerUiPrefs(previous, next)).toBeNull();

      resetServerUiPrefsSync();
      const reconnected = createServerPrefsWriter(request, scope);
      flushServerUiPrefs(reconnected, { profileId: null, canWrite: true });
      flushServerUiPrefs(reconnected, { profileId, canWrite: true });
      await refreshProfileAppearancePrefs({
        client: reconnected.state.client!,
        profileId,
        configObject: config,
        scope,
        onApplied: vi.fn(),
      });
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "users.prefs.get",
        "users.prefs.get",
      ]);
      expect(loadSettings().accent).toBe("#123456");
    },
  );

  it.each([
    ["theme", "knot", "dash", "claw", "synced"],
    ["fontUi", "lora", "system", undefined, "default"],
    ["fontChat", "lora", "system", undefined, "default"],
  ] as const)(
    "syncs and resets %s through the profile without config-admin access or config writes",
    async (key, initial, edited, resetValue, provenance) => {
      const preferenceKey = UI_APPEARANCE_PREFERENCE_KEYS[key];
      const config = configWithPrefs({ theme: "claw" });
      const request = vi.fn(async (method: string) =>
        method === "users.prefs.get"
          ? { status: "ok" as const, entries: { [preferenceKey]: initial } }
          : { status: "ok" as const },
      );
      const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
      Object.assign(writer.state, { configSnapshot: { config } });
      await refreshProfileAppearancePrefs({
        client: writer.state.client!,
        profileId,
        configObject: config,
        scope,
        onApplied: vi.fn(),
      });
      expect(loadSettings()[key]).toBe(initial);

      patchSettings({ [key]: edited });
      pushServerUiPrefs(writer, { [key]: edited }, { profileId, canWrite: true });
      await waitForFast(() =>
        expect(request).toHaveBeenLastCalledWith(
          key === "theme" ? "themes.set" : "users.prefs.set",
          key === "theme" ? { id: edited } : { entries: { [preferenceKey]: edited } },
        ),
      );

      const previous = loadSettings();
      const state = resolveServerUiPrefState(config, key, scope, previous, { profileId });
      const next = resetServerUiPref(key, state, scope, profileId);
      expect(next[key]).toBe(resetValue);
      const delta = changedServerUiPrefs(previous, next);
      expect(delta).toEqual({
        [key]: null,
        ...(key === "theme" ? { accent: "theme", fontUi: null, fontChat: null } : {}),
      });
      const afterCommit = vi.fn();
      pushServerUiPrefs(writer, delta!, { profileId, canWrite: true, afterCommit });
      await waitForFast(() => expect(afterCommit).toHaveBeenCalledOnce());
      expect(request).toHaveBeenLastCalledWith(
        key === "theme" ? "themes.set" : "users.prefs.set",
        key === "theme"
          ? { id: null, appearance: { accent: "theme", fontUi: null, fontChat: null } }
          : { entries: { [preferenceKey]: null } },
      );
      expect(
        resolveServerUiPrefState(config, key, scope, loadSettings(), { profileId }),
      ).toMatchObject({ provenance, value: resetValue });
      expect(request.mock.calls.some(([method]) => method === "config.patch")).toBe(false);
    },
  );

  it.each([false, true])(
    "keeps profile-only fonts out of config writes after offline=%s edits",
    async (offline) => {
      const request = vi.fn(async () => ({}));
      const writer = createServerPrefsWriter(request, scope, !offline);
      patchSettings({ fontUi: "geist", fontChat: "lora" });
      pushServerUiPrefs(writer, { fontUi: "geist", fontChat: "lora", theme: "dash" });
      if (offline) {
        expect(request).not.toHaveBeenCalled();
        flushServerUiPrefs(createServerPrefsWriter(request, scope));
      }
      await waitForFast(() =>
        expect(request).toHaveBeenCalledExactlyOnceWith("config.patch", {
          raw: JSON.stringify({ ui: { prefs: { theme: "dash" } } }),
          note: "control-ui prefs sync",
        }),
      );
      expect(loadSettings()).toMatchObject({ fontUi: "geist", fontChat: "lora" });
    },
  );

  it("keeps pending local edits above incoming profile updates", async () => {
    const { promise: write, resolve: releaseWrite } = createDeferred<unknown>();
    let profileTheme = "knot";
    const request = vi.fn(async (method: string) =>
      method === "users.prefs.get"
        ? { status: "ok" as const, entries: { "ui.theme": profileTheme } }
        : await write,
    );
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    const config = configWithPrefs({ theme: "claw" });
    const options = {
      client: writer.state.client!,
      profileId,
      configObject: config,
      scope,
      onApplied: vi.fn(),
    };
    await refreshProfileAppearancePrefs(options);
    patchSettings({ theme: "dash" });
    const afterCommit = vi.fn();
    pushServerUiPrefs(writer, { theme: "dash" }, { profileId, canWrite: true, afterCommit });
    await waitForFast(() => expect(request).toHaveBeenCalledWith("themes.set", { id: "dash" }));
    profileTheme = "absolutely";

    await refreshProfileAppearancePrefs(options);
    expect(request.mock.calls.filter(([method]) => method === "users.prefs.get")).toHaveLength(2);

    expect(loadSettings().theme).toBe("dash");
    expect(
      resolveServerUiPrefState(config, "theme", scope, loadSettings(), { profileId }),
    ).toMatchObject({ provenance: "pending", value: "dash" });
    releaseWrite({ status: "ok" });
    await waitForFast(() => expect(afterCommit).toHaveBeenCalledOnce());
    expect(
      resolveServerUiPrefState(config, "theme", scope, loadSettings(), { profileId }),
    ).toMatchObject({ provenance: "profile", value: "dash" });
  });

  it("keeps read-only profile edits device-local without attempting a profile write", async () => {
    const config = configWithPrefs({ theme: "claw" });
    const request = vi.fn(async () => ({ status: "ok" as const, entries: {} }));
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    await refreshProfileAppearancePrefs({
      client: writer.state.client!,
      profileId,
      configObject: config,
      scope,
      onApplied: vi.fn(),
    });
    patchSettings({ theme: "knot" });
    const afterCommit = vi.fn();

    pushServerUiPrefs(writer, { theme: "knot" }, { profileId, canWrite: false, afterCommit });

    expect(request).toHaveBeenCalledOnce();
    expect(afterCommit).toHaveBeenCalledWith({ needsRefresh: false, retainedLocal: true });
    expect(
      resolveServerUiPrefState(config, "theme", scope, loadSettings(), {
        profileId,
        canSync: false,
      }),
    ).toMatchObject({ provenance: "device-local", value: "knot" });
  });

  it("targets reset at the gateway value so an explicit product-default choice persists", async () => {
    // With an empty profile over a gateway theme of Dash, resetValue must be the
    // deletion fallback ("dash"); a product-default resetValue would classify an
    // explicit Claw selection as a reset and silently drop the user's choice.
    const config = configWithPrefs({ theme: "dash" });
    const request = vi.fn(async (method: string) =>
      method === "users.prefs.get"
        ? { status: "ok" as const, entries: {} }
        : { status: "ok" as const },
    );
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    await refreshProfileAppearancePrefs({
      client: writer.state.client!,
      profileId,
      configObject: config,
      scope,
      onApplied: vi.fn(),
    });

    const state = resolveServerUiPrefState(config, "theme", scope, loadSettings(), { profileId });
    expect(state).toMatchObject({ provenance: "synced", resetValue: "dash", value: "dash" });

    // The explicit Claw choice is a profile write, never a null reset.
    patchSettings({ theme: "claw" });
    pushServerUiPrefs(writer, { theme: "claw" }, { profileId, canWrite: true });
    await waitForFast(() =>
      expect(request).toHaveBeenLastCalledWith("themes.set", {
        id: "claw",
      }),
    );

    // Resetting from synced provenance with a profile bound lands on the
    // gateway value locally, matching what the profile-key deletion resolves to.
    const reset = resetServerUiPref("theme", state, scope, profileId);
    expect(reset.theme).toBe("dash");
  });

  it("applies a returning identity when the initial profile never resolved", async () => {
    const config = configWithPrefs({});
    patchSettings({ theme: "rose", accent: "#123456", fontUi: "geist" });
    localStorage.setItem(
      `openclaw.control.serverPrefs.v1:${scope}:profile:profile-b`,
      JSON.stringify({ theme: "knot" }),
    );
    applyServerUiPrefs(config, { scope, profileId: "profile-a", onApplied: vi.fn() });
    applyServerUiPrefs(config, { scope, profileId: "profile-b", onApplied: vi.fn() });
    const writer = createServerPrefsWriter(
      vi.fn(async () => ({
        status: "ok",
        entries: { "ui.theme": "knot" },
      })),
      scope,
    );

    await refreshProfileAppearancePrefs({
      client: writer.state.client!,
      profileId: "profile-b",
      configObject: config,
      scope,
      onApplied: vi.fn(),
    });

    expect(loadSettings()).toMatchObject({ theme: "knot", accent: undefined, fontUi: undefined });
  });

  it("restores profile appearance after reloading during a pending identity switch", async () => {
    const config = configWithPrefs({});
    let activeProfile = "profile-b";
    const request = vi.fn(async () => ({
      status: "ok",
      entries:
        activeProfile === "profile-b"
          ? { "ui.theme": "knot" }
          : { "ui.theme": "rose", "ui.accent": "#123456", "ui.fontUi": "geist" },
    }));
    const writer = createServerPrefsWriter(request, scope);
    const options = (selectedProfileId: string) => ({
      client: writer.state.client!,
      profileId: selectedProfileId,
      configObject: config,
      scope,
      onApplied: vi.fn(),
    });
    await refreshProfileAppearancePrefs(options(activeProfile));
    activeProfile = "profile-a";
    await refreshProfileAppearancePrefs(options(activeProfile));
    expect(loadSettings().theme).toBe("rose");
    activeProfile = "profile-b";
    applyServerUiPrefs(config, options(activeProfile));
    resetServerUiPrefsSync();
    applyServerUiPrefs(config, options(activeProfile));

    await refreshProfileAppearancePrefs(options(activeProfile));

    expect(loadSettings()).toMatchObject({ theme: "knot", accent: undefined, fontUi: undefined });
  });

  it.each(["pending", "device-local"] as const)(
    "restores the returning profile after a %s edit under an unresolved identity",
    async (edit) => {
      const config = configWithPrefs({});
      const request = vi.fn(async () => ({ status: "ok", entries: { "ui.theme": "rose" } }));
      const writer = createServerPrefsWriter(request, scope);
      const options = {
        client: writer.state.client!,
        profileId: "profile-a",
        configObject: config,
        scope,
        onApplied: vi.fn(),
      };
      await refreshProfileAppearancePrefs(options);
      applyServerUiPrefs(config, { ...options, profileId: "profile-b" });
      patchSettings({ theme: "knot", accent: "#123456" });
      pushServerUiPrefs(
        createServerPrefsWriter(request, scope, false),
        { theme: "knot", accent: "#123456" },
        { profileId: "profile-b", canWrite: edit === "pending" },
      );

      applyServerUiPrefs(config, options);
      await refreshProfileAppearancePrefs(options);

      expect(loadSettings()).toMatchObject({ theme: "rose", accent: undefined });
    },
  );

  it("reapplies the returning profile's appearance after an identity switch", async () => {
    // A→B→A in one browser: per-scope last-seen state must not skip re-applying
    // A's values while the DOM still shows B's.
    const config = configWithPrefs({});
    const prefsByProfile: Record<string, Record<string, string>> = {
      "profile-a": { "ui.theme": "knot" },
      "profile-b": {
        "ui.theme": "dash",
        "ui.accent": "#123456",
        "ui.fontUi": "geist",
        "ui.fontChat": "lora",
      },
    };
    let activeProfile = "profile-a";
    const request = vi.fn(async () => ({
      status: "ok" as const,
      entries: prefsByProfile[activeProfile],
    }));
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    const refresh = (nextProfile: string) => {
      activeProfile = nextProfile;
      applyServerUiPrefs(config, { scope, profileId: nextProfile, onApplied: vi.fn() });
      return refreshProfileAppearancePrefs({
        client: writer.state.client!,
        profileId: nextProfile,
        configObject: config,
        scope,
        onApplied: vi.fn(),
      });
    };

    await refresh("profile-a");
    expect(loadSettings().theme).toBe("knot");
    await refresh("profile-b");
    expect(loadSettings().theme).toBe("dash");
    expect(loadSettings().accent).toBe("#123456");
    expect(loadSettings()).toMatchObject({ fontUi: "geist", fontChat: "lora" });
    await refresh("profile-a");
    expect(loadSettings().theme).toBe("knot");
    // B's accent must not linger on A even though A's scope never recorded one.
    expect(loadSettings().accent).toBeUndefined();
    expect(loadSettings().fontUi).toBeUndefined();
    expect(loadSettings().fontChat).toBeUndefined();
  });
});
