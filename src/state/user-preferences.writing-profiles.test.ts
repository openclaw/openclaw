import { describe, expect, it } from "vitest";
import {
  BASELINE_WRITING_POLICY,
  WRITING_PROFILES_PREFERENCE_KEY as key,
  type WritingProfileCatalog,
} from "../shared/dictation-writing-profiles.js";
import { getCanonicalUserPreferences, setCanonicalUserPreferences } from "./user-preferences.js";
import { getUserPreferences, setUserPreferences } from "./user-preferences.test-support.js";
import { ensureProfileForEmail } from "./user-profiles.js";
import { useUserStateFixture } from "./user-state.test-support.js";

const stateOptions = useUserStateFixture("openclaw-writing-profiles-");
function catalog(revision: string, count = 1): WritingProfileCatalog {
  return {
    schemaVersion: 1,
    revision,
    enabled: true,
    defaultProfileId: "profile-0",
    profiles: Array.from({ length: count }, (_, index) => ({
      id: `profile-${index}`,
      revision,
      label: `Writing profile ${index}`,
      enabled: true,
      priority: index,
      selectors: [
        { kind: "application", app: { kind: "macos-bundle-id", id: `test.app.${index}` } },
      ],
      policy: BASELINE_WRITING_POLICY,
    })),
  };
}

describe("durable writing-profile preferences", () => {
  it("allows bounded validated catalogs above 4 KiB without widening other preferences", () => {
    const options = stateOptions();
    const profileId = ensureProfileForEmail("catalog@example.test", options).id;
    const value = catalog("large", 20);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(4 * 1024);
    expect(setUserPreferences(profileId, { unrelated: "retained" }, options).ok).toBe(true);
    expect(
      setUserPreferences(
        profileId,
        { [key]: value },
        { ...options, expectedEntries: { [key]: null } },
      ),
    ).toMatchObject({ ok: true });
    expect(setUserPreferences(profileId, { other: "x".repeat(4096) }, options)).toEqual({
      ok: false,
      error: { code: "value-too-large", key: "other" },
    });
    expect(
      setUserPreferences(
        profileId,
        { [key]: { ...value, revision: "x".repeat(1024 * 1024) } },
        {
          ...options,
          expectedEntries: { [key]: value },
        },
      ),
    ).toEqual({ ok: false, error: { code: "value-too-large", key } });
    expect(getUserPreferences(profileId, undefined, options)).toEqual({
      [key]: value,
      unrelated: "retained",
    });
  });

  it("rejects malformed and future catalogs atomically and requires a comparator for deletion", () => {
    const options = stateOptions();
    const profileId = ensureProfileForEmail("import@example.test", options).id;
    const original = catalog("original");
    expect(
      setUserPreferences(
        profileId,
        { [key]: original, unrelated: "retained" },
        {
          ...options,
          expectedEntries: { [key]: null },
        },
      ).ok,
    ).toBe(true);
    for (const invalid of [
      { ...original, profiles: [original.profiles[0], original.profiles[0]] },
      { ...original, schemaVersion: 2 },
      { ...original, prompt: "untrusted imported instructions" },
    ]) {
      expect(
        setUserPreferences(
          profileId,
          { [key]: invalid, unrelated: "changed" },
          {
            ...options,
            expectedEntries: { [key]: original },
          },
        ),
      ).toEqual({ ok: false, error: { code: "invalid-value", key } });
      expect(getUserPreferences(profileId, undefined, options)).toEqual({
        [key]: original,
        unrelated: "retained",
      });
    }
    expect(setUserPreferences(profileId, { [key]: null }, options)).toEqual({
      ok: false,
      error: { code: "invalid-value", key },
    });
    expect(
      setUserPreferences(
        profileId,
        { [key]: null },
        { ...options, expectedEntries: { [key]: original } },
      ).ok,
    ).toBe(true);
    expect(getUserPreferences(profileId, undefined, options)).toEqual({ unrelated: "retained" });
  });

  it("gives concurrent worker transactions one winner and rejects stale deletion", async () => {
    const options = stateOptions();
    const profileId = ensureProfileForEmail("concurrent@example.test", options).id;
    const original = catalog("original");
    expect(
      setUserPreferences(
        profileId,
        { [key]: original, unrelated: "retained" },
        {
          ...options,
          expectedEntries: { [key]: null },
        },
      ).ok,
    ).toBe(true);
    const first = catalog("first");
    const second = catalog("second");
    const results = await Promise.all(
      [first, second].map((value) =>
        setCanonicalUserPreferences(
          profileId,
          { [key]: value },
          { ...options, expectedEntries: { [key]: original } },
        ),
      ),
    );
    expect(results.filter((result) => result?.ok)).toHaveLength(1);
    expect(results.filter((result) => result && !result.ok)).toEqual([
      { ok: false, error: { code: "conflict" } },
    ]);
    const winner = results[0]?.ok ? first : second;
    expect((await getCanonicalUserPreferences(profileId, undefined, options))?.entries).toEqual({
      [key]: winner,
      unrelated: "retained",
    });
    expect(
      await setCanonicalUserPreferences(
        profileId,
        { [key]: null, unrelated: "changed" },
        {
          ...options,
          expectedEntries: { [key]: original },
        },
      ),
    ).toEqual({ ok: false, error: { code: "conflict" } });
    expect((await getCanonicalUserPreferences(profileId, undefined, options))?.entries).toEqual({
      [key]: winner,
      unrelated: "retained",
    });
  });
});
