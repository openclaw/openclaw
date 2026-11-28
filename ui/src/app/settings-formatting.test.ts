// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { storageTargetForGateway, storedChatOutboxScopeKey } from "../lib/chat/outbox-store.ts";
import { installSettingsStorageLifecycle, setTestLocation } from "../test-helpers/settings-node.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import { normalizeDictationFormatting, type DictationFormatting } from "./settings-contract.ts";
import { loadSettings, loadUiPreferences, patchSettings, saveSettings } from "./settings.ts";

const gatewayUrl = "wss://gateway.example";
const settingsKey = `openclaw.control.settings.v1:${gatewayUrl}`;
const explicit: DictationFormatting = { version: 1, mode: "explicit" };
const preserve: DictationFormatting = { version: 1, mode: "preserve" };

function readStored(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(settingsKey) ?? "{}");
}

describe("browser-local dictation formatting", () => {
  installSettingsStorageLifecycle();

  beforeEach(() => {
    setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
  });

  it("preserves recognition by default without rewriting an existing settings record", () => {
    const previous = JSON.stringify({ gatewayUrl, navWidth: 312, composerHoldToRecord: false });
    localStorage.setItem(settingsKey, previous);

    expect(loadSettings().dictationFormatting).toBeUndefined();
    expect(loadUiPreferences(gatewayUrl).dictationFormatting).toBeUndefined();
    expect(localStorage.getItem(settingsKey)).toBe(previous);

    patchSettings({ dictationFormatting: preserve });
    expect(loadSettings().dictationFormatting).toBeUndefined();
    expect(readStored()).not.toHaveProperty("dictationFormatting");
    expect(readStored()).toMatchObject({ navWidth: 312, composerHoldToRecord: false });
  });

  it.each([
    { label: "absent policy", value: undefined },
    { label: "null policy", value: null },
    { label: "string policy", value: "explicit" },
    { label: "array policy", value: [{ version: 1, mode: "explicit" }] },
    { label: "missing version", value: { mode: "explicit" } },
    { label: "unsupported version", value: { version: 2, mode: "explicit" } },
    { label: "string version", value: { version: "1", mode: "explicit" } },
    { label: "missing mode", value: { version: 1 } },
    { label: "unsupported mode", value: { version: 1, mode: "automatic" } },
    { label: "Preserve mode", value: preserve },
  ])("falls back to Preserve for $label on load and save", ({ value }) => {
    expect(normalizeDictationFormatting(value)).toBeUndefined();
    const previous = JSON.stringify({ gatewayUrl, dictationFormatting: value });
    localStorage.setItem(settingsKey, previous);

    const loaded = loadSettings();
    expect(loaded.dictationFormatting).toBeUndefined();
    expect(localStorage.getItem(settingsKey)).toBe(previous);

    // Exercise the save boundary with malformed runtime input as well as stored JSON.
    Reflect.set(loaded, "dictationFormatting", value);
    saveSettings(loaded);
    expect(readStored()).not.toHaveProperty("dictationFormatting");
    expect(loadSettings().dictationFormatting).toBeUndefined();
  });

  it("round-trips only the versioned opt-in policy and removes it on reset", () => {
    const policy = { ...explicit, transcript: "Synthetic recognition text" };
    const normalized = normalizeDictationFormatting(policy);
    expect(normalized).toEqual(explicit);
    expect(normalized).not.toBe(policy);

    saveSettings({ ...loadSettings(), dictationFormatting: policy });
    expect(readStored().dictationFormatting).toEqual(explicit);
    expect(loadSettings().dictationFormatting).toEqual(explicit);
    expect(loadUiPreferences(gatewayUrl).dictationFormatting).toEqual(explicit);
    expect(localStorage.getItem(settingsKey)).not.toContain(policy.transcript);

    for (const resetPolicy of [preserve, undefined]) {
      patchSettings({ dictationFormatting: explicit });
      patchSettings({ dictationFormatting: resetPolicy });
      expect(readStored()).not.toHaveProperty("dictationFormatting");
      expect(loadSettings().dictationFormatting).toBeUndefined();
    }
  });

  it("retains unrelated preferences and existing composer drafts when formatting changes", () => {
    const retained = {
      themeMode: "light",
      fontUi: "geist",
      navWidth: 312,
      composerHoldToRecord: false,
      realtimeTalkInputDeviceId: "synthetic-microphone",
      chatSendShortcut: "modifier-enter",
      locale: "de",
      pinnedAgentIds: ["research"],
    };
    localStorage.setItem(
      settingsKey,
      JSON.stringify({
        gatewayUrl,
        ...retained,
        sessionsByGateway: {
          [gatewayUrl]: {
            sessionKey: "agent:main:saved",
            lastActiveSessionKey: "agent:main:saved",
          },
        },
      }),
    );
    const draftKey = storageTargetForGateway(gatewayUrl, "profile:synthetic").key;
    const previousDraft = JSON.stringify({
      version: 4,
      gatewayOwner: gatewayUrl,
      sessions: {
        [storedChatOutboxScopeKey({ sessionKey: "agent:main:saved", agentId: "main" })]: {
          draft: "first paragraph\n\n- literal item",
          draftRevision: 7,
          updatedAt: 1,
        },
      },
      recovery: {},
    });
    sessionStorage.setItem(draftKey, previousDraft);

    for (const policy of [explicit, preserve]) {
      patchSettings({ dictationFormatting: policy });
      expect(loadSettings()).toMatchObject({ ...retained, sessionKey: "agent:main:saved" });
      expect(readStored()).toMatchObject(retained);
      expect(sessionStorage.getItem(draftKey)).toBe(previousDraft);
    }
  });

  it("keeps the policy scoped to this browser's Gateway preferences without a server delta", () => {
    const before = loadSettings();
    const next = patchSettings({ dictationFormatting: explicit });

    expect(changedServerUiPrefs(before, next)).toBeNull();
    expect(loadUiPreferences(gatewayUrl).dictationFormatting).toEqual(explicit);
    expect(loadUiPreferences("wss://other.example").dictationFormatting).toBeUndefined();
  });
});
