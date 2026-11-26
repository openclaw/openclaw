// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { installSettingsStorageLifecycle, setTestLocation } from "../test-helpers/settings-node.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import {
  parseDictationRefinementPreference,
  resolveDictationRefinementPreference,
  type DictationRefinementPreference,
} from "./settings-contract.ts";
import { loadSettings, patchSettings, saveSettings } from "./settings.ts";

const gatewayUrl = "wss://gateway.example";
const key = `openclaw.control.settings.v1:${gatewayUrl}`;
const preference: DictationRefinementPreference = {
  version: 1,
  mode: "automatic",
  locale: "en-US",
  explicitEnabled: false,
};
installSettingsStorageLifecycle();
beforeEach(() => {
  setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
});

describe("dictation refinement preference", () => {
  it("keeps an existing installation disabled and round trips opt-in then content-preserving disable", () => {
    const existing = {
      gatewayUrl,
      theme: "claw",
      themeMode: "dark",
      locale: "de",
      realtimeTalkInputDeviceId: "synthetic-microphone",
      sessionsByGateway: {
        [gatewayUrl]: { sessionKey: "agent:main:kept", lastActiveSessionKey: "agent:main:kept" },
      },
    };
    localStorage.setItem(key, JSON.stringify(existing));
    const previous = loadSettings();
    expect(previous.dictationRefinement).toBeUndefined();
    const next = patchSettings({ dictationRefinement: preference });
    expect(changedServerUiPrefs(previous, next)).toBeNull();
    expect(loadSettings()).toMatchObject({
      dictationRefinement: preference,
      themeMode: "dark",
      locale: "de",
      sessionKey: "agent:main:kept",
      realtimeTalkInputDeviceId: "synthetic-microphone",
    });
    patchSettings({ dictationRefinement: undefined, dictationRefinementIssue: undefined });
    const stored = JSON.parse(localStorage.getItem(key)!);
    expect(stored.dictationRefinement).toBeUndefined();
    expect(stored.sessionsByGateway).toEqual(existing.sessionsByGateway);
    expect(loadSettings().dictationRefinement).toBeUndefined();
    expect(stored.realtimeTalkInputDeviceId).toBe(existing.realtimeTalkInputDeviceId);
  });

  it.each([
    { ...preference, version: 2 },
    { ...preference, mode: "rewrite" },
    { ...preference, locale: "" },
    { ...preference, explicitEnabled: "true" },
    { ...preference, transcript: "must never become a preference" },
  ])("disables an invalid policy visibly and never writes unvalidated fields back", (invalid) => {
    localStorage.setItem(key, JSON.stringify({ gatewayUrl, dictationRefinement: invalid }));
    const loaded = loadSettings();
    expect(loaded.dictationRefinement).toBeUndefined();
    expect(loaded.dictationRefinementIssue).toBeDefined();
    patchSettings({ themeMode: "light" });
    expect(JSON.parse(localStorage.getItem(key)!).dictationRefinement).toBeUndefined();
    expect(loadSettings().dictationRefinement).toBeUndefined();
    patchSettings({ dictationRefinement: preference, dictationRefinementIssue: undefined });
    expect(loadSettings().dictationRefinement).toEqual(preference);
    expect(loadSettings().dictationRefinementIssue).toBeUndefined();
  });

  it("does not infer a punctuation locale from the display language", () => {
    patchSettings({ locale: "en", dictationRefinement: { ...preference, locale: undefined } });
    expect(loadSettings().dictationRefinement?.locale).toBeUndefined();
    const unsupported = { ...preference, locale: "de-DE" };
    expect(parseDictationRefinementPreference(unsupported)).toEqual({ preference: unsupported });
    saveSettings({ ...loadSettings(), dictationRefinement: unsupported });
    expect(loadSettings().dictationRefinement?.locale).toBe("de-DE");
  });

  it("freezes session, enabled profile, saved locale precedence without changing the source", () => {
    const saved = { ...preference };
    const session = { ...preference, locale: "fr-FR" };
    const profile = { enabled: true, preference: { ...preference, locale: "de-DE" } };
    const result = resolveDictationRefinementPreference({ saved, session, profile });
    expect(result?.locale).toBe("fr-FR");
    expect(Object.isFrozen(result)).toBe(true);
    session.locale = "es-ES";
    expect(result?.locale).toBe("fr-FR");
    expect(resolveDictationRefinementPreference({ saved, profile })?.locale).toBe("de-DE");
    expect(
      resolveDictationRefinementPreference({ saved, profile: { ...profile, enabled: false } })
        ?.locale,
    ).toBe("en-US");
    expect(resolveDictationRefinementPreference({})).toBeUndefined();
  });
});
