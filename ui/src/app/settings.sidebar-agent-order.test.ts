// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { USER_PREFS_VALUE_BYTES } from "../../../packages/gateway-protocol/src/schema/user-profile-constants.ts";
import { installSettingsStorageLifecycle, setTestLocation } from "../test-helpers/settings-node.ts";
import { createApplicationNavigationPreferences } from "./bootstrap-navigation-preferences.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import { applyServerUiPrefs } from "./server-prefs-reconcile.ts";
import { configWithPrefs, createProfilePrefsServer } from "./server-prefs.test-support.ts";
import { pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings, settingsKeyForGateway } from "./settings.ts";

const scope = "wss://gateway.example";
const orderKey = "ui.sidebarAgentOrder";
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

it("normalizes saved agent IDs without inventing main or discarding unavailable agents", () => {
  localStorage.setItem(
    settingsKeyForGateway(scope),
    JSON.stringify({
      gatewayUrl: scope,
      sidebarAgentOrder: [" Research ", "research", "", "!", 42, "unavailable", "MAIN"],
    }),
  );
  expect(loadSettings().sidebarAgentOrder).toEqual(["research", "unavailable", "main"]);
  const next = patchSettings({
    sidebarAgentOrder: Array.from({ length: 1000 }, (_, index) => "agent-" + index),
  });
  expect(next.sidebarAgentOrder!.length).toBeGreaterThan(0);
  expect(
    new TextEncoder().encode(JSON.stringify(next.sidebarAgentOrder)).length,
  ).toBeLessThanOrEqual(USER_PREFS_VALUE_BYTES);
  expect(loadSettings().sidebarAgentOrder).toEqual(next.sidebarAgentOrder);
  patchSettings({ sidebarAgentOrder: [] });
  expect(loadSettings().sidebarAgentOrder).toEqual([]);
});

it("syncs personal order and reset across devices without changing another profile or shortcuts", async () => {
  patchSettings({ sidebarAgentOrder: ["browser"] });
  const backend = createProfilePrefsServer(
    { a: { "ui.railShortcuts": ["route:usage"] }, b: { [orderKey]: ["other"] } },
    scope,
  );
  const a = backend.connect("a");
  await a.refresh();
  const before = loadSettings();
  const next = patchSettings({ sidebarAgentOrder: ["research", "main"] });
  pushServerUiPrefs(a.writer, changedServerUiPrefs(before, next)!, {
    profileId: "a",
    canWrite: true,
  });
  await vi.dynamicImportSettled();
  expect(backend.profiles.a).toEqual({
    "ui.railShortcuts": ["route:usage"],
    [orderKey]: ["research", "main"],
  });
  await backend.connect("b").refresh();
  expect(loadSettings().sidebarAgentOrder).toEqual(["other"]);
  await a.refresh();
  expect(loadSettings().sidebarAgentOrder).toEqual(["research", "main"]);
  applyServerUiPrefs(configWithPrefs({ sidebarAgentOrder: ["shared-invalid"] }), {
    scope,
    profileId: null,
    onApplied: vi.fn(),
  });
  expect(loadSettings().sidebarAgentOrder).toEqual(["browser"]);
  resetServerUiPrefsSync();
  localStorage.clear();
  patchSettings({ gatewayUrl: scope });
  const second = backend.connect("a");
  await second.refresh();
  expect(loadSettings().sidebarAgentOrder).toEqual(["research", "main"]);
  const saved = loadSettings();
  const reset = patchSettings({ sidebarAgentOrder: [] });
  pushServerUiPrefs(second.writer, changedServerUiPrefs(saved, reset)!, {
    profileId: "a",
    canWrite: true,
  });
  await vi.dynamicImportSettled();
  expect(backend.profiles.a![orderKey]).toEqual([]);
  expect(backend.profiles.b![orderKey]).toEqual(["other"]);
  resetServerUiPrefsSync();
  localStorage.clear();
  patchSettings({ gatewayUrl: scope });
  await backend.connect("a").refresh();
  expect(loadSettings().sidebarAgentOrder).toEqual([]);
});

it.each([false, true])(
  "agent order and sibling shortcut edits stay independent (storage failure=%s)",
  async (failStorage) => {
    await createProfilePrefsServer(
      { a: { "ui.railShortcuts": ["route:usage"], [orderKey]: ["main", "research"] } },
      scope,
    )
      .connect("a")
      .refresh();
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
    navigation.update({ sidebarAgentOrder: ["research", "main"] });
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
      sidebarAgentOrder: ["research", "main"],
      sidebarEntries: ["route:cron"],
    });
    navigation.update({ sidebarEntries: ["route:plugins"] });
    expect(loadSettings().sidebarAgentOrder).toEqual(["research", "main"]);
  },
);
