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
  type RequestMock,
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
let request: RequestMock;
let writer: ReturnType<typeof createServerPrefsWriter>;
const none = selectBackgroundSource({ kind: "none" });
const custom = selectBackgroundSource({ kind: "custom", assetId: "asset-a" });
const replacement = { kind: "custom", assetId: "replacement" } as const;
const config = configWithPrefs({});
const pendingKey = (profile = profileId) =>
  "openclaw.control.serverPrefs.pending.v1:" + scope + ":profile:" + profile;
const readPending = () => JSON.parse(localStorage.getItem(pendingKey()) ?? "{}");
const state = () => resolveServerUiPrefWriteStatus("background", scope, profileId);
const background = () => loadSettings().background;
const methods = () => request.mock.calls.map(([method]) => method);
const noneWrite = {
  entries: { "ui.background": none },
  expectedEntries: { "ui.background": null },
};
const applyProfile = (identity: string | null) =>
  applyServerUiPrefs(config, { scope, profileId: identity, onApplied: vi.fn() });
const profileState = () =>
  resolveServerUiPrefState(config, "background", scope, loadSettings(), { profileId });
function adopt(
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
  request = vi.fn(async () => ({ status: "ok" }));
  writer = createServerPrefsWriter(request, scope);
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
  for (const assetId of ["../other", "x".repeat(129)]) {
    expect(
      normalizeBackgroundPreference({ ...custom, source: { kind: "custom", assetId } }),
    ).toBeUndefined();
  }
  for (const visibility of [-1, 1.1, Infinity, "0.5"]) {
    expect(normalizeBackgroundPreference({ ...custom, visibility })).toBeUndefined();
  }
  expect(selectBackgroundSource(custom.source)).toMatchObject({
    showOnNewSession: true,
    showInSessions: false,
  });
  const placement = { showOnNewSession: false, showInSessions: true, visibility: 0.2 };
  expect(selectBackgroundSource(replacement, { ...custom, ...placement })).toMatchObject(placement);
  expect(DEFAULT_BACKGROUND_PREFERENCE).toMatchObject({
    source: { kind: "theme" },
    showInSessions: true,
  });
  expect(selectBackgroundSource({ kind: "theme" }).showInSessions).toBe(true);
  expect(selectBackgroundSource(custom.source, DEFAULT_BACKGROUND_PREFERENCE).showInSessions).toBe(
    true,
  );
});

it.each([false, true])(
  "restores only the confirmed profile mirror (private storage: %s)",
  (privateStorage) => {
    if (privateStorage) {
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("private storage");
      });
    }
    patchSettings({ background: custom });
    if (privateStorage) {
      expect(background()).toEqual(custom);
    } else {
      resetServerUiPrefsSync();
      expect(background()).toBeUndefined();
    }
    applyProfile("viewer-b");
    expect(background()).toBeUndefined();
    if (privateStorage) {
      return;
    }
    applyProfile(profileId);
    expect(background()).toEqual(custom);
    expect(loadSettings("ws://other-gateway").background).toBeUndefined();
    applyProfile(null);
    expect(background()).toBeUndefined();
  },
);

it("invalidates old profile reads before the next profile has fetched its preferences", async () => {
  const delayed = createDeferred<unknown>();
  request.mockImplementation(() => delayed.promise);
  const oldRead = refreshServerPrefsProfile(writer, profileId, config);
  await waitForFast(() => expect(request).toHaveBeenCalledOnce());
  applyProfile("viewer-b");
  delayed.resolve({ status: "ok", entries: { "ui.background": custom } });
  expect(await oldRead).toBe(false);
  expect(background()).toBeUndefined();
});

it("syncs explicit None and reports saved only after the profile acknowledgement", async () => {
  const delayed = createDeferred<unknown>();
  const dispatched = createDeferred();
  request.mockImplementation(async (method: string) => {
    if (method === "users.prefs.get") {
      return { status: "ok", entries: {} };
    }
    if (method === "users.prefs.set") {
      dispatched.resolve();
    }
    return delayed.promise;
  });
  writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
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
    expect(request).toHaveBeenLastCalledWith("users.prefs.set", noneWrite);
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
  request.mockImplementation(async (method: string, params?: unknown) => {
    const entries = (params as UsersPrefsSetParams | undefined)?.entries;
    if (method === "users.prefs.set" && entries?.["ui.background"] && fail) {
      throw new Error("offline during background save");
    }
    return { status: "ok" };
  });
  writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
  patchSettings({ theme: "rose", tabIcon: "agent", background: custom });
  pushServerUiPrefs(writer, { theme: "rose", tabIcon: "agent", background: custom }, writeOptions);
  await waitForFast(() =>
    expect(state()).toEqual({ status: "error", error: "offline during background save" }),
  );
  const splitWrites = ["themes.set", "users.prefs.set", "users.prefs.set"];
  expect(methods()).toEqual(splitWrites);
  expect(request).toHaveBeenNthCalledWith(2, "users.prefs.set", {
    entries: { "ui.tabIcon": "agent" },
  });
  expect(readPending()).toEqual({ background: custom });
  fail = false;
  flushServerUiPrefs(writer, writeOptions);
  await waitForFast(() => expect(state()).toEqual({ status: "saved" }));
  expect(methods()).toEqual([...splitWrites, "users.prefs.set"]);
});

it("keeps offline edits in their known profile and never falls through to config", async () => {
  request.mockResolvedValue({ status: "ok", entries: {} });
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
  expect(request).toHaveBeenCalledWith("users.prefs.set", noneWrite);
});

it("adopts atomic upload and removal receipts without another profile write", async () => {
  request.mockResolvedValue({ status: "ok", entries: { "ui.background": none } });
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
  expect(adopt(custom, none)).toBe(true);
  expect(background()).toEqual(custom);
  expect(profileState()).toMatchObject({ provenance: "profile", value: custom });
  expect(state()).toEqual({ status: "saved" });
  expect(adopt(null, custom)).toBe(true);
  expect(background()).toBeUndefined();
  expect(request).not.toHaveBeenCalled();
  expect(readPending()).toEqual({});
});

it("does not adopt an old upload receipt over pending or already-acknowledged newer intent", () => {
  writer = createServerPrefsWriter(request, scope, false);
  // A newer saved local intent is enough to fence the receipt even without an outbox key.
  patchSettings({ background: none });
  Object.assign(writer.state.client!, { connected: true });
  expect(adopt(custom)).toBe(false);
  expect(background()).toEqual(none);
  pushServerUiPrefs(writer, { background: none }, writeOptions);
  expect(adopt(custom, none)).toBe(false);
  expect(readPending()).toEqual({ background: none });
  expect(request).not.toHaveBeenCalled();
});

it("fences receipt adoption by the captured connection and current profile", () => {
  expect(adopt(custom, null, () => false)).toBe(false);
  applyProfile("viewer-b");
  expect(adopt(custom)).toBe(false);
  expect(background()).toBeUndefined();
  expect(request).not.toHaveBeenCalled();
});
