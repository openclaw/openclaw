// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { USER_PREFS_VALUE_BYTES } from "../../../packages/gateway-protocol/src/schema/user-profile-constants.ts";
import { normalizePersonalSessionGroups } from "../lib/sessions/personal-groups.ts";
import { installSettingsStorageLifecycle, setTestLocation } from "../test-helpers/settings-node.ts";
import { createApplicationNavigationPreferences } from "./bootstrap-navigation-preferences.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import { rememberProfileAppearanceIdentity } from "./server-prefs-profile.ts";
import { applyServerUiPrefs } from "./server-prefs-reconcile.ts";
import {
  configWithPrefs,
  createProfilePrefsServer,
  createServerPrefsWriter,
} from "./server-prefs.test-support.ts";
import { flushServerUiPrefs, pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings, settingsKeyForGateway } from "./settings.ts";

const scope = "wss://gateway.example";
const groupsKey = "ui.personalSessionGroups";
const group = (id: string) => ({ id, label: id, sessionKeys: ["agent:main:" + id] });
installSettingsStorageLifecycle();
beforeEach(() => {
  resetServerUiPrefsSync();
  setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
  patchSettings({ gatewayUrl: scope });
});
afterEach(async () => {
  resetServerUiPrefsSync();
  await vi.dynamicImportSettled();
});

it("normalizes browser input and serializes only bounded labels and references", () => {
  const input = [
    {
      id: " a ",
      label: " Projects ",
      sessionKeys: [" key ", "key", "", 42],
      title: "not persisted",
    },
    { id: "a", label: "duplicate", sessionKeys: [] },
    { id: "empty", label: " ", sessionKeys: [] },
    { id: "b", label: "x".repeat(100), sessionKeys: ["other"] },
  ];
  const stored = { gatewayUrl: scope, personalSessionGroups: input };
  localStorage.setItem(settingsKeyForGateway(scope), JSON.stringify(stored));
  expect(loadSettings().personalSessionGroups).toEqual([
    { id: "a", label: "Projects", sessionKeys: ["key"] },
    { id: "b", label: "x".repeat(80), sessionKeys: ["other"] },
  ]);
  const oversized = Array.from({ length: 110 }, (_, index) => ({
    id: "group-" + index,
    label: "🐚".repeat(40),
    sessionKeys: Array.from({ length: 510 }, (_entry, key) => "session-" + key + "🐚".repeat(20)),
  }));
  const next = patchSettings({ personalSessionGroups: oversized });
  const groups = next.personalSessionGroups!;
  expect(groups.length).toBeGreaterThan(0);
  expect(groups.length).toBeLessThanOrEqual(100);
  expect(new TextEncoder().encode(JSON.stringify(groups)).length).toBeLessThanOrEqual(
    USER_PREFS_VALUE_BYTES,
  );
  expect(normalizePersonalSessionGroups(groups)).toEqual(groups);
  expect(loadSettings().personalSessionGroups).toEqual(groups);
});

it("keeps groups scoped across profile adoption, sign-out, and gateways", async () => {
  patchSettings({ personalSessionGroups: [group("browser")] });
  const backend = createProfilePrefsServer({ a: { [groupsKey]: [group("a")] }, b: {} }, scope);
  const a = backend.connect("a");
  const b = backend.connect("b");
  await a.refresh();
  expect(loadSettings().personalSessionGroups).toEqual([group("a")]);
  rememberProfileAppearanceIdentity(scope, "b");
  applyServerUiPrefs({}, { scope, profileId: "b", onApplied: vi.fn() });
  expect(loadSettings().personalSessionGroups).toEqual([]);
  await b.refresh();
  expect(loadSettings().personalSessionGroups).toEqual([]);
  patchSettings({ personalSessionGroups: [group("local-b")] });
  await a.refresh();
  expect(loadSettings().personalSessionGroups).toEqual([group("a")]);
  await b.refresh();
  expect(loadSettings().personalSessionGroups).toEqual([group("local-b")]);
  applyServerUiPrefs(configWithPrefs({ personalSessionGroups: [group("shared-invalid")] }), {
    scope,
    profileId: null,
    onApplied: vi.fn(),
  });
  expect(loadSettings().personalSessionGroups).toEqual([group("browser")]);
  const other = "wss://other.example";
  patchSettings({ gatewayUrl: other });
  expect(loadSettings(other).personalSessionGroups).toEqual([]);
  patchSettings({ personalSessionGroups: [group("other")] });
  expect(loadSettings(scope).personalSessionGroups).toEqual([group("browser")]);
});

it.each([false, true])(
  "group and pin edits preserve sibling fields (storage failure=%s)",
  async (failStorage) => {
    const a = createProfilePrefsServer(
      { a: { "ui.railShortcuts": ["route:usage"], [groupsKey]: [group("old")] } },
      scope,
    ).connect("a");
    await a.refresh();
    const navigation = createApplicationNavigationPreferences({
      get settings() {
        return loadSettings();
      },
      subscribe: () => () => {},
    });
    const persist = localStorage.setItem.bind(localStorage);
    const denied = failStorage
      ? vi.spyOn(localStorage, "setItem").mockImplementation(() => {
          throw new Error("quota");
        })
      : null;
    navigation.update({ personalSessionGroups: [group("new")] });
    const key = settingsKeyForGateway(scope);
    const stored = JSON.parse(localStorage.getItem(key)!);
    persist(
      key,
      JSON.stringify({
        ...stored,
        navigationByProfile: {
          ...stored.navigationByProfile,
          a: { ...stored.navigationByProfile.a, railShortcuts: ["route:cron"] },
        },
      }),
    );
    denied?.mockRestore();
    navigation.update({ navWidth: 320 });
    expect(navigation.snapshot).toMatchObject({
      sidebarEntries: ["route:cron"],
      personalSessionGroups: [group("new")],
    });
    navigation.update({ sidebarEntries: ["route:plugins"] });
    expect(loadSettings().personalSessionGroups).toEqual([group("new")]);
    expect(
      changedServerUiPrefs(loadSettings(), {
        ...loadSettings(),
        personalSessionGroups: structuredClone([group("new")]),
      }),
    ).toBeNull();
  },
);

it.each([null, "guest"])(
  "keeps read-only edits browser-local for profile %s",
  async (profileId) => {
    const request = vi.fn(async () => ({}));
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    flushServerUiPrefs(writer, { profileId, canWrite: false });
    const before = loadSettings();
    const next = patchSettings({ personalSessionGroups: [group("guest")] });
    pushServerUiPrefs(writer, changedServerUiPrefs(before, next)!, { profileId, canWrite: false });
    await vi.dynamicImportSettled();
    expect(request).not.toHaveBeenCalled();
    expect(loadSettings().personalSessionGroups).toEqual([group("guest")]);
    expect(
      localStorage.getItem(
        "openclaw.control.serverPrefs.pending.v1:" +
          scope +
          (profileId ? ":profile:" + profileId : ""),
      ),
    ).toBeNull();
  },
);
