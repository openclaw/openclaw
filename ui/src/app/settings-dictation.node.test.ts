// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { installSettingsStorageLifecycle, setTestLocation } from "../test-helpers/settings-node.ts";
import { loadSettings, saveSettings, settingsKeyForGateway } from "./settings.ts";

function stored(gatewayUrl: string): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(settingsKeyForGateway(gatewayUrl)) ?? "{}");
}

// Exercises the real settings load/save owner with isolated storage, not browser rendering or speech.
describe("dictation correction preferences", () => {
  installSettingsStorageLifecycle();

  beforeEach(() => {
    setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
  });

  it("defaults to Off, preserves existing preferences, and scopes opt-in and disable to this Gateway", () => {
    const gatewayUrl = "ws://corrections.example:18789";
    expect(loadSettings(gatewayUrl).composerCorrections).toBeUndefined();
    localStorage.setItem(
      settingsKeyForGateway(gatewayUrl),
      JSON.stringify({ composerHoldToRecord: false, themeMode: "dark" }),
    );
    const previous = loadSettings(gatewayUrl);
    expect(previous.composerCorrections).toBeUndefined();
    saveSettings({
      ...previous,
      composerCorrections: { version: 1, mode: "explicit", locale: "en-US" },
    });
    expect(loadSettings(gatewayUrl)).toMatchObject({
      composerHoldToRecord: false,
      themeMode: "dark",
      composerCorrections: { version: 1, mode: "explicit", locale: "en-US" },
    });
    expect(
      loadSettings("ws://other-corrections.example:18789").composerCorrections,
    ).toBeUndefined();
    saveSettings({ ...loadSettings(gatewayUrl), composerCorrections: undefined });
    expect(loadSettings(gatewayUrl)).toMatchObject({
      composerHoldToRecord: false,
      themeMode: "dark",
      composerCorrections: undefined,
    });
    expect(stored(gatewayUrl)).not.toHaveProperty("composerCorrections");
  });

  it.each([
    { version: 2, mode: "explicit", locale: "en-US" },
    { version: 1, mode: "off", locale: "en-US" },
    { version: 1, mode: "explicit", locale: "fr-FR" },
    "explicit",
  ])("fails closed when stored correction settings are unsupported: %j", (composerCorrections) => {
    const gatewayUrl = "ws://unsupported-corrections.example:18789";
    localStorage.setItem(
      settingsKeyForGateway(gatewayUrl),
      JSON.stringify({ composerCorrections }),
    );
    const loaded = loadSettings(gatewayUrl);
    expect(loaded.composerCorrections).toBeUndefined();
    saveSettings(loaded);
    expect(stored(gatewayUrl)).not.toHaveProperty("composerCorrections");
  });

  it("does not retain transient Literal or transcript fields in correction preferences", () => {
    const gatewayUrl = "ws://transient-corrections.example:18789";
    localStorage.setItem(
      settingsKeyForGateway(gatewayUrl),
      JSON.stringify({
        composerCorrections: {
          version: 1,
          mode: "explicit",
          locale: "en-US",
          literal: true,
          transcript: "temporary",
        },
      }),
    );
    const loaded = loadSettings(gatewayUrl);
    expect(loaded.composerCorrections).toEqual({ version: 1, mode: "explicit", locale: "en-US" });
    saveSettings(loaded);
    expect(stored(gatewayUrl).composerCorrections).toEqual({
      version: 1,
      mode: "explicit",
      locale: "en-US",
    });
  });
});
