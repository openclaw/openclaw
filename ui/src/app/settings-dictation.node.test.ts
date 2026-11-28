// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { installSettingsStorageLifecycle, setTestLocation } from "../test-helpers/settings-node.ts";
import { loadSettings, patchSettings, saveSettings, settingsKeyForGateway } from "./settings.ts";

function stored(gatewayUrl: string): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(settingsKeyForGateway(gatewayUrl)) ?? "{}");
}

// Exercises the real settings load/save owner with isolated storage, not browser rendering or speech.
describe("dictation correction preferences", () => {
  installSettingsStorageLifecycle();

  beforeEach(() => {
    setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
  });

  it("keeps a pre-correction settings shape through Gateway-local opt-in and disable", () => {
    const gatewayUrl = "ws://corrections.example:18789";
    expect(loadSettings(gatewayUrl).composerCorrections).toBeUndefined();
    // Existing persisted fields, not a claim of running an installed stable app upgrade.
    const retained = {
      composerHoldToRecord: false,
      realtimeTalkInputDeviceId: "usb-microphone",
      navWidth: 320,
      themeMode: "dark",
      pinnedAgentIds: ["research"],
    };
    localStorage.setItem(
      settingsKeyForGateway(gatewayUrl),
      JSON.stringify({
        ...retained,
        sessionsByGateway: {
          [gatewayUrl]: {
            sessionKey: "agent:main:saved",
            lastActiveSessionKey: "agent:main:saved",
          },
        },
      }),
    );
    expect(loadSettings(gatewayUrl)).toMatchObject({
      ...retained,
      sessionKey: "agent:main:saved",
      composerCorrections: undefined,
    });
    patchSettings({
      gatewayUrl,
      composerCorrections: { version: 1, mode: "explicit", locale: "en-US" },
    });
    expect(loadSettings(gatewayUrl)).toMatchObject({
      ...retained,
      sessionKey: "agent:main:saved",
      composerCorrections: { version: 1, mode: "explicit", locale: "en-US" },
    });
    expect(
      loadSettings("ws://other-corrections.example:18789").composerCorrections,
    ).toBeUndefined();
    patchSettings({ gatewayUrl, composerCorrections: undefined });
    expect(loadSettings(gatewayUrl)).toMatchObject({
      ...retained,
      sessionKey: "agent:main:saved",
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
