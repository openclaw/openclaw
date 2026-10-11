/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { selectBackgroundSource } from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  clearBackgroundPreferenceIdentity,
  loadBackgroundPreference,
  saveBackgroundPreference,
  setBackgroundPreferenceIdentity,
} from "./settings-background.ts";

const gateway = "ws://background-local";
beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  clearBackgroundPreferenceIdentity();
});
afterEach(() => {
  clearBackgroundPreferenceIdentity();
  vi.unstubAllGlobals();
});
it.each(["none", "theme"] as const)(
  "retains anonymous %s without inheriting it into a profile or another Gateway",
  (kind) => {
    const preference = selectBackgroundSource({ kind });
    saveBackgroundPreference(gateway, preference);
    expect(loadBackgroundPreference(gateway)).toEqual(preference);
    clearBackgroundPreferenceIdentity();
    expect(loadBackgroundPreference(gateway)).toEqual(preference);
    expect(loadBackgroundPreference("ws://different-gateway")).toBeUndefined();
    setBackgroundPreferenceIdentity(gateway, "profile-a");
    expect(loadBackgroundPreference(gateway)).toBeUndefined();
    clearBackgroundPreferenceIdentity();
    expect(loadBackgroundPreference(gateway)).toEqual(preference);
  },
);
it("never retains or restores custom metadata without a confirmed profile", () => {
  const custom = selectBackgroundSource({ kind: "custom", assetId: "private-image" });
  saveBackgroundPreference(gateway, custom);
  expect(loadBackgroundPreference(gateway)).toBeUndefined();
  setBackgroundPreferenceIdentity(gateway, "profile-a");
  saveBackgroundPreference(gateway, custom);
  expect(loadBackgroundPreference(gateway)).toEqual(custom);
  clearBackgroundPreferenceIdentity();
  expect(loadBackgroundPreference(gateway)).toBeUndefined();
  setBackgroundPreferenceIdentity(gateway, "profile-b");
  expect(loadBackgroundPreference(gateway)).toBeUndefined();
});
