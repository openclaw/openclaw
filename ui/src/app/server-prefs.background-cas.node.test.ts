// @vitest-environment node
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  type BackgroundPreference,
  selectBackgroundSource,
} from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import type { UsersPrefsSetParams } from "../../../packages/gateway-protocol/src/schema/users.ts";
import type { EngineConnection } from "../../../src/infra/sql-connection.ts";
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
import { createServerPrefsWriter, type RequestMock } from "./server-prefs.test-support.ts";
import { pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

const scope = "ws://background-cas";
let profileId: string;
const none = selectBackgroundSource({ kind: "none" });
const theme = selectBackgroundSource({ kind: "theme" });
let database: EngineConnection;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let options: { path: string };
let request: RequestMock;
let writer: ReturnType<typeof createServerPrefsWriter>;
let hooks: Partial<Record<"beforeRead" | "beforeWrite" | "afterWrite", () => Promise<void>>>;
installSettingsStorageLifecycle();
beforeAll(() => {
  options = { path: join(tempDirs.make("openclaw-background-cas-"), "state.sqlite") };
  profileId = ensureProfileForEmail("cas@example.test", options).id;
  ensureUserPreferencesSchema(options);
  ensureUserBackgroundSchema(options);
});
afterAll(() => closeOpenClawStateDatabaseAsync());
beforeEach(() => {
  setTestLocation({ protocol: "http:", host: "background-cas", pathname: "/" });
  resetServerUiPrefsSync();
  patchSettings({ gatewayUrl: scope });
  applyServerUiPrefs({}, { scope, profileId, onApplied: vi.fn() });
  // Reuse one admitted physical store, including real foreign keys and publication identity.
  database = openOpenClawStateDatabase(options).db;
  database.exec("DELETE FROM user_preferences; DELETE FROM user_background_images;");
  hooks = {};
  request = requestOwner();
  writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
});
afterEach(() => {
  resetServerUiPrefsSync();
  vi.useRealTimers();
  if (database.isTransaction) {
    database.exec("ROLLBACK");
  }
});
const status = () => resolveServerUiPrefWriteStatus("background", scope, profileId).status;
const backgroundEntries = (value: BackgroundPreference | null) => ({ "ui.background": value });
const storedBackground = () => readUserPreferences(database, profileId)["ui.background"];
const update = (value: BackgroundPreference | null, expected: BackgroundPreference | null) => ({
  entries: backgroundEntries(value),
  expectedEntries: backgroundEntries(expected),
});
const writes = () => request.mock.calls.filter(([method]) => method === "users.prefs.set");
function edit(background: BackgroundPreference) {
  patchSettings({ background });
  pushServerUiPrefs(writer, { background }, { profileId, canWrite: true });
}
function expectWrite(value: BackgroundPreference | null, expected: BackgroundPreference | null) {
  expect(request).toHaveBeenLastCalledWith("users.prefs.set", update(value, expected));
}
function commit(params: UsersPrefsSetParams) {
  const prepared = prepareUserPreferenceUpdate(params.entries, params.expectedEntries);
  if (!prepared.ok) {
    throw new Error(prepared.error.code);
  }
  const result = writeUserPreferences(database, profileId, prepared.value);
  if (!result.ok && result.error.code !== "conflict") {
    throw new Error(result.error.code);
  }
  return { status: result.ok ? "ok" : "conflict" };
}
function requestOwner(): RequestMock {
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
  patchSettings({ theme: "rose", background: none });
  pushServerUiPrefs(writer, { theme: "rose", background: none }, { profileId, canWrite: true });
  await waitForFast(() => expect(status()).toBe("saved"));
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "themes.set",
    "users.prefs.get",
    "users.prefs.set",
  ]);
  expectWrite(none, null);
  expect(readUserPreferences(database, profileId)).toEqual({ "ui.background": none });
});

it("uses the exact saved record to fence an explicit background deletion", async () => {
  expect(commit(update(none, null))).toEqual({ status: "ok" });
  pushServerUiPrefs(writer, { background: null }, { profileId, canWrite: true });
  await waitForFast(() => expect(status()).toBe("saved"));
  expectWrite(null, none);
  expect(readUserPreferences(database, profileId)).toEqual({});
});

it("advances the CAS baseline only after its own acknowledgement for rapid placement edits", async () => {
  const acknowledgement = createDeferred();
  hooks.afterWrite = vi
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined)
    .mockImplementationOnce(() => acknowledgement.promise);
  edit(theme);
  await waitForFast(() => expect(storedBackground()).toEqual(theme));
  const edited = { ...theme, showInSessions: false, visibility: 0.2 };
  edit(edited);
  acknowledgement.resolve();
  await waitForFast(() => expect(status()).toBe("saved"));
  expect(writes().map(([, params]) => params)).toEqual([
    update(theme, null),
    update(edited, theme),
  ]);
  expect(storedBackground()).toEqual(edited);
});

it("does not auto-rebase a conflict over an atomic upload, then uses the refreshed base on manual retry", async () => {
  vi.useFakeTimers();
  const dispatch = createDeferred();
  hooks.beforeWrite = () => dispatch.promise;
  const afterCommit = vi.fn();
  patchSettings({ background: none });
  pushServerUiPrefs(writer, { background: none }, { profileId, canWrite: true, afterCommit });
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("users.prefs.set", update(none, null)),
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
  expect(commit(update(uploaded, null))).toEqual({ status: "ok" });
  database.exec("COMMIT");
  dispatch.resolve();
  await waitForFast(() =>
    expect(afterCommit).toHaveBeenCalledWith({ needsRefresh: false, retainedLocal: true }),
  );
  expect(status()).toBe("error");
  expect(loadSettings().background).toEqual(none);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(writes()).toHaveLength(1);
  expect(storedBackground()).toEqual(uploaded);
  expect(retryServerUiPrefWrite("background", scope, profileId)).toBe(true);
  await waitForFast(() => expect(status()).toBe("saved"));
  expectWrite(none, uploaded);
  expect(storedBackground()).toEqual(none);
});

it.each(["newer-intent", "identity-switch"] as const)(
  "revalidates after a baseline read: %s",
  async (change) => {
    const read = createDeferred();
    hooks.beforeRead = () => read.promise;
    edit(none);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    if (change === "newer-intent") {
      edit(theme);
    } else {
      applyServerUiPrefs({}, { scope, profileId: "another-profile", onApplied: vi.fn() });
    }
    read.resolve();
    await vi.dynamicImportSettled();
    if (change === "newer-intent") {
      await waitForFast(() => expect(status()).toBe("saved"));
      expectWrite(theme, null);
    } else {
      expect(writes()).toHaveLength(0);
      expect(readUserPreferences(database, profileId)).toEqual({});
    }
  },
);

it("keeps a failed baseline read visible and retries it without guessing an expected record", async () => {
  let readFails = true;
  hooks.beforeRead = async () => {
    if (readFails) {
      throw new Error("Profile read failed");
    }
  };
  edit(none);
  await waitForFast(() => expect(status()).toBe("error"));
  expect(writes()).toHaveLength(0);
  readFails = false;
  expect(retryServerUiPrefWrite("background", scope, profileId)).toBe(true);
  await waitForFast(() => expect(status()).toBe("saved"));
  expectWrite(none, null);
});
