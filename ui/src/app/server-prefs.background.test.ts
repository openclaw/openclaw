/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DEFAULT_BACKGROUND_PREFERENCE,
  type BackgroundPreference,
  normalizeBackgroundPreference,
  selectBackgroundSource,
} from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import type { UsersPrefsSetParams } from "../../../packages/gateway-protocol/src/schema/users.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  adoptCommittedBackgroundPreference,
  resolveServerUiPrefWriteStatus,
} from "./server-prefs-controls.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import { applyServerUiPrefs, resolveServerUiPrefState } from "./server-prefs-reconcile.ts";
import {
  configWithPrefs,
  createServerPrefsWriter,
  initializeServerPrefsProfile,
  refreshServerPrefsProfile,
} from "./server-prefs.test-support.ts";
import {
  isApplyingServerUiPrefs,
  flushServerUiPrefs,
  pushServerUiPrefs,
  resetServerUiPrefsSync,
  subscribeServerUiPrefWrites,
} from "./server-prefs.ts";
import { loadSettings, patchSettings, setSettingsChangeListener } from "./settings.ts";

const scope = "ws://background-profile";
const profileId = "viewer-a";
const writeOptions = { profileId, canWrite: true };
const none = selectBackgroundSource({ kind: "none" });
const custom = selectBackgroundSource({ kind: "custom", assetId: "asset-a" });
const config = configWithPrefs({});
const pendingKey = (profile = profileId) =>
  "openclaw.control.serverPrefs.pending.v1:" + scope + ":profile:" + profile;
const readPending = () => JSON.parse(localStorage.getItem(pendingKey()) ?? "{}");
const state = () => resolveServerUiPrefWriteStatus("background", scope, profileId);
const applyProfile = (identity: string | null) =>
  applyServerUiPrefs(config, { scope, profileId: identity, onApplied: vi.fn() });
const profileState = () =>
  resolveServerUiPrefState(config, "background", scope, loadSettings(), { profileId });
function adopt(
  writer: ReturnType<typeof createServerPrefsWriter>,
  preference: BackgroundPreference | null,
  expectedPreference: BackgroundPreference | null = null,
  isCurrent = () => true,
) {
  return adoptCommittedBackgroundPreference({
    client: writer.state.client!,
    profileId,
    scope,
    preference,
    expectedPreference,
    isCurrent,
  });
}

beforeEach(async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  await initializeServerPrefsProfile(scope, profileId, config);
});
afterEach(() => {
  setSettingsChangeListener(null);
  resetServerUiPrefsSync();
  vi.restoreAllMocks();
  patchSettings({ gatewayUrl: scope, background: undefined });
  vi.unstubAllGlobals();
});

it("normalizes metadata without retaining bytes, URLs, or unknown fields", () => {
  expect(
    normalizeBackgroundPreference({ ...custom, url: "https://example.test/private", bytes: "abc" }),
  ).toEqual(custom);
  for (const assetId of [
    "https://example.test/image",
    "../other",
    "data:image/png;base64,abc",
    "x".repeat(129),
  ]) {
    expect(
      normalizeBackgroundPreference({ ...custom, source: { kind: "custom", assetId } }),
    ).toBeUndefined();
  }
  for (const visibility of [-1, 1.1, Infinity, Number.NaN, "0.5"]) {
    expect(normalizeBackgroundPreference({ ...custom, visibility })).toBeUndefined();
  }
  expect(selectBackgroundSource({ kind: "custom", assetId: "first" })).toMatchObject({
    showOnNewSession: true,
    showInSessions: false,
  });
  expect(
    selectBackgroundSource(
      { kind: "custom", assetId: "replacement" },
      { ...custom, showOnNewSession: false, showInSessions: true, visibility: 0.2 },
    ),
  ).toMatchObject({ showOnNewSession: false, showInSessions: true, visibility: 0.2 });
  expect(DEFAULT_BACKGROUND_PREFERENCE).toMatchObject({
    source: { kind: "theme" },
    showInSessions: true,
  });
  expect(selectBackgroundSource({ kind: "theme" }).showInSessions).toBe(true);
  expect(
    selectBackgroundSource(
      { kind: "custom", assetId: "first-explicit" },
      DEFAULT_BACKGROUND_PREFERENCE,
    ).showInSessions,
  ).toBe(true);
});

it.each([false, true])(
  "restores only the confirmed profile mirror (private storage: %s)",
  (privateStorage) => {
    if (privateStorage) {
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("private storage");
      });
      patchSettings({ background: custom });
      expect(loadSettings().background).toEqual(custom);
      applyProfile("viewer-b");
      expect(loadSettings().background).toBeUndefined();
      return;
    }
    patchSettings({ background: custom });
    resetServerUiPrefsSync();
    expect(loadSettings().background).toBeUndefined();
    applyProfile("viewer-b");
    expect(loadSettings().background).toBeUndefined();
    applyProfile(profileId);
    expect(loadSettings().background).toEqual(custom);
    expect(loadSettings("ws://other-gateway").background).toBeUndefined();
    applyProfile(null);
    expect(loadSettings().background).toBeUndefined();
  },
);

it("invalidates old profile reads before the next profile has fetched its preferences", async () => {
  const delayed = createDeferred<unknown>();
  const request = vi.fn(() => delayed.promise);
  const writer = createServerPrefsWriter(request, scope);
  const oldRead = refreshServerPrefsProfile(writer, profileId, config);
  await waitForFast(() => expect(request).toHaveBeenCalledOnce());
  applyProfile("viewer-b");
  delayed.resolve({ status: "ok", entries: { "ui.background": custom } });
  expect(await oldRead).toBe(false);
  expect(loadSettings().background).toBeUndefined();
});

it("syncs explicit None and reports saved only after the profile acknowledgement", async () => {
  const delayed = createDeferred<unknown>();
  const dispatched = createDeferred();
  const request = vi.fn(async (method: string) => {
    if (method === "users.prefs.get") {
      return { status: "ok", entries: {} };
    }
    if (method === "users.prefs.set") {
      dispatched.resolve();
    }
    return delayed.promise;
  });
  const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
  await refreshServerPrefsProfile(writer, profileId, config);
  patchSettings({ background: none });
  const committed = createDeferred();
  const afterCommit = vi.fn(() => committed.resolve());
  const transitions: string[] = [];
  const unsubscribe = subscribeServerUiPrefWrites(() => transitions.push(state().status));
  try {
    pushServerUiPrefs(writer, { background: none }, { ...writeOptions, afterCommit });
    expect(state()).toEqual({ status: "pending" });
    await dispatched.promise;
    expect(request).toHaveBeenLastCalledWith("users.prefs.set", {
      entries: { "ui.background": none },
      expectedEntries: { "ui.background": null },
    });
    delayed.resolve({ status: "ok" });
    await committed.promise;
    expect(afterCommit).toHaveBeenCalledOnce();
    expect(state()).toEqual({ status: "saved" });
    expect(profileState()).toMatchObject({ provenance: "profile", value: none });
    expect(readPending()).toEqual({});
    expect(transitions).toEqual(["pending", "saved"]);
  } finally {
    unsubscribe();
  }
});

it("acknowledges theme and tab icon separately, retaining only a failed background for reconnect", async () => {
  let fail = true;
  const request = vi.fn(async (method: string, params?: unknown) => {
    const entries = (params as UsersPrefsSetParams | undefined)?.entries;
    if (method === "users.prefs.set" && entries?.["ui.background"] && fail) {
      throw new Error("offline during background save");
    }
    return { status: "ok" };
  });
  const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
  patchSettings({ theme: "rose", tabIcon: "agent", background: custom });
  pushServerUiPrefs(writer, { theme: "rose", tabIcon: "agent", background: custom }, writeOptions);
  await waitForFast(() =>
    expect(state()).toEqual({ status: "error", error: "offline during background save" }),
  );
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "themes.set",
    "users.prefs.set",
    "users.prefs.set",
  ]);
  expect(request).toHaveBeenNthCalledWith(2, "users.prefs.set", {
    entries: { "ui.tabIcon": "agent" },
  });
  expect(readPending()).toEqual({ background: custom });
  fail = false;
  flushServerUiPrefs(writer, writeOptions);
  await waitForFast(() => expect(state()).toEqual({ status: "saved" }));
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "themes.set",
    "users.prefs.set",
    "users.prefs.set",
    "users.prefs.set",
  ]);
});

it("keeps offline edits in their known profile and never falls through to config", async () => {
  const request = vi.fn(async () => ({ status: "ok", entries: {} }));
  const offline = createServerPrefsWriter(request, scope, false);
  patchSettings({ background: none });
  pushServerUiPrefs(offline, { background: none }, { canWrite: true });
  expect(state()).toEqual({ status: "pending" });
  expect(request).not.toHaveBeenCalled();
  flushServerUiPrefs(createServerPrefsWriter(request, scope), {
    ...writeOptions,
    profileId: "viewer-b",
  });
  expect(request).not.toHaveBeenCalled();
  flushServerUiPrefs(createServerPrefsWriter(request, scope), writeOptions);
  await waitForFast(() => expect(state()).toEqual({ status: "saved" }));
  expect(request).toHaveBeenCalledWith("users.prefs.set", {
    entries: { "ui.background": none },
    expectedEntries: { "ui.background": null },
  });
});

it("adopts atomic upload and removal receipts without another profile write", async () => {
  const request = vi.fn(async () => ({ status: "ok", entries: { "ui.background": none } }));
  const writer = createServerPrefsWriter(request, scope);
  await refreshServerPrefsProfile(writer, profileId, config);
  request.mockClear();
  setSettingsChangeListener((previous, next) => {
    if (isApplyingServerUiPrefs()) {
      return;
    }
    const changed = changedServerUiPrefs(previous, next);
    if (changed) {
      pushServerUiPrefs(writer, changed, writeOptions);
    }
  });
  expect(adopt(writer, custom, none)).toBe(true);
  expect(loadSettings().background).toEqual(custom);
  expect(profileState()).toMatchObject({ provenance: "profile", value: custom });
  expect(state()).toEqual({ status: "saved" });
  expect(adopt(writer, null, custom)).toBe(true);
  expect(loadSettings().background).toBeUndefined();
  expect(request).not.toHaveBeenCalled();
  expect(readPending()).toEqual({});
});

it("does not adopt an old upload receipt over pending or already-acknowledged newer intent", () => {
  const request = vi.fn(async () => ({ status: "ok" }));
  const writer = createServerPrefsWriter(request, scope, false);
  // A newer saved local intent is enough to fence the receipt even without an outbox key.
  patchSettings({ background: none });
  Object.assign(writer.state.client!, { connected: true });
  expect(adopt(writer, custom)).toBe(false);
  expect(loadSettings().background).toEqual(none);
  pushServerUiPrefs(writer, { background: none }, writeOptions);
  expect(adopt(writer, custom, none)).toBe(false);
  expect(readPending()).toEqual({ background: none });
  expect(request).not.toHaveBeenCalled();
});

it("fences receipt adoption by the captured connection and current profile", () => {
  const request = vi.fn(async () => ({ status: "ok" }));
  const writer = createServerPrefsWriter(request, scope);
  expect(adopt(writer, custom, null, () => false)).toBe(false);
  applyProfile("viewer-b");
  expect(adopt(writer, custom)).toBe(false);
  expect(loadSettings().background).toBeUndefined();
  expect(request).not.toHaveBeenCalled();
});
