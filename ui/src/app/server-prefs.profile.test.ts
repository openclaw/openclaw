/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { UI_APPEARANCE_PREFERENCE_KEYS } from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { createImportedCustomThemeFixture } from "../test-helpers/custom-theme.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { selectThemeSettings, resetServerUiPref } from "./server-prefs-controls.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import {
  applyServerUiPrefs,
  refreshProfileAppearancePrefs as refreshPrefs,
  resolveServerUiPrefState as resolvePref,
} from "./server-prefs-reconcile.ts";
import type { SyncedPrefKey } from "./server-prefs-state.ts";
import {
  configWithPrefs,
  createServerPrefsWriter,
  installServerPrefsStorage,
  type RequestMock,
} from "./server-prefs.test-support.ts";
import { flushServerUiPrefs, pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

const profileId = "profile-ada";
const scope = "ws://profiles";
const createWriter = (request: RequestMock, canPatch = true) =>
  createServerPrefsWriter(request, scope, true, { ok: true }, canPatch);
const hooks = { profileId, canWrite: true };
const clearedDesign = { accent: "theme", fontUi: null, fontChat: null };
const clearedSelection = { accent: "theme", fontUi: undefined };
const design = { fontUi: "geist" as const, accent: "#123456" };
const response = (entries: Record<string, unknown>) => ({ status: "ok", entries });
const readRequest = (entries: Record<string, unknown>) =>
  vi.fn(async (_method: string) => response(entries));
function profileState<K extends SyncedPrefKey>(
  config: unknown,
  key: K,
  options: { canSync?: boolean; profileId?: string } = {},
) {
  return resolvePref(config, key, scope, loadSettings(), { profileId, ...options });
}

function readProfile(request: RequestMock, configObject: unknown, canPatch = false) {
  const writer = createWriter(request, canPatch);
  const client = writer.state.client!;
  const options = { client, profileId, configObject, scope, onApplied: vi.fn() };
  return { writer, options, refresh: () => refreshPrefs(options) };
}

async function resetProfile(
  writer: ReturnType<typeof createWriter>,
  config: unknown,
  key: "theme" | "fontUi",
  fallback: unknown,
  committed = vi.fn(),
) {
  const previous = loadSettings();
  const next = resetServerUiPref(key, profileState(config, key), scope, profileId);
  expect(next[key]).toBe(fallback);
  const delta = changedServerUiPrefs(previous, next);
  expect(delta).toEqual({ [key]: null, ...(key === "theme" ? clearedDesign : {}) });
  pushServerUiPrefs(writer, delta!, { ...hooks, afterCommit: committed });
  await waitForFast(() => expect(committed).toHaveBeenCalledOnce());
}

installServerPrefsStorage(scope);

it("publishes empty navigation without importing legacy profile entries or writing defaults", async () => {
  patchSettings({ sidebarEntries: ["route:usage"] });
  let published = loadSettings();
  const request = readRequest({ "ui.sidebarEntries": ["session:agent:main:legacy"] });
  const { options, refresh } = readProfile(request, {}, true);
  options.onApplied.mockImplementation(() => {
    published = loadSettings();
  });
  await refresh();
  expect(options.onApplied).toHaveBeenCalledOnce();
  expect(published.sidebarEntries).toEqual([]);
  expect(request.mock.calls.map(([method]) => method)).toEqual(["users.prefs.get"]);
});

it("preserves imported definitions and only resets design overrides when activation changes", () => {
  const customTheme = createImportedCustomThemeFixture();
  patchSettings({ theme: "dash", ...design, fontChat: "lora", customTheme, textScale: 125 });
  const selected = selectThemeSettings("custom");
  expect(selected.customTheme).toEqual(customTheme);
  expect(selected).toMatchObject({ ...clearedSelection, theme: "custom", textScale: 125 });
  const customized = patchSettings(design);
  expect(selectThemeSettings("custom", { customTheme })).toEqual(customized);
  expect(selectThemeSettings("claw", { customTheme: undefined })).toMatchObject({
    ...clearedSelection,
    customTheme: undefined,
  });
  patchSettings({ ...design, customTheme });
  expect(selectThemeSettings("claw", { customTheme: undefined })).toMatchObject(design);
});

it("retains the boot mirror while the profile is unresolved and unavailable", async () => {
  const config = configWithPrefs({ theme: "claw", themeMode: "light", chatShowThinking: false });
  const mirror = { theme: "rose" as const, themeMode: "dark" as const, accent: "#123456" };
  patchSettings(mirror);
  const lastSeenKey = `openclaw.control.serverPrefs.v1:${scope}:profile:${profileId}`;
  localStorage.setItem(lastSeenKey, JSON.stringify(mirror));
  const { promise, resolve } = createDeferred<unknown>();
  const { options, refresh } = readProfile(
    vi.fn(() => promise),
    config,
    true,
  );
  applyServerUiPrefs(config, options);
  const pending = refresh();
  const expected = { ...mirror, chatShowThinking: false };
  expect(loadSettings()).toMatchObject(expected);
  expect(JSON.parse(localStorage.getItem(lastSeenKey)!)).toEqual(expected);
  resolve({ status: "unavailable" });
  await pending;
  expect(loadSettings()).toMatchObject(expected);
});

it.each([
  ["theme", "rose", "absolutely"],
  ["fontUi", "geist", undefined],
] as const)("persists a %s reset during profile loading", async (key, saved, fallback) => {
  const preferenceKey = UI_APPEARANCE_PREFERENCE_KEYS[key];
  const config = configWithPrefs({ [key]: fallback });
  const savedEntries = { [preferenceKey]: saved };
  let entries: Record<string, string> = { ...savedEntries };
  await readProfile(readRequest(entries), config, true).refresh();
  resetServerUiPrefsSync();
  const delayed = createDeferred<unknown>();
  const reads = [delayed.promise];
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "users.prefs.get") {
      return reads.shift() ?? response(entries);
    }
    expect(method).toBe(key === "theme" ? "themes.set" : "users.prefs.set");
    expect(params).toEqual(
      key === "theme"
        ? { id: null, appearance: clearedDesign }
        : { entries: { [preferenceKey]: null } },
    );
    entries = key === "theme" ? { "ui.accent": "theme" } : {};
    return { status: "ok" };
  });
  const { writer, options, refresh } = readProfile(request, config);
  Object.assign(writer.state, { configSnapshot: { config } });
  applyServerUiPrefs(config, options);
  const pending = refresh();
  await waitForFast(() => expect(request).toHaveBeenCalledOnce());
  await resetProfile(writer, config, key, fallback);
  // users.prefs.changed forces a fresh read before an older response can publish.
  await refresh();
  delayed.resolve(response(savedEntries));
  await pending;
  expect(loadSettings()[key]).toBe(fallback);
  expect(entries).toEqual(key === "theme" ? { "ui.accent": "theme" } : {});

  resetServerUiPrefsSync();
  await readProfile(request, config, true).refresh();
  expect(loadSettings()[key]).toBe(fallback);
});

it.each([profileId, null])("cancels disconnected edits on reset (%s)", async (profileIdAtEdit) => {
  const config = configWithPrefs({ accent: "#abcdef" });
  const request = readRequest({ "ui.accent": "#123456" });
  const { writer, refresh } = readProfile(request, config, true);
  await refresh();
  Object.assign(writer.state, { connected: false });
  patchSettings({ accent: "#654321" });
  pushServerUiPrefs(writer, { accent: "#654321" }, { profileId: profileIdAtEdit, canWrite: true });
  const previous = loadSettings();
  const state = resolvePref(undefined, "accent", scope, previous, { canSync: null });
  const next = resetServerUiPref("accent", state, scope);
  expect(next.accent).toBe("#123456");
  expect(changedServerUiPrefs(previous, next)).toBeNull();
  resetServerUiPrefsSync();
  const { writer: reconnected, refresh: reconnect } = readProfile(request, config, true);
  flushServerUiPrefs(reconnected, { profileId: null, canWrite: true });
  flushServerUiPrefs(reconnected, { profileId, canWrite: true });
  await reconnect();
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "users.prefs.get",
    "users.prefs.get",
  ]);
  expect(loadSettings().accent).toBe("#123456");
});

it.each([false, true])("excludes profile fonts from offline=%s config writes", async (offline) => {
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
});

it("keeps pending local edits above incoming profile updates", async () => {
  const { promise: write, resolve: releaseWrite } = createDeferred<unknown>();
  let profileTheme = "knot";
  const request = vi.fn(async (method: string) =>
    method === "users.prefs.get" ? response({ "ui.theme": profileTheme }) : await write,
  );
  const config = configWithPrefs({ theme: "claw" });
  const { writer, refresh } = readProfile(request, config);
  await refresh();
  patchSettings({ theme: "dash" });
  const afterCommit = vi.fn();
  pushServerUiPrefs(writer, { theme: "dash" }, { ...hooks, afterCommit });
  await waitForFast(() => expect(request).toHaveBeenCalledWith("themes.set", { id: "dash" }));
  profileTheme = "absolutely";
  await refresh();
  expect(request.mock.calls.filter(([method]) => method === "users.prefs.get")).toHaveLength(2);
  expect(loadSettings().theme).toBe("dash");
  expect(profileState(config, "theme")).toMatchObject({ provenance: "pending", value: "dash" });
  releaseWrite({ status: "ok" });
  await waitForFast(() => expect(afterCommit).toHaveBeenCalledOnce());
  expect(profileState(config, "theme")).toMatchObject({ provenance: "profile", value: "dash" });
  Object.assign(writer.state, { configSnapshot: { config } });
  afterCommit.mockClear();
  await resetProfile(writer, config, "theme", "claw", afterCommit);
  expect(request).toHaveBeenLastCalledWith("themes.set", { id: null, appearance: clearedDesign });
  expect(profileState(config, "theme")).toMatchObject({ provenance: "synced", value: "claw" });
});

it("restores profile appearance across identity switches and a reload during a pending switch", async () => {
  const tabIcon = "agent";
  const config = configWithPrefs({ tabIcon: "default" });
  let activeProfile = "profile-b";
  const request = vi.fn(async () =>
    response(
      activeProfile === "profile-b"
        ? { "ui.theme": "knot" }
        : {
            "ui.theme": "rose",
            "ui.accent": "#123456",
            "ui.fontUi": "geist",
            "ui.tabIcon": tabIcon,
          },
    ),
  );
  const { options: initial } = readProfile(request, config, true);
  const options = (id: string) => ({ ...initial, profileId: id });
  await refreshPrefs(options(activeProfile));
  for (activeProfile of ["profile-a", "profile-b", "profile-a"]) {
    await refreshPrefs(options(activeProfile));
    const expectedIcon = activeProfile === "profile-a" ? tabIcon : undefined;
    expect(loadSettings().tabIcon).toBe(expectedIcon);
    expect(profileState(config, "tabIcon", { profileId: activeProfile })).toMatchObject({
      provenance: expectedIcon ? "profile" : "default",
      value: expectedIcon,
      resetValue: undefined,
    });
  }
  expect(loadSettings().theme).toBe("rose");
  activeProfile = "profile-b";
  applyServerUiPrefs(config, options(activeProfile));
  resetServerUiPrefsSync();
  applyServerUiPrefs(config, options(activeProfile));
  await refreshPrefs(options(activeProfile));
  expect(loadSettings()).toMatchObject({
    theme: "knot",
    accent: undefined,
    fontUi: undefined,
    tabIcon: undefined,
  });
});
it.each([false, true])("retains device-local appearance when rejected=%s", async (rejected) => {
  const entries = { "ui.theme": "knot", "ui.accent": "#123456", "ui.fontUi": "geist" };
  const request = vi.fn(async (method: string) => {
    if (method === "users.prefs.get") {
      return response(rejected ? entries : {});
    }
    throw new GatewayRequestError({ code: "INVALID_REQUEST", message: "Missing theme" });
  });
  const config = configWithPrefs({ theme: "claw" });
  const { writer, refresh } = readProfile(request, config);
  await refresh();
  if (rejected) {
    request.mockClear();
  }
  const local = rejected
    ? ({
        theme: "space-pack/xenovessel",
        themeMode: "dark",
        accent: "#654321",
        fontUi: undefined,
        fontChat: "lora",
      } as const)
    : { theme: "knot" as const };
  patchSettings(local);
  const afterCommit = vi.fn();
  pushServerUiPrefs(writer, rejected ? { ...local, fontUi: null } : local, {
    profileId,
    canWrite: rejected,
    afterCommit,
  });
  if (rejected) {
    await waitForFast(() => expect(afterCommit).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledExactlyOnceWith("themes.set", {
      id: "space-pack/xenovessel",
      mode: "dark",
      appearance: { accent: "#654321", fontUi: null, fontChat: "lora" },
    });
  } else {
    expect(request).toHaveBeenCalledOnce();
  }
  expect(afterCommit).toHaveBeenCalledWith({ needsRefresh: false, retainedLocal: true });
  expect(loadSettings()).toMatchObject(local);
  if (rejected) {
    await refresh();
    expect(loadSettings()).toMatchObject(local);
  }
  expect(profileState(config, "theme", { canSync: rejected ? undefined : false })).toMatchObject({
    provenance: "device-local",
    value: local.theme,
  });
});
