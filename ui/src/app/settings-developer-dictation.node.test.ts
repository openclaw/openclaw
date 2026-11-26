// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { installSettingsStorageLifecycle, setTestLocation } from "../test-helpers/settings-node.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import {
  DEFAULT_DEVELOPER_DICTATION_SETTINGS,
  normalizeDeveloperDictationSettings,
} from "./settings-developer-dictation.ts";
import { loadSettings, patchSettings, saveSettings, settingsKeyForGateway } from "./settings.ts";

const gatewayUrl = "wss://gateway.example";
const authored =
  '{\n "schemaVersion":1,"id":"my-code","symbols":[{"spoken":"ticket","text":"CASE_007"}]\n}';
const selected = {
  schemaVersion: 1,
  enabled: true,
  mode: "developer" as const,
  locale: "en-US",
  profileId: "my-code",
  profiles: [authored],
};

installSettingsStorageLifecycle();
beforeEach(() => setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" }));

describe("developer dictation settings", () => {
  it("starts disabled without choosing an English grammar for the user", () => {
    expect(loadSettings(gatewayUrl).developerDictation).toBeUndefined();
    expect(DEFAULT_DEVELOPER_DICTATION_SETTINGS).toMatchObject({
      enabled: false,
      mode: "prose",
      locale: "",
      profiles: [],
    });
  });

  it("retains exact authored imports after disable/re-enable and unrelated preferences", () => {
    patchSettings({ gatewayUrl, developerDictation: selected });
    patchSettings({ gatewayUrl, developerDictation: { ...selected, enabled: false } });
    patchSettings({ gatewayUrl, navWidth: 340 });
    const disabled = normalizeDeveloperDictationSettings(
      loadSettings(gatewayUrl).developerDictation,
    );
    expect(disabled).toEqual({ ...selected, enabled: false });
    expect(disabled?.profiles[0]).toBe(authored);
    patchSettings({ gatewayUrl, developerDictation: { ...disabled, enabled: true } });
    expect(
      normalizeDeveloperDictationSettings(loadSettings(gatewayUrl).developerDictation),
    ).toEqual(selected);
  });

  it.each([
    { ...selected, schemaVersion: 2, futureGrammar: { commands: ["retain me"] } },
    { ...selected, mode: "unknown" },
    { ...selected, profiles: ["not valid profile JSON"] },
  ])("keeps unsupported stored data exportable instead of replacing it", (stored) => {
    localStorage.setItem(
      settingsKeyForGateway(gatewayUrl),
      JSON.stringify({ gatewayUrl, developerDictation: stored }),
    );
    const loaded = loadSettings(gatewayUrl);
    expect(loaded.developerDictation).toEqual(stored);
    patchSettings({ gatewayUrl, navWidth: 330 });
    expect(loadSettings(gatewayUrl).developerDictation).toEqual(stored);
    // An older consumer omitting this new field must not erase it on save.
    const { developerDictation: _retained, ...olderConsumer } = loadSettings(gatewayUrl);
    saveSettings(olderConsumer);
    expect(
      JSON.parse(localStorage.getItem(settingsKeyForGateway(gatewayUrl))!).developerDictation,
    ).toEqual(stored);
  });

  it("does not normalize unknown versions or malformed envelopes into enabled settings", () => {
    const sparseProfiles: unknown[] = [];
    sparseProfiles.length = 1;
    for (const value of [
      undefined,
      null,
      {},
      { ...selected, schemaVersion: 0 },
      { ...selected, schemaVersion: 2 },
      { ...selected, enabled: "true" },
      { ...selected, mode: "unknown" },
      { ...selected, run: "script" },
      { ...selected, profiles: [0] },
      { ...selected, profiles: sparseProfiles },
    ]) {
      expect(normalizeDeveloperDictationSettings(value)).toBeUndefined();
    }
  });

  it("bounds authored imports by UTF-8 bytes and count without truncating them", () => {
    const atLimit = "🙂".repeat(16_384);
    expect(
      normalizeDeveloperDictationSettings({ ...selected, profiles: [atLimit] })?.profiles[0],
    ).toBe(atLimit);
    expect(
      normalizeDeveloperDictationSettings({ ...selected, profiles: [atLimit + "x"] }),
    ).toBeUndefined();
    expect(
      normalizeDeveloperDictationSettings({
        ...selected,
        profiles: Array.from({ length: 9 }, () => authored),
      }),
    ).toBeUndefined();
    expect(
      normalizeDeveloperDictationSettings({ ...selected, locale: "x".repeat(65) }),
    ).toBeUndefined();
    expect(
      normalizeDeveloperDictationSettings({ ...selected, profileId: "x".repeat(129) }),
    ).toBeUndefined();
  });

  it("retains an explicitly selected unsupported locale for a visible fallback decision", () => {
    expect(normalizeDeveloperDictationSettings({ ...selected, locale: "ar-SA" })?.locale).toBe(
      "ar-SA",
    );
  });

  it("does not export authored mappings through server appearance preference synchronization", () => {
    const previous = loadSettings(gatewayUrl);
    const next = patchSettings({ gatewayUrl, developerDictation: selected });
    expect(changedServerUiPrefs(previous, next)).toBeNull();
  });

  it("keeps authored profiles in the gateway that owns their browser settings", () => {
    patchSettings({ gatewayUrl, developerDictation: selected });
    const other = "wss://other.example";
    patchSettings({ gatewayUrl: other, navWidth: 330 });
    expect(loadSettings(other).developerDictation).toBeUndefined();
    expect(loadSettings(gatewayUrl).developerDictation).toEqual(selected);
  });
});
