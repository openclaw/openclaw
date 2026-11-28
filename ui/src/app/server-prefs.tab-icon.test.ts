import { expect, it, vi } from "vitest";
/* @vitest-environment jsdom */
import { createDeferred } from "../../../test/helpers/promise.js";
import { selectThemeSettings, resetServerUiPref } from "./server-prefs-controls.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import { resolveServerUiPrefState, extractServerUiPrefs } from "./server-prefs-reconcile.ts";
import {
  configWithPrefs,
  createServerPrefsWriter,
  refreshServerPrefsProfile,
  installServerPrefsStorage,
} from "./server-prefs.test-support.ts";
import { flushServerUiPrefs, pushServerUiPrefs } from "./server-prefs.ts";
import { loadSettings, patchSettings, settingsKeyForGateway } from "./settings.ts";

const scope = "ws://tab-icon-prefs";
const profileId = "profile-icon";
const tabIcon = "agent:circle";
const pendingKey = `openclaw.control.serverPrefs.pending.v1:${scope}:profile:${profileId}`;
const appearance = { theme: "dash", accent: "theme", fontUi: null, fontChat: null } as const;
const stored = (key: string) => JSON.parse(localStorage.getItem(key)!);
const provenance = (config: ReturnType<typeof configWithPrefs>) =>
  resolveServerUiPrefState(config, "tabIcon", scope, loadSettings(), { profileId }).provenance;

installServerPrefsStorage(scope);

it("preserves the icon on theme selection and removes the preference on reset", () => {
  const choice = "lobster:crimson";
  patchSettings({ tabIcon: choice });
  selectThemeSettings("dash");
  expect(loadSettings().tabIcon).toEqual(choice);
  const previous = loadSettings();
  const next = resetServerUiPref("tabIcon");
  expect(next.tabIcon).toBeUndefined();
  expect(changedServerUiPrefs(previous, next)).toMatchObject({ tabIcon: null });
  expect(stored(settingsKeyForGateway(scope))).not.toHaveProperty("tabIcon");
});

it("rejects malformed browser mirrors and never reads the icon from gateway config", () => {
  const key = settingsKeyForGateway(scope);
  localStorage.setItem(key, JSON.stringify({ gatewayUrl: scope, tabIcon: { mode: "agent" } }));
  expect(loadSettings().tabIcon).toBeUndefined();
  expect(extractServerUiPrefs(configWithPrefs({ tabIcon, theme: "claw" }))).toEqual({
    theme: "claw",
  });
});

it("writes a mixed theme batch without falsely acknowledging its rejected icon", async () => {
  const iconStarted = createDeferred();
  const iconReply = createDeferred<{ status: "ok" | "no_durable_identity" }>();
  const completed = createDeferred();
  const request = vi.fn(async (method: string) => {
    if (method === "users.prefs.get") {
      return { status: "ok", entries: {} };
    }
    if (method === "users.prefs.set") {
      iconStarted.resolve();
      return iconReply.promise;
    }
    return { application: "saved" };
  });
  const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
  const config = configWithPrefs({});
  await refreshServerPrefsProfile(writer, profileId, config);
  request.mockClear();
  patchSettings({ ...appearance, fontUi: undefined, fontChat: undefined, tabIcon });
  let commits = 0;
  const afterCommit = vi.fn(() => {
    if (++commits === 2) {
      completed.resolve();
    }
  });
  pushServerUiPrefs(writer, { ...appearance, tabIcon }, { profileId, canWrite: true, afterCommit });
  await iconStarted.promise;
  expect(request.mock.calls).toEqual([
    ["themes.set", { id: "dash", appearance: { accent: "theme", fontUi: null, fontChat: null } }],
    ["users.prefs.set", { entries: { "ui.tabIcon": tabIcon } }],
  ]);
  expect(stored(pendingKey)).toEqual({ tabIcon });
  expect(provenance(config)).toBe("pending");
  iconReply.resolve({ status: "no_durable_identity" });
  await completed.promise;
  expect(localStorage.getItem(pendingKey)).toBeNull();
  expect(afterCommit).toHaveBeenLastCalledWith({ needsRefresh: false, retainedLocal: true });
  expect(provenance(config)).toBe("device-local");
});

it("rejects unsupported queued icons before any profile write", async () => {
  const request = vi.fn(async () => ({ status: "ok" }));
  const writer = createServerPrefsWriter(request, scope);
  const completed = createDeferred();
  const afterCommit = vi.fn(() => completed.resolve());
  localStorage.setItem(pendingKey, JSON.stringify({ tabIcon: "custom" }));

  flushServerUiPrefs(writer, { profileId, canWrite: true, afterCommit });
  await completed.promise;

  expect(afterCommit).toHaveBeenCalledExactlyOnceWith({
    needsRefresh: false,
    retainedLocal: true,
  });
  expect(request).not.toHaveBeenCalled();
  expect(localStorage.getItem(pendingKey)).toBeNull();
});
