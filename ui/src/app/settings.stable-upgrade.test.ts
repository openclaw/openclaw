// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SIDEBAR_ENTRIES } from "../app-navigation.ts";
import { installSettingsStorageLifecycle, setTestLocation } from "../test-helpers/settings-node.ts";
import { createProfilePrefsServer } from "./server-prefs.test-support.ts";
import { flushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

const scope = "wss://gateway.example";
const settingsKey = "openclaw.control.settings.v1:" + scope;
const pendingKey = "openclaw.control.serverPrefs.pending.v1:" + scope + ":profile:a";
const group = { id: "first", label: "First", sessionKeys: ["agent:main:saved"] };
// Synthetic state captured with the v2026.10.6 production writers (commit
// fe06181dc5ecc01cf8904abbfc26925925efefbc): patchSettings, then an offline
// pushServerUiPrefs(changedServerUiPrefs(before, next)) for profile a.
// Add the later section layout and pending edit to exercise retirement alongside that older data.
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
  personalSessionGroups: [group],
};
installSettingsStorageLifecycle();
beforeEach(() => {
  resetServerUiPrefsSync();
  setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
  localStorage.setItem(settingsKey, JSON.stringify(stableSettings));
  localStorage.setItem("openclaw.control.currentGateway.v1:" + scope, scope);
  localStorage.setItem(
    pendingKey,
    JSON.stringify({
      fontUi: "geist",
      sidebarEntries: stableSettings.sidebarEntries,
      personalSessionGroups: [group],
    }),
  );
});
afterEach(async () => {
  resetServerUiPrefsSync();
  await vi.dynamicImportSettled();
});

it("preserves stable browser settings without reviving retired navigation when settings change", () => {
  expect(loadSettings()).toMatchObject({
    themeMode: "light",
    fontUi: "geist",
    navWidth: 320,
    locale: "de",
    pinnedAgentIds: ["research"],
    sessionKey: "agent:main:saved",
    sidebarEntries: DEFAULT_SIDEBAR_ENTRIES,
  });
  expect(loadSettings()).not.toHaveProperty("personalSessionGroups");
  patchSettings({ navWidth: 340 });
  expect(loadSettings()).toMatchObject({
    themeMode: "light",
    fontUi: "geist",
    navWidth: 340,
    locale: "de",
    pinnedAgentIds: ["research"],
    sessionKey: "agent:main:saved",
  });
  // docs/web/control-ui/settings.md documents the intentional sidebarEntries
  // retirement. Settings writes must neither delete its recoverable value nor promote
  // the old shared-navigation mirror into private pins.
  expect(JSON.parse(localStorage.getItem(settingsKey)!)).toMatchObject({
    sidebarEntries: ["session:agent:main:saved", "route:cron"],
    personalSessionGroups: [group],
  });
  expect(loadSettings().sidebarEntries).toEqual(DEFAULT_SIDEBAR_ENTRIES);
});

it.each(["stable", "personal-pins"])(
  "replays %s preferences without sending retired section edits",
  async (format) => {
    const syncedSections = [
      { id: "saved", label: "Saved on another device", sessionKeys: ["agent:main:server-only"] },
    ];
    const existingPins = ["route:usage", "session:agent:main:saved"];
    if (format === "personal-pins") {
      // Newer installations stored personal pins and sections in the same profile snapshot.
      localStorage.setItem(
        settingsKey,
        JSON.stringify({
          ...stableSettings,
          railShortcuts: ["route:cron"],
          navigationByProfile: {
            a: { railShortcuts: existingPins.toReversed(), personalSessionGroups: [group] },
          },
        }),
      );
      localStorage.setItem(
        pendingKey,
        JSON.stringify({
          fontUi: "geist",
          railShortcuts: existingPins.toReversed(),
          railShortcutsBase: existingPins,
          railShortcutsOrder: true,
          personalSessionGroups: [group],
        }),
      );
    }
    const backend = createProfilePrefsServer(
      {
        a: {
          "ui.themeMode": "light",
          "ui.fontUi": "lora",
          "ui.personalSessionGroups": syncedSections,
          "ui.railShortcuts": existingPins,
        },
      },
      scope,
    );
    const lastSeenKey = "openclaw.control.serverPrefs.v1:" + scope + ":profile:a";
    if (format === "personal-pins") {
      localStorage.setItem(lastSeenKey, JSON.stringify({ personalSessionGroups: [] }));
    }
    const a = backend.connect("a");
    await a.refresh();
    expect(loadSettings()).not.toHaveProperty("personalSessionGroups");
    flushServerUiPrefs(a.writer, { profileId: "a", canWrite: true });
    await vi.dynamicImportSettled();
    expect(backend.profiles.a).toEqual({
      "ui.themeMode": "light",
      "ui.fontUi": "geist",
      "ui.personalSessionGroups": syncedSections,
      "ui.railShortcuts": format === "personal-pins" ? existingPins.toReversed() : existingPins,
    });
    expect(localStorage.getItem(pendingKey)).toBeNull();
    if (format === "personal-pins") {
      expect(JSON.parse(localStorage.getItem(lastSeenKey)!)).toHaveProperty(
        "personalSessionGroups",
        [],
      );
      expect(
        JSON.parse(localStorage.getItem(settingsKey)!).navigationByProfile.a.personalSessionGroups,
      ).toEqual([group]);
    }
    resetServerUiPrefsSync();
    await backend.connect("a").refresh();
    expect(loadSettings()).toMatchObject({
      fontUi: "geist",
      pinnedAgentIds: ["research"],
      navWidth: 320,
      sidebarEntries: format === "personal-pins" ? existingPins.toReversed() : existingPins,
    });
  },
);
