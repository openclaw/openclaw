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
import { createServerPrefsWriter } from "./server-prefs.test-support.ts";
import { pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

const scope = "ws://background-cas";
let profileId: string;
const none = selectBackgroundSource({ kind: "none" });
const theme = selectBackgroundSource({ kind: "theme" });
let database: EngineConnection;
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
const backgroundEntries = (value: BackgroundPreference | null) => ({ "ui.background": value });
const storedBackground = () => readUserPreferences(database, profileId)["ui.background"];
const update = (value: BackgroundPreference | null, expected: BackgroundPreference | null) => ({
  entries: backgroundEntries(value),
  expectedEntries: backgroundEntries(expected),
});
const writes = (request: ReturnType<typeof requestOwner>["request"]) =>
  request.mock.calls.filter(([method]) => method === "users.prefs.set");
function edit(
  writer: ReturnType<typeof createServerPrefsWriter>,
  background: BackgroundPreference,
) {
  patchSettings({ background });
  pushServerUiPrefs(writer, { background }, { profileId, canWrite: true });
}
function expectWrite(
  request: ReturnType<typeof requestOwner>["request"],
  value: BackgroundPreference | null,
  expected: BackgroundPreference | null,
) {
  expect(request).toHaveBeenLastCalledWith("users.prefs.set", update(value, expected));
}
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
  const request = vi.fn(async (method: string, params?: unknown) => {
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
  return { request, writer: createServerPrefsWriter(request, scope, true, { ok: true }, false) };
}

it("uses null only after an authoritative absent read, including a mixed theme batch", async () => {
  const { request, writer } = requestOwner();
  patchSettings({ theme: "rose", background: none });
  pushServerUiPrefs(writer, { theme: "rose", background: none }, { profileId, canWrite: true });
  await waitForFast(() => expect(status()).toBe("saved"));
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "themes.set",
    "users.prefs.get",
    "users.prefs.set",
  ]);
  expectWrite(request, none, null);
  expect(readUserPreferences(database, profileId)).toEqual({ "ui.background": none });
});

it("uses the exact saved record to fence an explicit background deletion", async () => {
  expect(commit(update(none, null))).toEqual({ status: "ok" });
  const { request, writer } = requestOwner();
  pushServerUiPrefs(writer, { background: null }, { profileId, canWrite: true });
  await waitForFast(() => expect(status()).toBe("saved"));
  expectWrite(request, null, none);
  expect(readUserPreferences(database, profileId)).toEqual({});
});

it("advances the CAS baseline only after its own acknowledgement for rapid placement edits", async () => {
  const acknowledgement = createDeferred();
  let first = true;
  const { request, writer } = requestOwner({
    afterWrite: async () => {
      if (first) {
        first = false;
        await acknowledgement.promise;
      }
    },
  });
  edit(writer, theme);
  await waitForFast(() => expect(storedBackground()).toEqual(theme));
  const edited = { ...theme, showInSessions: false, visibility: 0.2 };
  edit(writer, edited);
  acknowledgement.resolve();
  await waitForFast(() => expect(status()).toBe("saved"));
  expect(writes(request).map(([, params]) => params)).toEqual([
    update(theme, null),
    update(edited, theme),
  ]);
  expect(storedBackground()).toEqual(edited);
});

it("does not auto-rebase a conflict over an atomic upload, then uses the refreshed base on manual retry", async () => {
  vi.useFakeTimers();
  const dispatch = createDeferred();
  const { request, writer } = requestOwner({ beforeWrite: () => dispatch.promise });
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
  expect(writes(request)).toHaveLength(1);
  expect(storedBackground()).toEqual(uploaded);
  expect(retryServerUiPrefWrite("background", scope, profileId)).toBe(true);
  await waitForFast(() => expect(status()).toBe("saved"));
  expectWrite(request, none, uploaded);
  expect(storedBackground()).toEqual(none);
});

it.each(["newer-intent", "identity-switch"] as const)(
  "revalidates after a baseline read: %s",
  async (change) => {
    const read = createDeferred();
    const { request, writer } = requestOwner({ beforeRead: () => read.promise });
    edit(writer, none);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    if (change === "newer-intent") {
      edit(writer, theme);
    } else {
      applyServerUiPrefs({}, { scope, profileId: "another-profile", onApplied: vi.fn() });
    }
    read.resolve();
    await vi.dynamicImportSettled();
    if (change === "newer-intent") {
      await waitForFast(() => expect(status()).toBe("saved"));
      expectWrite(request, theme, null);
    } else {
      expect(writes(request)).toHaveLength(0);
      expect(readUserPreferences(database, profileId)).toEqual({});
    }
  },
);

it("keeps a failed baseline read visible and retries it without guessing an expected record", async () => {
  let readFails = true;
  const { request, writer } = requestOwner({
    beforeRead: async () => {
      if (readFails) {
        throw new Error("Profile read failed");
      }
    },
  });
  edit(writer, none);
  await waitForFast(() => expect(status()).toBe("error"));
  expect(writes(request)).toHaveLength(0);
  readFails = false;
  expect(retryServerUiPrefWrite("background", scope, profileId)).toBe(true);
  await waitForFast(() => expect(status()).toBe("saved"));
  expectWrite(request, none, null);
});
