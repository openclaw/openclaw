// @vitest-environment node
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { selectBackgroundSource } from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import type { UsersPrefsSetParams } from "../../../packages/gateway-protocol/src/schema/users.ts";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../../src/state/openclaw-state-db.ts";
import {
  ensureUserBackgroundSchema,
  writeUserBackgroundImage,
} from "../../../src/state/user-background.store.ts";
import {
  ensureUserPreferencesSchema,
  readUserPreferences,
  writeUserPreferences,
} from "../../../src/state/user-preferences.store.ts";
import { prepareUserPreferenceUpdate } from "../../../src/state/user-preferences.validation.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { installSettingsStorageLifecycle, setTestLocation } from "../test-helpers/settings-node.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { resolveServerUiPrefWriteStatus, retryServerUiPrefWrite } from "./server-prefs-controls.ts";
import { applyServerUiPrefs } from "./server-prefs-reconcile.ts";
import { createServerPrefsWriter } from "./server-prefs.test-support.ts";
import { pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

const scope = "ws://background-cas";
let profileId: string;
const none = selectBackgroundSource({ kind: "none" });
const theme = selectBackgroundSource({ kind: "theme" });
let database: DatabaseSync;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let options: { path: string };
installSettingsStorageLifecycle();
beforeAll(() => {
  options = { path: join(tempDirs.make("openclaw-background-cas-"), "state.sqlite") };
  profileId = ensureProfileForEmail("cas@example.test", options).id;
  ensureUserPreferencesSchema(options);
  ensureUserBackgroundSchema(options);
});
afterAll(async () => {
  await closeOpenClawStateDatabaseAsync();
});
beforeEach(() => {
  setTestLocation({ protocol: "http:", host: "background-cas", pathname: "/" });
  resetServerUiPrefsSync();
  patchSettings({ gatewayUrl: scope });
  applyServerUiPrefs({}, { scope, profileId, onApplied: vi.fn() });
  // Reuse one admitted physical store, including real foreign keys and publication identity.
  database = openOpenClawStateDatabase(options).db;
  database.exec("DELETE FROM user_preferences; DELETE FROM user_background_images;");
});
afterEach(() => {
  resetServerUiPrefsSync();
  vi.useRealTimers();
  if (database.isTransaction) {
    database.exec("ROLLBACK");
  }
});
const status = () => resolveServerUiPrefWriteStatus("background", scope, profileId).status;
function commit(params: UsersPrefsSetParams) {
  const prepared = prepareUserPreferenceUpdate(params.entries, params.expectedEntries);
  if (!prepared.ok) {
    throw new Error(prepared.error.code);
  }
  const result = writeUserPreferences(database, profileId, prepared.value);
  if (result.ok) {
    return { status: "ok" };
  }
  if (result.error.code === "conflict") {
    return { status: "conflict" };
  }
  throw new Error(result.error.code);
}
function requestOwner(
  hooks: {
    beforeRead?: () => Promise<void>;
    beforeWrite?: () => Promise<void>;
    afterWrite?: () => Promise<void>;
  } = {},
) {
  return vi.fn(async (method: string, params?: unknown) => {
    if (method === "users.prefs.get") {
      const entries = readUserPreferences(database, profileId);
      await hooks.beforeRead?.();
      return { status: "ok", entries };
    }
    if (method === "users.prefs.set") {
      await hooks.beforeWrite?.();
      const result = commit(params as UsersPrefsSetParams);
      await hooks.afterWrite?.();
      return result;
    }
    if (method === "themes.set") {
      return { application: "saved" };
    }
    throw new Error("Unexpected request: " + method);
  });
}

it("uses null only after an authoritative absent read, including a mixed theme batch", async () => {
  const request = requestOwner();
  const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
  patchSettings({ theme: "rose", background: none });
  pushServerUiPrefs(writer, { theme: "rose", background: none }, { profileId, canWrite: true });
  await waitForFast(() => expect(status()).toBe("saved"));
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "themes.set",
    "users.prefs.get",
    "users.prefs.set",
  ]);
  expect(request).toHaveBeenLastCalledWith("users.prefs.set", {
    entries: { "ui.background": none },
    expectedEntries: { "ui.background": null },
  });
  expect(readUserPreferences(database, profileId)).toEqual({ "ui.background": none });
});

it("uses the exact saved record to fence an explicit background deletion", async () => {
  expect(
    commit({ entries: { "ui.background": none }, expectedEntries: { "ui.background": null } }),
  ).toEqual({ status: "ok" });
  const request = requestOwner();
  const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
  pushServerUiPrefs(writer, { background: null }, { profileId, canWrite: true });
  await waitForFast(() => expect(status()).toBe("saved"));
  expect(request).toHaveBeenLastCalledWith("users.prefs.set", {
    entries: { "ui.background": null },
    expectedEntries: { "ui.background": none },
  });
  expect(readUserPreferences(database, profileId)).toEqual({});
});

it.each([undefined, "faded", "full-bleed"] as const)(
  "preserves exact presentation presence in the CAS baseline (%s)",
  async (presentation) => {
    const saved = { ...none, ...(presentation ? { presentation } : {}) };
    expect(
      commit({ entries: { "ui.background": saved }, expectedEntries: { "ui.background": null } }),
    ).toEqual({ status: "ok" });
    const request = requestOwner();
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    const edited = { ...saved, showInSessions: true };
    patchSettings({ background: edited });
    pushServerUiPrefs(writer, { background: edited }, { profileId, canWrite: true });
    await waitForFast(() => expect(status()).toBe("saved"));
    expect(request).toHaveBeenLastCalledWith("users.prefs.set", {
      entries: { "ui.background": edited },
      expectedEntries: { "ui.background": saved },
    });
    expect(readUserPreferences(database, profileId)["ui.background"]).toEqual(edited);
  },
);

it("advances the CAS baseline only after its own acknowledgement for rapid placement edits", async () => {
  const acknowledgement = createDeferred();
  let first = true;
  const request = requestOwner({
    afterWrite: async () => {
      if (first) {
        first = false;
        await acknowledgement.promise;
      }
    },
  });
  const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
  patchSettings({ background: theme });
  pushServerUiPrefs(writer, { background: theme }, { profileId, canWrite: true });
  await waitForFast(() =>
    expect(readUserPreferences(database, profileId)["ui.background"]).toEqual(theme),
  );
  const edited = { ...theme, showInSessions: false, visibility: 0.2 };
  patchSettings({ background: edited });
  pushServerUiPrefs(writer, { background: edited }, { profileId, canWrite: true });
  acknowledgement.resolve();
  await waitForFast(() => expect(status()).toBe("saved"));
  expect(
    request.mock.calls
      .filter(([method]) => method === "users.prefs.set")
      .map(([, params]) => params),
  ).toEqual([
    { entries: { "ui.background": theme }, expectedEntries: { "ui.background": null } },
    { entries: { "ui.background": edited }, expectedEntries: { "ui.background": theme } },
  ]);
  expect(readUserPreferences(database, profileId)["ui.background"]).toEqual(edited);
});

it("does not auto-rebase a conflict over an atomic upload, then uses the refreshed base on manual retry", async () => {
  vi.useFakeTimers();
  const dispatch = createDeferred();
  const request = requestOwner({ beforeWrite: () => dispatch.promise });
  const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
  const afterCommit = vi.fn();
  patchSettings({ background: none });
  pushServerUiPrefs(writer, { background: none }, { profileId, canWrite: true, afterCommit });
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("users.prefs.set", {
      entries: { "ui.background": none },
      expectedEntries: { "ui.background": null },
    }),
  );
  const uploaded = selectBackgroundSource({ kind: "custom", assetId: "uploaded-elsewhere" });
  // Model the other connection's already-authorized atomic asset/preference commit.
  database.exec("BEGIN");
  writeUserBackgroundImage(database, {
    profile_id: profileId,
    asset_id: "uploaded-elsewhere",
    image: Buffer.from([1]),
    width: 1,
    height: 1,
  });
  expect(
    commit({ entries: { "ui.background": uploaded }, expectedEntries: { "ui.background": null } }),
  ).toEqual({ status: "ok" });
  database.exec("COMMIT");
  dispatch.resolve();
  await waitForFast(() =>
    expect(afterCommit).toHaveBeenCalledWith({ needsRefresh: false, retainedLocal: true }),
  );
  expect(status()).toBe("error");
  expect(loadSettings().background).toEqual(none);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(1);
  expect(readUserPreferences(database, profileId)["ui.background"]).toEqual(uploaded);
  expect(retryServerUiPrefWrite("background", scope, profileId)).toBe(true);
  await waitForFast(() => expect(status()).toBe("saved"));
  expect(request).toHaveBeenLastCalledWith("users.prefs.set", {
    entries: { "ui.background": none },
    expectedEntries: { "ui.background": uploaded },
  });
  expect(readUserPreferences(database, profileId)["ui.background"]).toEqual(none);
});

it.each(["newer-intent", "identity-switch"] as const)(
  "revalidates after a baseline read: %s",
  async (change) => {
    const read = createDeferred();
    const request = requestOwner({ beforeRead: () => read.promise });
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    patchSettings({ background: none });
    pushServerUiPrefs(writer, { background: none }, { profileId, canWrite: true });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    if (change === "newer-intent") {
      patchSettings({ background: theme });
      pushServerUiPrefs(writer, { background: theme }, { profileId, canWrite: true });
    } else {
      applyServerUiPrefs({}, { scope, profileId: "another-profile", onApplied: vi.fn() });
    }
    read.resolve();
    await vi.dynamicImportSettled();
    if (change === "newer-intent") {
      await waitForFast(() => expect(status()).toBe("saved"));
      expect(request).toHaveBeenLastCalledWith("users.prefs.set", {
        entries: { "ui.background": theme },
        expectedEntries: { "ui.background": null },
      });
    } else {
      expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(0);
      expect(readUserPreferences(database, profileId)).toEqual({});
    }
  },
);

it("keeps a failed baseline read visible and retries it without guessing an expected record", async () => {
  let readFails = true;
  const request = requestOwner({
    beforeRead: async () => {
      if (readFails) {
        throw new Error("Profile read failed");
      }
    },
  });
  const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
  patchSettings({ background: none });
  pushServerUiPrefs(writer, { background: none }, { profileId, canWrite: true });
  await waitForFast(() => expect(status()).toBe("error"));
  expect(request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(0);
  readFails = false;
  expect(retryServerUiPrefWrite("background", scope, profileId)).toBe(true);
  await waitForFast(() => expect(status()).toBe("saved"));
  expect(request).toHaveBeenLastCalledWith("users.prefs.set", {
    entries: { "ui.background": none },
    expectedEntries: { "ui.background": null },
  });
});
