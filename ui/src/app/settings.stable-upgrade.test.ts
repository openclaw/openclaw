// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installSettingsStorageLifecycle, setTestLocation } from "../test-helpers/settings-node.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import { createProfilePrefsServer } from "./server-prefs.test-support.ts";
import { pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

const scope = "wss://gateway.example";
const settingsKey = "openclaw.control.settings.v1:" + scope;
const pendingKey = "openclaw.control.serverPrefs.pending.v1:" + scope + ":profile:a";
const group = { id: "first", label: "First", sessionKeys: ["agent:main:saved"] };
// Synthetic state captured with the v2026.10.6 production writers (commit
// fe06181dc5ecc01cf8904abbfc26925925efefbc): patchSettings, then an offline
// pushServerUiPrefs(changedServerUiPrefs(before, next)) for profile a.
// This is a production-owner storage fixture, not a shipped-app upgrade test.
const stableSettings = {
  gatewayUrl: scope,
  theme: "claw",
  themeMode: "light",
  fontUi: "geist",
  chatShowThinking: true,
  chatShowToolCalls: true,
  chatPersistCommentary: true,
  navWidth: 320,
  sidebarAgentsMode: "chip",
  sidebarEntries: ["session:agent:main:saved", "route:cron"],
  pinnedAgentIds: ["research"],
  sessionsByGateway: {
    [scope]: { sessionKey: "agent:main:saved", lastActiveSessionKey: "agent:main:saved" },
  },
  locale: "de",
};
installSettingsStorageLifecycle();
beforeEach(() => {
  resetServerUiPrefsSync();
  setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
  localStorage.setItem(settingsKey, JSON.stringify(stableSettings));
  localStorage.setItem("openclaw.control.currentGateway.v1:" + scope, scope);
  localStorage.setItem(
    pendingKey,
    JSON.stringify({ fontUi: "geist", sidebarEntries: stableSettings.sidebarEntries }),
  );
});
afterEach(async () => {
  resetServerUiPrefsSync();
  await vi.dynamicImportSettled();
});

it("preserves stable browser settings without reviving retired navigation when groups are first saved", () => {
  expect(loadSettings()).toMatchObject({
    themeMode: "light",
    fontUi: "geist",
    navWidth: 320,
    locale: "de",
    pinnedAgentIds: ["research"],
    sessionKey: "agent:main:saved",
    sidebarEntries: [],
    personalSessionGroups: [],
  });
  patchSettings({ personalSessionGroups: [group] });
  expect(loadSettings()).toMatchObject({
    themeMode: "light",
    fontUi: "geist",
    navWidth: 320,
    locale: "de",
    pinnedAgentIds: ["research"],
    sessionKey: "agent:main:saved",
    personalSessionGroups: [group],
  });
  // docs/web/control-ui/settings.md documents the intentional sidebarEntries
  // retirement. Group edits must neither delete its recoverable value nor promote
  // the old shared-navigation mirror into private pins.
  expect(JSON.parse(localStorage.getItem(settingsKey)!)).toMatchObject({
    sidebarEntries: ["session:agent:main:saved", "route:cron"],
  });
  expect(loadSettings().sidebarEntries).toEqual([]);
});

it.each(["stable", "personal-pins"])(
  "replays pre-group %s preference intent while saving only the new group field",
  async (format) => {
    const existingPins = ["route:usage", "session:agent:main:saved"];
    if (format === "personal-pins") {
      // The immediately preceding navigation owner already used this identity,
      // unlike stable sidebarEntries. Its profile records have no groups field.
      localStorage.setItem(
        settingsKey,
        JSON.stringify({
          ...stableSettings,
          railShortcuts: ["route:cron"],
          navigationByProfile: { a: { railShortcuts: existingPins.toReversed() } },
        }),
      );
      localStorage.setItem(
        pendingKey,
        JSON.stringify({
          fontUi: "geist",
          railShortcuts: existingPins.toReversed(),
          railShortcutsBase: existingPins,
          railShortcutsOrder: true,
        }),
      );
    }
    const backend = createProfilePrefsServer(
      {
        a: {
          "ui.themeMode": "light",
          "ui.fontUi": "lora",
          "ui.railShortcuts": existingPins,
        },
      },
      scope,
    );
    const a = backend.connect("a");
    await a.refresh();
    expect(loadSettings()).toMatchObject({ fontUi: "geist", personalSessionGroups: [] });
    const before = loadSettings();
    const next = patchSettings({ personalSessionGroups: [group] });
    const delta = changedServerUiPrefs(before, next)!;
    expect(delta).toEqual({ personalSessionGroups: [group] });
    pushServerUiPrefs(a.writer, delta, { profileId: "a", canWrite: true });
    await vi.dynamicImportSettled();
    expect(backend.profiles.a).toEqual({
      "ui.themeMode": "light",
      "ui.fontUi": "geist",
      "ui.railShortcuts": format === "personal-pins" ? existingPins.toReversed() : existingPins,
      "ui.personalSessionGroups": [group],
    });
    expect(localStorage.getItem(pendingKey)).toBeNull();
    resetServerUiPrefsSync();
    await backend.connect("a").refresh();
    expect(loadSettings()).toMatchObject({
      personalSessionGroups: [group],
      fontUi: "geist",
      pinnedAgentIds: ["research"],
      navWidth: 320,
      sidebarEntries: format === "personal-pins" ? existingPins.toReversed() : existingPins,
    });
  },
);
