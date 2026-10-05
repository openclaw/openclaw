/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_APPEARANCE_PREFERENCE_KEYS } from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { createImportedCustomThemeFixture } from "../test-helpers/custom-theme.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { changedServerUiPrefs, selectThemeSettings } from "./server-prefs-intent.ts";
import { extractServerUiPrefs, type SyncedPrefKey } from "./server-prefs-state.ts";
import {
  configWithPrefs,
  createServerPrefsWriter,
  type RequestMock,
} from "./server-prefs.test-support.ts";
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

const profileId = "profile-ada";
const scope = "ws://profiles";
const createWriter = (request: RequestMock, canPatch = true) =>
  createServerPrefsWriter(request, scope, true, { ok: true }, canPatch);
function readOptions(
  writer: ReturnType<typeof createWriter>,
  configObject: unknown,
  id = profileId,
  onApplied = vi.fn(),
) {
  return { client: writer.state.client!, profileId: id, configObject, scope, onApplied };
}

function profileState<K extends SyncedPrefKey>(config: unknown, key: K, settings = loadSettings()) {
  return resolveServerUiPrefState(config, key, scope, settings, { profileId });
}

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
  it("preserves imported definitions and only resets design overrides when activation changes", () => {
    const customTheme = createImportedCustomThemeFixture();
    patchSettings({
      theme: "dash",
      fontUi: "geist",
      fontChat: "lora",
      accent: "#123456",
      customTheme,
      textScale: 125,
    });
    const selected = selectThemeSettings("custom");
    expect(selected.customTheme).toEqual(customTheme);
    expect(selected).toMatchObject({ theme: "custom", accent: "theme", textScale: 125 });
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
    const writer = createWriter(request);
    const onApplied = vi.fn();

    await refreshProfileAppearancePrefs(readOptions(writer, config, profileId, onApplied));

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
      expect(profileState(config, key, loadSettings()), key).toEqual({
        overridden: value !== undefined,
        provenance: value === undefined ? "default" : "profile",
        resetValue,
        value,
      });
    }
    expect(profileState(config, "themeMode", loadSettings()).provenance).toBe("synced");
  });

  it("retains the boot mirror while the profile is unresolved and unavailable", async () => {
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
    const writer = createWriter(request);
    const options = readOptions(writer, config);

    applyServerUiPrefs(config, options);
    const refresh = refreshProfileAppearancePrefs(options);

    expect(loadSettings()).toMatchObject({ ...mirror, chatShowThinking: false });
    expect(JSON.parse(localStorage.getItem(lastSeenKey)!)).toEqual({
      ...mirror,
      chatShowThinking: false,
    });
    resolve({ status: "unavailable" });
    await refresh;
    expect(loadSettings()).toMatchObject({ ...mirror, chatShowThinking: false });
  });

  it.each([
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
    const writer = createWriter(request, false);
    Object.assign(writer.state, { configSnapshot: { config } });
    applyServerUiPrefs(config, options);
    const pending = refreshProfileAppearancePrefs({ ...options, client: writer.state.client! });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    const previous = loadSettings();
    const state = profileState(config, key, previous);
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
    const reloaded = createWriter(request);
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
      const writer = createWriter(request);
      await refreshProfileAppearancePrefs(readOptions(writer, config));
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
      const reconnected = createWriter(request);
      flushServerUiPrefs(reconnected, { profileId: null, canWrite: true });
      flushServerUiPrefs(reconnected, { profileId, canWrite: true });
      await refreshProfileAppearancePrefs(readOptions(reconnected, config));
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "users.prefs.get",
        "users.prefs.get",
      ]);
      expect(loadSettings().accent).toBe("#123456");
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
    const writer = createWriter(request, false);
    const config = configWithPrefs({ theme: "claw" });
    const options = readOptions(writer, config);
    await refreshProfileAppearancePrefs(options);
    patchSettings({ theme: "dash" });
    const afterCommit = vi.fn();
    pushServerUiPrefs(writer, { theme: "dash" }, { profileId, canWrite: true, afterCommit });
    await waitForFast(() => expect(request).toHaveBeenCalledWith("themes.set", { id: "dash" }));
    profileTheme = "absolutely";

    await refreshProfileAppearancePrefs(options);
    expect(request.mock.calls.filter(([method]) => method === "users.prefs.get")).toHaveLength(2);

    expect(loadSettings().theme).toBe("dash");
    expect(profileState(config, "theme", loadSettings())).toMatchObject({
      provenance: "pending",
      value: "dash",
    });
    releaseWrite({ status: "ok" });
    await waitForFast(() => expect(afterCommit).toHaveBeenCalledOnce());
    expect(profileState(config, "theme", loadSettings())).toMatchObject({
      provenance: "profile",
      value: "dash",
    });
    Object.assign(writer.state, { configSnapshot: { config } });
    const previous = loadSettings();
    const reset = resetServerUiPref("theme", profileState(config, "theme"), scope, profileId);
    expect(reset.theme).toBe("claw");
    const delta = changedServerUiPrefs(previous, reset);
    expect(delta).toEqual({ theme: null, accent: "theme", fontUi: null, fontChat: null });
    afterCommit.mockClear();
    pushServerUiPrefs(writer, delta!, { profileId, canWrite: true, afterCommit });
    await waitForFast(() => expect(afterCommit).toHaveBeenCalledOnce());
    expect(request).toHaveBeenLastCalledWith("themes.set", {
      id: null,
      appearance: { accent: "theme", fontUi: null, fontChat: null },
    });
    expect(profileState(config, "theme")).toMatchObject({ provenance: "synced", value: "claw" });
  });

  it("keeps read-only profile edits device-local without attempting a profile write", async () => {
    const config = configWithPrefs({ theme: "claw" });
    const request = vi.fn(async () => ({ status: "ok" as const, entries: {} }));
    const writer = createWriter(request, false);
    await refreshProfileAppearancePrefs(readOptions(writer, config));
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
    const writer = createWriter(request);
    const options = (selectedProfileId: string) => readOptions(writer, config, selectedProfileId);
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
});

it.each([false, true])(
  "keeps mixed profile appearance edits in one mutation (rejected=%s)",
  async (rejected) => {
    const entries = {
      "ui.theme": "knot",
      "ui.accent": "#123456",
      "ui.fontUi": "geist",
    };
    const request = vi.fn(async (method: string) => {
      if (method === "users.prefs.get") {
        return { status: "ok", entries };
      }
      if (rejected) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Theme is no longer available.",
        });
      }
      return { application: "saved" };
    });
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    const config = configWithPrefs({ theme: "claw" });
    const profileRead = {
      client: writer.state.client!,
      profileId,
      configObject: config,
      scope,
      onApplied: vi.fn(),
    };
    await refreshProfileAppearancePrefs(profileRead);
    request.mockClear();

    const local = {
      theme: "space-pack/xenovessel",
      themeMode: "dark",
      accent: "#654321",
      fontUi: undefined,
      fontChat: "lora",
    } as const;
    patchSettings(local);
    const afterCommit = vi.fn();
    pushServerUiPrefs(
      writer,
      { ...local, fontUi: null },
      { profileId, canWrite: true, afterCommit },
    );
    await waitForFast(() => expect(afterCommit).toHaveBeenCalledOnce());

    expect(request).toHaveBeenCalledExactlyOnceWith("themes.set", {
      id: "space-pack/xenovessel",
      mode: "dark",
      appearance: { accent: "#654321", fontUi: null, fontChat: "lora" },
    });
    expect(afterCommit).toHaveBeenCalledWith(
      rejected ? { needsRefresh: false, retainedLocal: true } : { needsRefresh: false },
    );
    expect(loadSettings()).toMatchObject(local);
    if (rejected) {
      await refreshProfileAppearancePrefs(profileRead);
      expect(loadSettings()).toMatchObject(local);
    }
    expect(
      resolveServerUiPrefState(config, "theme", scope, loadSettings(), { profileId }),
    ).toMatchObject({ provenance: rejected ? "device-local" : "profile", value: local.theme });
  },
);
