import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BACKGROUND_PREFERENCE,
  type BackgroundPreference,
} from "../../packages/gateway-protocol/src/schema/background-preferences.js";
import type {
  UsersBackgroundRemoveParams,
  UsersBackgroundResult,
} from "../../packages/gateway-protocol/src/schema/users-background.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.test-support.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { FIRST_USE_STATE_TABLES, FIRST_USE_STATE_INDEXES } from "./openclaw-state-db-contract.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { normalizeUserBackgroundImage } from "./user-background-image.js";
import {
  getUserBackground,
  getUserBackgroundImage,
  removeUserBackground,
  uploadUserBackground,
} from "./user-background.js";
import { getUserPreferences, setUserPreferences } from "./user-preferences.test-support.js";
import { linkCanonicalUserProfileEmail as linkEmail } from "./user-profile-writes.js";
import { ensureProfileForEmail } from "./user-profiles.js";
import { fillUserPreferences, useUserStateFixture } from "./user-state.test-support.js";

vi.mock("./user-background-image.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./user-background-image.js")>()),
  normalizeUserBackgroundImage: vi.fn(),
}));
const normalized = { image: Buffer.from([255, 216, 255, 217]), width: 1, height: 1 };
const stateOptions = useUserStateFixture("openclaw-background-");
beforeEach(() => vi.mocked(normalizeUserBackgroundImage).mockReset().mockResolvedValue(normalized));
const empty = { expectedAssetId: null, expectedPreference: null };
const conflict = { status: "conflict" };
const preferenceConflict = { ok: false, error: { code: "conflict" } };
const invalidBackground = { ok: false, error: { code: "invalid-value", key: "ui.background" } };
const absent = { status: "ok", asset: null, preference: null };

function setup() {
  const options = stateOptions();
  const first = ensureProfileForEmail("first@example.test", options);
  const second = ensureProfileForEmail("second@example.test", options);
  const db = openOpenClawStateDatabase(options).db;
  return {
    options,
    first: first.id,
    second: second.id,
    db,
    imageCount: () =>
      db.prepare("SELECT COUNT(*) AS count FROM user_background_images").get()?.count,
    read: () => getUserBackground(first.id, options),
    image: (assetId: string, profileId = first.id, includeBytes = true) =>
      getUserBackgroundImage(profileId, assetId, { ...options, includeBytes }),
    upload: (prior: UsersBackgroundRemoveParams = empty, imageBase64 = "fixture") =>
      uploadUserBackground(first.id, { ...prior, imageBase64 }, options),
    remove: (prior: UsersBackgroundRemoveParams) => removeUserBackground(first.id, prior, options),
    setBackground: (profileId: string, value: unknown, expectedPreference: unknown) =>
      setUserPreferences(
        profileId,
        { "ui.background": value },
        { ...options, expectedEntries: { "ui.background": expectedPreference } },
      ),
  };
}
function snapshot(result: UsersBackgroundResult) {
  expect(result.status).toBe("ok");
  if (result.status !== "ok") {
    throw new Error("Expected committed background");
  }
  return result;
}
function expected(result: UsersBackgroundResult) {
  const current = snapshot(result);
  return {
    expectedAssetId: current.asset?.assetId ?? null,
    expectedPreference: current.preference,
  };
}

describe("private profile backgrounds", () => {
  it("runs background reads and writes off the caller's SQLite handle", async () => {
    const { db, read, upload, image, remove } = setup();
    await read();
    const native = vi.spyOn(db, "prepare");
    const uploaded = snapshot(await upload());
    expect(await read()).toEqual(uploaded);
    expect((await image(uploaded.asset!.assetId)).image).toEqual(new Uint8Array(normalized.image));
    const head = await image(uploaded.asset!.assetId, undefined, false);
    expect(head).toMatchObject({ image: undefined, byteLength: normalized.image.byteLength });
    expect(head.isCurrent()).toBe(true);
    expect((await remove(expected(uploaded))).status).toBe("ok");
    expect(head.isCurrent()).toBe(false);
    expect(native).not.toHaveBeenCalled();
  });

  it("retains one private image while hidden, replaces atomically, and removes selection coherently", async () => {
    const { first, second, db, imageCount, setBackground, read, image, upload, remove } = setup();
    expect(await read()).toEqual(absent);
    expect(tableExists(db, "user_background_images")).toBe(false);
    const initial = snapshot(await upload());
    const assetId = initial.asset!.assetId;
    expect(initial.preference).toEqual({
      ...DEFAULT_BACKGROUND_PREFERENCE,
      showInSessions: false,
      source: { kind: "custom", assetId },
    });
    expect((await image(assetId, second)).image).toBeUndefined();
    expect([...(await image(assetId)).image!]).toEqual([...normalized.image]);
    const hidden = { ...initial.preference!, source: { kind: "none" } };
    expect(setBackground(first, hidden, initial.preference).ok).toBe(true);
    expect(snapshot(await read()).asset?.assetId).toBe(assetId);
    expect(await upload(expected(initial), "stale")).toEqual(conflict);
    vi.mocked(normalizeUserBackgroundImage).mockResolvedValueOnce({
      image: Buffer.from([1, 2, 3]),
      width: 2,
      height: 3,
    });
    const replacement = snapshot(await upload(expected(await read()), "new"));
    expect(replacement.asset?.assetId).not.toBe(assetId);
    expect(replacement.asset).toEqual({
      assetId: expect.any(String),
      width: 2,
      height: 3,
      mime: "image/jpeg",
      byteLength: 3,
    });
    expect(await read()).toEqual(replacement);
    expect((await image(assetId)).image).toBeUndefined();
    expect(imageCount()).toBe(1);
    expect(await remove(expected(initial))).toEqual(conflict);
    const removed = snapshot(await remove(expected(replacement)));
    expect(removed).toMatchObject({ asset: null, preference: { source: { kind: "none" } } });
    expect(await read()).toEqual(removed);
    expect((await image(replacement.asset!.assetId)).image).toBeUndefined();
  });

  it.each([
    ["theme", undefined],
    ["none", "faded"],
    ["theme", "full-bleed"],
  ] as const)(
    "preserves %s/%s preferences through upload, replacement and removal",
    async (kind, presentation) => {
      const { options, first, setBackground, upload, read, remove } = setup();
      const previous: BackgroundPreference = {
        ...DEFAULT_BACKGROUND_PREFERENCE,
        source: { kind },
        showOnNewSession: false,
        showInSessions: true,
        ...(presentation ? { presentation } : {}),
      };
      expect(setBackground(first, previous, null).ok).toBe(true);
      expect(getUserPreferences(first, ["ui.background"], options)).toStrictEqual({
        "ui.background": previous,
      });
      expect(snapshot(await read()).preference).toStrictEqual(previous);
      const uploaded = snapshot(await upload({ ...empty, expectedPreference: previous }));
      expect(uploaded.preference).toStrictEqual({
        ...previous,
        showOnNewSession: true,
        showInSessions: false,
        source: { kind: "custom", assetId: uploaded.asset!.assetId },
      });
      const explicit = { ...uploaded.preference!, showOnNewSession: false, showInSessions: true };
      expect(setBackground(first, explicit, uploaded.preference).ok).toBe(true);
      const replacement = snapshot(
        await upload({ ...expected(uploaded), expectedPreference: explicit }, "replacement"),
      );
      expect(replacement.preference).toStrictEqual({
        ...explicit,
        source: { kind: "custom", assetId: replacement.asset!.assetId },
      });
      const theme = { ...replacement.preference!, source: { kind: "theme" } };
      expect(setBackground(first, theme, replacement.preference).ok).toBe(true);
      expect(snapshot(await read())).toStrictEqual({ ...replacement, preference: theme });
      expect(setBackground(first, replacement.preference, theme).ok).toBe(true);
      const removed = snapshot(await remove(expected(replacement)));
      expect(removed.preference).toStrictEqual({
        ...replacement.preference,
        source: { kind: "none" },
      });
      expect(getUserPreferences(first, ["ui.background"], options)).toStrictEqual({
        "ui.background": removed.preference,
      });
    },
  );

  it("keeps absent and explicit readable snapshots distinct for authoritative comparisons", async () => {
    const { first, setBackground, read, upload, remove } = setup();
    const initial = snapshot(await upload());
    expect(initial.preference).not.toHaveProperty("presentation");
    const readable = { ...initial.preference!, presentation: "faded" as const };
    const changed = { ...readable, visibility: 0.7 };
    expect(setBackground(first, changed, readable)).toEqual(preferenceConflict);
    const incorrectExpected = { ...expected(initial), expectedPreference: readable };
    expect(await remove(incorrectExpected)).toEqual(conflict);
    expect(await upload(incorrectExpected, "stale")).toEqual(conflict);
    expect(await read()).toStrictEqual(initial);
    expect(setBackground(first, readable, initial.preference).ok).toBe(true);
    expect(setBackground(first, changed, initial.preference)).toEqual(preferenceConflict);
    expect(await remove(expected(initial))).toEqual(conflict);
    const current = snapshot(await read());
    expect(current.preference).toStrictEqual(readable);
    expect((await remove(expected(current))).status).toBe("ok");
  });

  it.each(["presentation", "profile merge"] as const)(
    "rejects an upload when %s changes during decoding",
    async (change) => {
      const { options, first, second, setBackground, read, upload } = setup();
      const initial = change === "presentation" ? snapshot(await upload()) : undefined;
      const decoding = createDeferred<typeof normalized>();
      const started = createDeferred();
      vi.mocked(normalizeUserBackgroundImage).mockImplementationOnce(() => {
        started.resolve();
        return decoding.promise;
      });
      const pending = upload(initial ? expected(initial) : empty, "delayed");
      await Promise.race([
        started.promise,
        pending.then(() => {
          throw new Error("Upload finished before decoding");
        }),
      ]);
      const fullBleed = initial && { ...initial.preference!, presentation: "full-bleed" as const };
      const saved = fullBleed
        ? setBackground(first, fullBleed, initial!.preference)
        : await linkEmail("first@example.test", second, options);
      decoding.resolve(normalized);
      expect(await pending).toEqual(conflict);
      if (initial) {
        expect(saved).toMatchObject({ ok: true });
        expect(await read()).toStrictEqual({ ...initial, preference: fullBleed });
      } else {
        expect(snapshot(await getUserBackground(second, options)).asset).toBeNull();
      }
    },
  );

  it("rejects invalid presentation in generic preference values and comparison snapshots", async () => {
    const { first, setBackground, read } = setup();
    const preference = { ...DEFAULT_BACKGROUND_PREFERENCE, presentation: "full-bleed" };
    expect(setBackground(first, preference, null).ok).toBe(true);
    const invalid = { ...preference, presentation: "fullBleed" };
    for (const [value, expectedPreference] of [
      [invalid, preference],
      [preference, invalid],
    ]) {
      expect(setBackground(first, value, expectedPreference)).toEqual(invalidBackground);
    }
    expect(snapshot(await read()).preference).toStrictEqual(preference);
  });

  it("rejects foreign or retired custom IDs and unfenced preference changes", async () => {
    const { options, first, second, setBackground, upload } = setup();
    const uploaded = snapshot(await upload());
    expect(setBackground(second, uploaded.preference, null)).toEqual(invalidBackground);
    expect(setUserPreferences(first, { "ui.background": null }, options)).toEqual(
      preferenceConflict,
    );
    expect(getUserPreferences(second, ["ui.background"], options)).toEqual({});
  });

  it("rolls back the image if the preference quota rejects its selection", async () => {
    const { options, first, imageCount, upload, read } = setup();
    fillUserPreferences(options, first, 128, "existing");
    await expect(upload()).rejects.toThrow("profile-key-limit");
    expect(await read()).toEqual(absent);
    expect(imageCount()).toBe(0);
  });

  it("rolls back both rows when current authority is revoked at the final commit guard", async () => {
    const { upload, read } = setup();
    const initial = await upload();
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    const guard = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit") {
            throw new Error("request revoked");
          }
          admit(request, grant);
        }),
      );
    try {
      await expect(upload(expected(initial), "new")).rejects.toThrow("request revoked");
    } finally {
      guard.mockRestore();
    }
    expect(await read()).toEqual(initial);
  });

  it.each([false, true])(
    "merges retained uploads with target precedence (target present: %s)",
    async (targetPresent) => {
      const { options, second, db, imageCount, upload } = setup();
      const source = await upload(empty, "source");
      const target = targetPresent
        ? await uploadUserBackground(second, { ...empty, imageBase64: "target" }, options)
        : undefined;
      await linkEmail("first@example.test", second, options);
      const merged = snapshot(await getUserBackground(second, options));
      expect(merged.asset).toEqual(snapshot(target ?? source).asset);
      expect(merged.preference).toEqual(snapshot(target ?? source).preference);
      expect(imageCount()).toBe(1);
      db.prepare("DELETE FROM user_profiles WHERE id = ?").run(second);
      expect(imageCount()).toBe(0);
    },
  );

  it("keeps same-version older readers safe and preserves the retained image on candidate reopen", async () => {
    const { options, first, db, upload, read } = setup();
    const version = db.prepare("PRAGMA user_version").get();
    const initial = await upload();
    await closeOpenClawStateDatabaseByPathAsync(options.path);
    const olderReader = new DatabaseSync(options.path);
    try {
      const previousSchema = OPENCLAW_STATE_SCHEMA_SQL.replace(
        /CREATE TABLE IF NOT EXISTS user_background_images \([\s\S]*?\) STRICT;\n/,
        "",
      );
      assertSqliteSchemaContains(olderReader, options.path, previousSchema, {
        allowedMissingTables: [...FIRST_USE_STATE_TABLES],
        allowedMissingIndexes: [...FIRST_USE_STATE_INDEXES],
      });
      olderReader
        .prepare("UPDATE user_profiles SET display_name = ? WHERE id = ?")
        .run("Older reader", first);
      expect(olderReader.prepare("PRAGMA user_version").get()).toEqual(version);
      expect(olderReader.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    } finally {
      olderReader.close();
    }
    expect(await read()).toEqual(initial);
    expect(openOpenClawStateDatabase(options).db.prepare("PRAGMA user_version").get()).toEqual(
      version,
    );
  });
});
