import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BACKGROUND_PREFERENCE,
  type BackgroundPreference,
} from "../../packages/gateway-protocol/src/schema/background-preferences.js";
import type { UsersBackgroundResult } from "../../packages/gateway-protocol/src/schema/users-background.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { FIRST_USE_STATE_TABLES, FIRST_USE_STATE_INDEXES } from "./openclaw-state-db-contract.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseForTest,
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

vi.mock("./user-background-image.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./user-background-image.js")>()),
  normalizeUserBackgroundImage: vi.fn(),
}));
const normalized = { image: Buffer.from([255, 216, 255, 217]), width: 1, height: 1 };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
beforeEach(() => vi.mocked(normalizeUserBackgroundImage).mockReset().mockResolvedValue(normalized));
const empty = { expectedAssetId: null, expectedPreference: null };
function setup() {
  const options = { path: join(tempDirs.make("openclaw-background-"), "openclaw.sqlite") };
  const first = ensureProfileForEmail("first@example.test", options);
  const second = ensureProfileForEmail("second@example.test", options);
  return {
    options,
    first: first.id,
    second: second.id,
    db: openOpenClawStateDatabase(options).db,
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
    const { options, first, db } = setup();
    await getUserBackground(first, options);
    const native = vi.spyOn(db, "prepare");
    try {
      const uploaded = snapshot(
        await uploadUserBackground(first, { ...empty, imageBase64: "fixture" }, options),
      );
      expect(await getUserBackground(first, options)).toEqual(uploaded);
      expect((await getUserBackgroundImage(first, uploaded.asset!.assetId, options)).image).toEqual(
        new Uint8Array(normalized.image),
      );
      const head = await getUserBackgroundImage(first, uploaded.asset!.assetId, {
        ...options,
        includeBytes: false,
      });
      expect(head.image).toBeUndefined();
      expect(head.byteLength).toBe(normalized.image.byteLength);
      expect(head.isCurrent()).toBe(true);
      expect((await removeUserBackground(first, expected(uploaded), options)).status).toBe("ok");
      expect(head.isCurrent()).toBe(false);
      expect(native).not.toHaveBeenCalled();
    } finally {
      native.mockRestore();
    }
  });

  it("retains one private image while hidden, replaces atomically, and removes selection coherently", async () => {
    const { options, first, second, db, setBackground } = setup();
    expect(await getUserBackground(first, options)).toEqual({
      status: "ok",
      asset: null,
      preference: null,
    });
    expect(tableExists(db, "user_background_images")).toBe(false);
    const initial = snapshot(
      await uploadUserBackground(first, { ...empty, imageBase64: "fixture" }, options),
    );
    const assetId = initial.asset!.assetId;
    expect(initial.preference).toEqual({
      ...DEFAULT_BACKGROUND_PREFERENCE,
      showInSessions: false,
      source: { kind: "custom", assetId },
    });
    expect((await getUserBackgroundImage(second, assetId, options)).image).toBeUndefined();
    expect([...(await getUserBackgroundImage(first, assetId, options)).image!]).toEqual([
      ...normalized.image,
    ]);
    const hidden = { ...initial.preference!, source: { kind: "none" } };
    expect(setBackground(first, hidden, initial.preference).ok).toBe(true);
    expect(snapshot(await getUserBackground(first, options)).asset?.assetId).toBe(assetId);
    expect(
      await uploadUserBackground(first, { ...expected(initial), imageBase64: "stale" }, options),
    ).toEqual({ status: "conflict" });
    const replacement = snapshot(
      await uploadUserBackground(
        first,
        { ...expected(await getUserBackground(first, options)), imageBase64: "new" },
        options,
      ),
    );
    expect(replacement.asset?.assetId).not.toBe(assetId);
    expect((await getUserBackgroundImage(first, assetId, options)).image).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS count FROM user_background_images").get()?.count).toBe(1);
    expect(await removeUserBackground(first, expected(initial), options)).toEqual({
      status: "conflict",
    });
    const removed = snapshot(await removeUserBackground(first, expected(replacement), options));
    expect(removed.asset).toBeNull();
    expect(removed.preference?.source).toEqual({ kind: "none" });
    expect(
      (await getUserBackgroundImage(first, replacement.asset!.assetId, options)).image,
    ).toBeUndefined();
  });

  it.each(["theme", "none"] as const)(
    "first upload opts into New Session only after an existing %s selection",
    async (kind) => {
      const { options, first, setBackground } = setup();
      const previous = {
        ...DEFAULT_BACKGROUND_PREFERENCE,
        source: { kind },
        showOnNewSession: false,
        showInSessions: true,
      };
      expect(setBackground(first, previous, null).ok).toBe(true);
      const initial = snapshot(
        await uploadUserBackground(
          first,
          { expectedAssetId: null, expectedPreference: previous, imageBase64: "fixture" },
          options,
        ),
      );
      expect(initial.preference).toMatchObject({
        source: { kind: "custom" },
        showOnNewSession: true,
        showInSessions: false,
      });
      const explicit = { ...initial.preference!, showOnNewSession: false, showInSessions: true };
      expect(setBackground(first, explicit, initial.preference).ok).toBe(true);
      const replacement = snapshot(
        await uploadUserBackground(
          first,
          {
            expectedAssetId: initial.asset!.assetId,
            expectedPreference: explicit,
            imageBase64: "replacement",
          },
          options,
        ),
      );
      expect(replacement.preference).toMatchObject({
        showOnNewSession: false,
        showInSessions: true,
      });
    },
  );

  it.each([undefined, "faded", "full-bleed"] as const)(
    "retains presentation %s through preference writes, upload, replacement, and removal",
    async (presentation) => {
      const { options, first, setBackground } = setup();
      const previous: BackgroundPreference = {
        ...DEFAULT_BACKGROUND_PREFERENCE,
        ...(presentation ? { presentation } : {}),
      };
      expect(setBackground(first, previous, null).ok).toBe(true);
      expect(getUserPreferences(first, ["ui.background"], options)).toStrictEqual({
        "ui.background": previous,
      });
      expect(snapshot(await getUserBackground(first, options)).preference).toStrictEqual(previous);

      const uploaded = snapshot(
        await uploadUserBackground(
          first,
          { expectedAssetId: null, expectedPreference: previous, imageBase64: "fixture" },
          options,
        ),
      );
      expect(uploaded.preference).toStrictEqual({
        ...previous,
        showOnNewSession: true,
        showInSessions: false,
        source: { kind: "custom", assetId: uploaded.asset!.assetId },
      });
      const replacement = snapshot(
        await uploadUserBackground(
          first,
          { ...expected(uploaded), imageBase64: "replacement" },
          options,
        ),
      );
      expect(replacement.preference).toStrictEqual({
        ...uploaded.preference,
        source: { kind: "custom", assetId: replacement.asset!.assetId },
      });
      const theme = { ...replacement.preference!, source: { kind: "theme" } };
      expect(setBackground(first, theme, replacement.preference).ok).toBe(true);
      const unselected = snapshot(await getUserBackground(first, options));
      expect(unselected.preference).toStrictEqual(theme);
      expect(unselected.asset).toStrictEqual(replacement.asset);
      expect(setBackground(first, replacement.preference, theme).ok).toBe(true);
      const removed = snapshot(await removeUserBackground(first, expected(replacement), options));
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
    const { options, first, setBackground } = setup();
    const initial = snapshot(
      await uploadUserBackground(first, { ...empty, imageBase64: "fixture" }, options),
    );
    expect(initial.preference).not.toHaveProperty("presentation");
    const readable = { ...initial.preference!, presentation: "faded" as const };
    const changed = { ...readable, visibility: 0.7 };
    expect(setBackground(first, changed, readable)).toEqual({
      ok: false,
      error: { code: "conflict" },
    });
    const incorrectExpected = { ...expected(initial), expectedPreference: readable };
    expect(await removeUserBackground(first, incorrectExpected, options)).toEqual({
      status: "conflict",
    });
    expect(
      await uploadUserBackground(first, { ...incorrectExpected, imageBase64: "stale" }, options),
    ).toEqual({ status: "conflict" });
    expect(await getUserBackground(first, options)).toStrictEqual(initial);
    expect(setBackground(first, readable, initial.preference).ok).toBe(true);
    expect(setBackground(first, changed, initial.preference)).toEqual({
      ok: false,
      error: { code: "conflict" },
    });
    expect(await removeUserBackground(first, expected(initial), options)).toEqual({
      status: "conflict",
    });
    const current = snapshot(await getUserBackground(first, options));
    expect(current.preference).toStrictEqual(readable);
    expect((await removeUserBackground(first, expected(current), options)).status).toBe("ok");
  });

  it("refuses an in-flight upload when only presentation changes", async () => {
    const { options, first, setBackground } = setup();
    const initial = snapshot(
      await uploadUserBackground(first, { ...empty, imageBase64: "fixture" }, options),
    );
    const decoding = createDeferred<typeof normalized>();
    const started = createDeferred();
    vi.mocked(normalizeUserBackgroundImage).mockImplementationOnce(() => {
      started.resolve();
      return decoding.promise;
    });
    const pending = uploadUserBackground(
      first,
      { ...expected(initial), imageBase64: "delayed" },
      options,
    );
    await Promise.race([
      started.promise,
      pending.then(() => {
        throw new Error("Upload finished before decoding");
      }),
    ]);
    const fullBleed = { ...initial.preference!, presentation: "full-bleed" as const };
    const saved = setBackground(first, fullBleed, initial.preference);
    decoding.resolve(normalized);
    expect(await pending).toEqual({ status: "conflict" });
    expect(saved.ok).toBe(true);
    expect(await getUserBackground(first, options)).toStrictEqual({
      ...initial,
      preference: fullBleed,
    });
  });

  it("rejects invalid presentation in generic preference values and comparison snapshots", async () => {
    const { options, first, setBackground } = setup();
    const preference = { ...DEFAULT_BACKGROUND_PREFERENCE, presentation: "full-bleed" };
    expect(setBackground(first, preference, null).ok).toBe(true);
    const invalid = { ...preference, presentation: "fullBleed" };
    for (const [value, expectedPreference] of [
      [invalid, preference],
      [preference, invalid],
    ]) {
      expect(setBackground(first, value, expectedPreference)).toEqual({
        ok: false,
        error: { code: "invalid-value", key: "ui.background" },
      });
    }
    expect(snapshot(await getUserBackground(first, options)).preference).toStrictEqual(preference);
  });

  it("rejects foreign or retired custom IDs and unfenced preference changes", async () => {
    const { options, first, second, setBackground } = setup();
    const uploaded = snapshot(
      await uploadUserBackground(first, { ...empty, imageBase64: "fixture" }, options),
    );
    expect(setBackground(second, uploaded.preference, null)).toEqual({
      ok: false,
      error: { code: "invalid-value", key: "ui.background" },
    });
    expect(setUserPreferences(first, { "ui.background": null }, options)).toEqual({
      ok: false,
      error: { code: "conflict" },
    });
    expect(getUserPreferences(second, ["ui.background"], options)).toEqual({});
  });

  it("rechecks preferences and profile liveness after decoding, without retargeting a merged profile", async () => {
    const { options, first, second } = setup();
    const decoding = createDeferred<typeof normalized>();
    const started = createDeferred();
    vi.mocked(normalizeUserBackgroundImage).mockImplementationOnce(() => {
      started.resolve();
      return decoding.promise;
    });
    const pending = uploadUserBackground(first, { ...empty, imageBase64: "delayed" }, options);
    await Promise.race([
      started.promise,
      pending.then(() => {
        throw new Error("Upload finished before decoding");
      }),
    ]);
    await linkEmail("first@example.test", second, options);
    decoding.resolve(normalized);
    expect(await pending).toEqual({ status: "conflict" });
    expect(snapshot(await getUserBackground(second, options)).asset).toBeNull();
  });

  it("rolls back the image if the preference quota rejects its selection", async () => {
    const { options, first, db } = setup();
    for (let batch = 0; batch < 4; batch++) {
      expect(
        setUserPreferences(
          first,
          Object.fromEntries(
            Array.from({ length: 32 }, (_, index) => ["existing-" + (batch * 32 + index), true]),
          ),
          options,
        ).ok,
      ).toBe(true);
    }
    await expect(
      uploadUserBackground(first, { ...empty, imageBase64: "fixture" }, options),
    ).rejects.toThrow("profile-key-limit");
    expect(await getUserBackground(first, options)).toEqual({
      status: "ok",
      asset: null,
      preference: null,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM user_background_images").get()?.count).toBe(0);
  });

  it("rolls back both rows when current authority is revoked at the final commit guard", async () => {
    const { options, first } = setup();
    const initial = await uploadUserBackground(
      first,
      { ...empty, imageBase64: "fixture" },
      options,
    );
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
      await expect(
        uploadUserBackground(first, { ...expected(initial), imageBase64: "new" }, options),
      ).rejects.toThrow("request revoked");
    } finally {
      guard.mockRestore();
    }
    expect(await getUserBackground(first, options)).toEqual(initial);
  });

  it.each([false, true])(
    "merges retained uploads with target precedence (target present: %s)",
    async (targetPresent) => {
      const { options, first, second, db } = setup();
      const source = await uploadUserBackground(
        first,
        { ...empty, imageBase64: "source" },
        options,
      );
      const target = targetPresent
        ? await uploadUserBackground(second, { ...empty, imageBase64: "target" }, options)
        : undefined;
      await linkEmail("first@example.test", second, options);
      const merged = snapshot(await getUserBackground(second, options));
      expect(merged.asset).toEqual(snapshot(target ?? source).asset);
      expect(merged.preference).toEqual(snapshot(target ?? source).preference);
      expect(db.prepare("SELECT COUNT(*) AS count FROM user_background_images").get()?.count).toBe(
        1,
      );
      db.prepare("DELETE FROM user_profiles WHERE id = ?").run(second);
      expect(db.prepare("SELECT COUNT(*) AS count FROM user_background_images").get()?.count).toBe(
        0,
      );
    },
  );

  it("keeps same-version older readers safe and preserves the retained image on candidate reopen", async () => {
    const { options, first, db } = setup();
    const version = db.prepare("PRAGMA user_version").get();
    const initial = await uploadUserBackground(
      first,
      { ...empty, imageBase64: "fixture" },
      options,
    );
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
    expect(await getUserBackground(first, options)).toEqual(initial);
    expect(openOpenClawStateDatabase(options).db.prepare("PRAGMA user_version").get()).toEqual(
      version,
    );
  });
});
