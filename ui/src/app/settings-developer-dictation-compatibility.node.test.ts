// @vitest-environment node
import { beforeEach, expect, it } from "vitest";
import {
  loadChatComposerState,
  persistChatComposerState,
} from "../pages/chat/composer-draft-storage.ts";
import type { ChatComposerPersistenceState } from "../pages/chat/composer-persistence-state.ts";
import { installSettingsStorageLifecycle, setTestLocation } from "../test-helpers/settings-node.ts";
import { DEFAULT_DEVELOPER_DICTATION_SETTINGS } from "./settings-developer-dictation.ts";
import { loadSettings, patchSettings } from "./settings.ts";

const gatewayUrl = "wss://gateway.example";
const sessionKey = "agent:main:compatibility";
const settingsKey = "openclaw.control.settings.v1:wss://gateway.example";
const otherSettingsKey = "openclaw.control.settings.v1:wss://other.example";
const draftKey =
  "openclaw.control.chatComposer.v4:wss%3A%2F%2Fgateway.example:account:stable-account";

// Captured from the published v2026.11.10 Control UI after setting these preferences
// through its UI, then reloading a saved draft. Only the synthetic Gateway origin
// is rebased below. The artifact's settings owner is pinned here:
// https://github.com/openclaw/openclaw/blob/6ea542fd97e2876aa4c871ccc494ed5419a03c5c/ui/src/app/settings.ts
// This owner test does not itself run a binary upgrade.
const existingPreferences = {
  theme: "claw",
  themeMode: "dark",
  chatShowThinking: true,
  chatShowToolCalls: true,
  chatPersistCommentary: true,
  chatSendShortcut: "modifier-enter",
  navWidth: 258,
  sidebarAgentsMode: "chip",
  textScale: 125,
};
const navigationByProfile = {
  "compatibility-owner": { railShortcuts: [], personalSessionGroups: [] },
};

installSettingsStorageLifecycle();
beforeEach(() => setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" }));

it("keeps stable-version preferences and unsent drafts usable when toggling syntax review", () => {
  const sessionsByGateway = {
    [gatewayUrl]: {
      sessionKey,
      lastActiveSessionKey: sessionKey,
      selectedAgentId: "main",
    },
  };
  localStorage.setItem(
    settingsKey,
    JSON.stringify({
      gatewayUrl,
      ...existingPreferences,
      navigationByProfile,
      sessionsByGateway,
    }),
  );
  const otherStored = JSON.stringify({ gatewayUrl: "wss://other.example", navWidth: 280 });
  localStorage.setItem(otherSettingsKey, otherStored);
  const existingDraft = '  const ID_007 = "C:\\tools\\app";\n\tالعربية e\u0301 🙂  ';
  const state: ChatComposerPersistenceState = {
    settings: { gatewayUrl },
    sessionKey,
    chatMessage: existingDraft,
    chatQueue: [],
    client: { recoveryScope: "stable-account", recoveryScopeReady: true },
    connected: true,
  };
  // The production draft writer is unchanged from v2026.11.10; no released app is run here.
  expect(persistChatComposerState(state, sessionKey, { draftRevision: 7 })).toBe(true);
  const storedDraft = sessionStorage.getItem(draftKey);
  expect(storedDraft).not.toBeNull();
  expect(loadSettings(gatewayUrl).developerDictation).toBeUndefined();

  for (const enabled of [true, false]) {
    patchSettings({
      gatewayUrl,
      developerDictation: {
        ...DEFAULT_DEVELOPER_DICTATION_SETTINGS,
        enabled,
        mode: "developer",
        locale: "en-US",
      },
    });
    const reloaded = loadSettings(gatewayUrl);
    expect(reloaded).toMatchObject({
      ...existingPreferences,
      sessionKey,
      lastActiveSessionKey: sessionKey,
      selectedAgentId: "main",
      developerDictation: { enabled, mode: "developer", locale: "en-US" },
    });
    expect(JSON.parse(localStorage.getItem(settingsKey)!)).toMatchObject({
      ...existingPreferences,
      navigationByProfile,
      sessionsByGateway,
    });
    expect(localStorage.getItem(otherSettingsKey)).toBe(otherStored);
    expect(sessionStorage.getItem(draftKey)).toBe(storedDraft);
    expect(loadChatComposerState(state, sessionKey)).toMatchObject({
      snapshot: { draft: existingDraft, queue: [] },
      revisions: { committed: 7, latestAttempt: 7 },
    });
  }

  state.chatMessage = `${existingDraft}\nnext_edit`;
  expect(
    persistChatComposerState(state, sessionKey, {
      expectedDraftRevision: 7,
      draftRevision: 8,
    }),
  ).toBe(true);
  expect(loadChatComposerState(state, sessionKey)).toMatchObject({
    snapshot: { draft: `${existingDraft}\nnext_edit`, queue: [] },
    revisions: { committed: 8, latestAttempt: 8 },
  });
});
