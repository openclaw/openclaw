// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SIDEBAR_ENTRIES } from "../app-navigation.ts";
import { installSettingsStorageLifecycle, setTestLocation } from "../test-helpers/settings-node.ts";
import { createApplicationNavigationPreferences } from "./bootstrap-navigation-preferences.ts";
import { createApplicationTheme } from "./bootstrap-theme.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import { applyServerUiPrefs, refreshProfileAppearancePrefs } from "./server-prefs-reconcile.ts";
import {
  configWithPrefs,
  createProfilePrefsServer,
  createServerPrefsWriter,
} from "./server-prefs.test-support.ts";
import { flushServerUiPrefs, pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings, settingsKeyForGateway } from "./settings.ts";
import { invalidateUserPreferences } from "./user-prefs-cache.ts";

installSettingsStorageLifecycle();
const scope = "wss://gateway.example";
const pinsKey = "ui.railShortcuts";
beforeEach(() => {
  resetServerUiPrefsSync();
  setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
  patchSettings({ gatewayUrl: scope });
});
afterEach(async () => {
  resetServerUiPrefsSync();
  await vi.dynamicImportSettled();
});

function siblingSave(profileId: string, sidebarEntries: string[]) {
  const key = settingsKeyForGateway(scope);
  const stored = JSON.parse(localStorage.getItem(key)!);
  // Exercise a sibling writer using the record shape actually produced by this build.
  const next = stored.navigationByProfile
    ? {
        ...stored,
        navigationByProfile: {
          ...stored.navigationByProfile,
          [profileId]: { railShortcuts: sidebarEntries },
        },
      }
    : { ...stored, railShortcuts: sidebarEntries };
  localStorage.setItem(key, JSON.stringify(next));
  return key;
}

it("ignores retired scope preferences in browser and profile storage", async () => {
  const key = settingsKeyForGateway(scope);
  localStorage.setItem(
    key,
    JSON.stringify({
      gatewayUrl: scope,
      railShortcuts: ["route:cron"],
      navigationScope: "all",
      navigationByProfile: { a: { railShortcuts: ["route:usage"], navigationScope: "all" } },
    }),
  );
  expect(loadSettings()).not.toHaveProperty("navigationScope");
  expect(loadSettings().sidebarEntries).toEqual(["route:cron"]);

  const a = createProfilePrefsServer(
    { a: { [pinsKey]: ["route:usage"], "ui.navigationScope": "all" } },
    scope,
  ).connect("a");
  await a.refresh();
  expect(loadSettings()).not.toHaveProperty("navigationScope");
  expect(loadSettings().sidebarEntries).toEqual(["route:usage"]);
  const before = loadSettings();
  const next = patchSettings({ sidebarEntries: ["route:plugins"] });
  pushServerUiPrefs(a.writer, changedServerUiPrefs(before, next)!, {
    profileId: "a",
    canWrite: true,
  });
  await vi.dynamicImportSettled();
  expect(a.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toEqual([
    [
      "users.prefs.set",
      {
        entries: { [pinsKey]: ["route:plugins"] },
        expectedEntries: { [pinsKey]: ["route:usage"] },
      },
    ],
  ]);
});

it.each([false, true])(
  "publishes same-profile sibling navigation and preserves it during resize (event first=%s)",
  async (eventFirst) => {
    const backend = createProfilePrefsServer({ a: { [pinsKey]: ["route:usage"] } }, scope);
    await backend.connect("a").refresh();
    const events = new EventTarget();
    vi.stubGlobal("addEventListener", events.addEventListener.bind(events));
    vi.stubGlobal("removeEventListener", events.removeEventListener.bind(events));
    const initial = loadSettings();
    const { gateway } = createGatewayStoreTestStore({ settings: initial });
    const theme = createApplicationTheme(initial, gateway);
    const navigation = createApplicationNavigationPreferences(theme);
    const changed = vi.fn();
    const stop = navigation.subscribe(changed);
    try {
      const key = siblingSave("a", ["route:cron"]);
      if (eventFirst) {
        events.dispatchEvent(Object.assign(new Event("storage"), { key }));
        expect(changed).toHaveBeenCalledWith(
          expect.objectContaining({ sidebarEntries: ["route:cron"] }),
        );
      }
      navigation.update({ navWidth: 320 });
      expect(navigation.snapshot).toMatchObject({
        navWidth: 320,
        sidebarEntries: ["route:cron"],
      });
      expect(loadSettings()).toMatchObject({
        navWidth: 320,
        sidebarEntries: ["route:cron"],
      });
      changed.mockClear();
      siblingSave("b", ["session:private-b"]);
      events.dispatchEvent(Object.assign(new Event("storage"), { key }));
      expect(changed).not.toHaveBeenCalled();
      navigation.update({ navWidth: 340 });
      expect(JSON.parse(localStorage.getItem(key)!).navigationByProfile.b).toEqual({
        railShortcuts: ["session:private-b"],
      });
      expect(navigation.snapshot.sidebarEntries).toEqual(["route:cron"]);
    } finally {
      stop();
      theme.dispose();
      gateway.stop();
    }
  },
);

it.each([false, true])(
  "keeps read-only navigation through profile switches and reload (reload=%s)",
  async (reload) => {
    const backend = createProfilePrefsServer(
      {
        a: { [pinsKey]: ["route:usage"] },
        b: { [pinsKey]: ["route:systems"] },
      },
      scope,
    );
    const a = backend.connect("a");
    const b = backend.connect("b");
    const onApplied = vi.fn();
    const refresh = (profileId: string, writer: typeof a.writer) =>
      refreshProfileAppearancePrefs({
        client: writer.state.client!,
        profileId,
        scope,
        configObject: {},
        onApplied,
      });
    await refresh("a", a.writer);
    const previous = loadSettings();
    const next = patchSettings({ sidebarEntries: [] });
    pushServerUiPrefs(a.writer, changedServerUiPrefs(previous, next)!, {
      profileId: "a",
      canWrite: false,
    });
    await vi.dynamicImportSettled();
    if (reload) {
      resetServerUiPrefsSync();
    }
    await refresh("b", b.writer);
    expect(loadSettings().sidebarEntries).toEqual(["route:systems"]);
    onApplied.mockClear();
    await refresh("a", a.writer);
    expect(loadSettings()).toMatchObject({ sidebarEntries: [] });
    expect(onApplied).toHaveBeenCalledWith(expect.objectContaining({ sidebarEntries: [] }));
    backend.profiles.a![pinsKey] = ["route:cron"];
    invalidateUserPreferences(a.writer.state.client!);
    await refresh("a", a.writer);
    expect(loadSettings()).toMatchObject({
      sidebarEntries: ["route:cron"],
    });
    expect(a.request.mock.calls.some(([method]) => method === "users.prefs.set")).toBe(false);
  },
);

it("keeps dirty local navigation through storage failures without replaying unchanged sibling snapshots", async () => {
  const backend = createProfilePrefsServer(
    { a: { [pinsKey]: ["route:usage"] }, b: { [pinsKey]: ["route:systems"] } },
    scope,
  );
  const a = backend.connect("a");
  const b = backend.connect("b");
  await a.refresh();
  await b.refresh();
  await a.refresh();
  const key = settingsKeyForGateway(scope);
  const persist = localStorage.setItem.bind(localStorage);
  const deniedWrite = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  patchSettings({ sidebarEntries: [] });
  persist(
    settingsKeyForGateway("wss://other.example"),
    JSON.stringify({ gatewayUrl: "wss://other.example", railShortcuts: ["route:systems"] }),
  );
  expect(loadSettings("wss://other.example").sidebarEntries).toEqual(["route:systems"]);
  expect(loadSettings(scope).sidebarEntries).toEqual([]);
  await b.refresh();
  await a.refresh();
  const stored = JSON.parse(localStorage.getItem(key)!);
  persist(
    key,
    JSON.stringify({
      ...stored,
      navigationByProfile: {
        ...stored.navigationByProfile,
        b: { railShortcuts: ["route:plugins"] },
      },
    }),
  );
  deniedWrite.mockRestore();
  patchSettings({ navWidth: 320 });
  expect(JSON.parse(localStorage.getItem(key)!).navigationByProfile).toMatchObject({
    a: { railShortcuts: [] },
    b: { railShortcuts: ["route:plugins"] },
  });
  const deniedRead = vi.spyOn(localStorage, "getItem").mockImplementation(() => {
    throw new Error("private storage");
  });
  const writes = vi.spyOn(localStorage, "setItem");
  expect(loadSettings().sidebarEntries).toEqual([]);
  patchSettings({ sidebarEntries: ["route:cron"] });
  expect(writes).not.toHaveBeenCalled();
  expect(loadSettings()).toMatchObject({ sidebarEntries: ["route:cron"] });
  deniedRead.mockRestore();
  writes.mockRestore();
  siblingSave("b", ["route:usage"]);
  patchSettings({ navWidth: 340 });
  expect(JSON.parse(localStorage.getItem(key)!).navigationByProfile).toEqual({
    a: { railShortcuts: ["route:cron"] },
    b: { railShortcuts: ["route:usage"] },
  });
});

it.each([false, true])(
  "ignores legacy mirrors and preserves them through a rail edit (quota=%s)",
  async (quota) => {
    const backend = createProfilePrefsServer({ a: { [pinsKey]: ["route:usage"] } }, scope);
    await backend.connect("a").refresh();
    const key = settingsKeyForGateway(scope);
    const stored = JSON.parse(localStorage.getItem(key)!);
    const legacyEntries = ["route:usage", "plugin:workboard/workboard", "session:private-a"];
    localStorage.setItem(
      key,
      JSON.stringify({
        ...stored,
        sidebarEntries: legacyEntries,
        navigationByProfile: {
          ...stored.navigationByProfile,
          "new-profile": { sidebarEntries: legacyEntries },
        },
      }),
    );
    const onApplied = vi.fn();
    applyServerUiPrefs({}, { scope, profileId: "new-profile", onApplied });
    expect(loadSettings()).toMatchObject({
      sidebarEntries: DEFAULT_SIDEBAR_ENTRIES,
    });
    expect(onApplied).toHaveBeenCalledWith(
      expect.objectContaining({ sidebarEntries: DEFAULT_SIDEBAR_ENTRIES }),
    );
    const deniedWrite = quota
      ? vi.spyOn(localStorage, "setItem").mockImplementation(() => {
          throw new Error("quota");
        })
      : null;
    patchSettings({ sidebarEntries: ["session:agent:main:added"] });
    expect(loadSettings().sidebarEntries).toEqual(["session:agent:main:added"]);
    deniedWrite?.mockRestore();
    patchSettings({ navWidth: 320 });
    expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({
      sidebarEntries: legacyEntries,
      navigationByProfile: {
        "new-profile": {
          sidebarEntries: legacyEntries,
          railShortcuts: ["session:agent:main:added"],
        },
      },
    });
  },
);

it.each([
  { destination: scope, localPins: ["route:systems"] },
  { destination: scope, localPins: [] },
  { destination: "wss://other.example", localPins: ["route:systems"] },
  { destination: "wss://other.example", localPins: [] },
])(
  "preserves profileless navigation through A → $destination → A ($localPins)",
  async ({ destination, localPins }) => {
    patchSettings({ gatewayUrl: destination, sidebarEntries: localPins });
    const request = vi.fn(async () => ({}));
    const profileless = createServerPrefsWriter(request, destination, true, { ok: true }, false);
    const adopt = () => {
      flushServerUiPrefs(profileless, { profileId: null, canWrite: false });
      return applyServerUiPrefs({}, { scope: destination, profileId: null, onApplied });
    };
    const onApplied = vi.fn();
    adopt();
    expect(loadSettings(destination)).toMatchObject({
      sidebarEntries: localPins,
    });
    patchSettings({ gatewayUrl: scope });
    const a = createProfilePrefsServer({ a: { [pinsKey]: ["session:private-a"] } }, scope).connect(
      "a",
    );
    await a.refresh();
    flushServerUiPrefs(a.writer, { profileId: "a", canWrite: true });
    expect(loadSettings(scope).sidebarEntries).toEqual(["session:private-a"]);
    patchSettings({ gatewayUrl: destination });
    onApplied.mockClear();
    adopt();
    expect(loadSettings(destination)).toMatchObject({
      sidebarEntries: localPins,
    });
    expect(onApplied).toHaveBeenCalledWith(expect.objectContaining({ sidebarEntries: localPins }));
    patchSettings({ gatewayUrl: scope });
    flushServerUiPrefs(a.writer, { profileId: "a", canWrite: true });
    await a.refresh();
    expect(loadSettings(scope).sidebarEntries).toEqual(["session:private-a"]);
    expect(JSON.parse(localStorage.getItem(settingsKeyForGateway(destination))!)).toMatchObject({
      railShortcuts: localPins,
    });
    expect(request).not.toHaveBeenCalled();
  },
);

it("does not promote private pins into a never-saved profileless browser snapshot", async () => {
  const a = createProfilePrefsServer({ a: { [pinsKey]: ["session:private-a"] } }, scope).connect(
    "a",
  );
  await a.refresh();
  flushServerUiPrefs(a.writer, { profileId: "a", canWrite: true });
  const request = vi.fn(async () => ({}));
  const profileless = createServerPrefsWriter(request, scope, true, { ok: true }, false);
  flushServerUiPrefs(profileless, { profileId: null, canWrite: false });
  applyServerUiPrefs({}, { scope, profileId: null, onApplied: vi.fn() });
  expect(loadSettings(scope)).toMatchObject({
    sidebarEntries: DEFAULT_SIDEBAR_ENTRIES,
  });
  expect(request).not.toHaveBeenCalled();
});

it.each([{ localPins: ["route:cron"] }, { localPins: [] }])(
  "preserves profileless shortcuts on upgrade from shared last-seen navigation (%j)",
  ({ localPins }) => {
    patchSettings({ sidebarEntries: localPins });
    localStorage.setItem(
      "openclaw.control.serverPrefs.v1:" + scope,
      JSON.stringify({ sidebarEntries: ["route:usage"] }),
    );
    const onApplied = vi.fn();
    const config = configWithPrefs({ sidebarEntries: ["route:usage"] });
    applyServerUiPrefs(config, { scope, profileId: null, onApplied });
    expect(loadSettings(scope)).toMatchObject({
      sidebarEntries: localPins,
    });
    applyServerUiPrefs(configWithPrefs({ sidebarEntries: ["route:usage"], locale: "de" }), {
      scope,
      profileId: null,
      onApplied,
    });
    expect(loadSettings(scope)).toMatchObject({
      sidebarEntries: localPins,
      locale: "de",
    });
  },
);

it.each(["reload", "profile-switch"])(
  "applies a changed confirmed pin list before consuming local retention after %s",
  async (transition) => {
    const backend = createProfilePrefsServer(
      {
        a: { [pinsKey]: ["route:usage"] },
        b: { [pinsKey]: ["route:systems"] },
      },
      scope,
    );
    const a = backend.connect("a");
    const refresh = () =>
      refreshProfileAppearancePrefs({
        client: a.writer.state.client!,
        profileId: "a",
        scope,
        configObject: {},
        onApplied: vi.fn(),
      });
    await refresh();
    const previous = loadSettings(scope);
    const local = patchSettings({ sidebarEntries: [] });
    pushServerUiPrefs(a.writer, changedServerUiPrefs(previous, local)!, {
      profileId: "a",
      canWrite: false,
    });
    if (transition === "reload") {
      resetServerUiPrefsSync();
    } else {
      await backend.connect("b").refresh();
    }
    backend.profiles.a![pinsKey] = ["route:cron"];
    invalidateUserPreferences(a.writer.state.client!);
    await refresh();
    expect(loadSettings(scope)).toMatchObject({
      sidebarEntries: ["route:cron"],
    });
    await refresh();
    expect(loadSettings(scope).sidebarEntries).toEqual(["route:cron"]);
    expect(a.request.mock.calls.some(([method]) => method === "users.prefs.set")).toBe(false);
  },
);
