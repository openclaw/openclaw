import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  ensureProfileForEmail,
  getProfileAvatar,
  linkEmail,
  listProfiles,
  MAX_USER_PROFILE_AVATAR_BYTES,
  resolveProfileByEmail,
  setAvatar,
  setDisplayName,
} from "./user-profiles.js";

const statePaths: string[] = [];

function stateOptions() {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-user-profiles-"));
  const path = join(directory, "openclaw.sqlite");
  statePaths.push(path);
  return { path };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("user profiles", () => {
  it("lazily ensures and resolves lowercased email aliases idempotently", () => {
    const options = stateOptions();
    expect(tableExists(openOpenClawStateDatabase(options).db, "user_profiles")).toBe(false);

    const first = ensureProfileForEmail("  Ada@Example.COM ", options);
    const second = ensureProfileForEmail("ada@example.com", options);

    expect(tableExists(openOpenClawStateDatabase(options).db, "user_profiles")).toBe(true);
    expect(second).toEqual(first);
    expect(resolveProfileByEmail("ADA@example.com", options)).toEqual(first);
    expect(listProfiles(options)).toEqual([
      expect.objectContaining({ id: first.id, emails: ["ada@example.com"] }),
    ]);
  });

  it("moves aliases and leaves an aliasless source profile as a one-hop tombstone", () => {
    const options = stateOptions();
    const source = ensureProfileForEmail("source@example.com", options);
    const target = ensureProfileForEmail("target@example.com", options);

    linkEmail("source@example.com", target.id, options);

    expect(resolveProfileByEmail("source@example.com", options)?.id).toBe(target.id);
    expect(listProfiles(options)).toContainEqual(
      expect.objectContaining({ id: source.id, mergedInto: target.id, emails: [] }),
    );
  });

  it("updates display names", () => {
    const options = stateOptions();
    const profile = ensureProfileForEmail("ada@example.com", options);

    expect(setDisplayName(profile.id, "Ada Lovelace", options)).toMatchObject({
      id: profile.id,
      displayName: "Ada Lovelace",
    });
  });

  it("rejects oversized and unsupported avatar uploads", () => {
    const options = stateOptions();
    const profile = ensureProfileForEmail("ada@example.com", options);

    expect(
      setAvatar(
        profile.id,
        new Uint8Array(MAX_USER_PROFILE_AVATAR_BYTES + 1),
        "image/png",
        options,
      ),
    ).toEqual({
      ok: false,
      error: { code: "avatar_too_large", maxBytes: MAX_USER_PROFILE_AVATAR_BYTES },
    });
    expect(setAvatar(profile.id, new Uint8Array([1]), "image/gif", options)).toEqual({
      ok: false,
      error: { code: "unsupported_avatar_mime", mime: "image/gif" },
    });
  });

  it("stores an allowlisted avatar", () => {
    const options = stateOptions();
    const profile = ensureProfileForEmail("ada@example.com", options);

    expect(setAvatar(profile.id, new Uint8Array([1, 2, 3]), "image/png", options)).toEqual({
      ok: true,
      value: expect.objectContaining({ id: profile.id, avatarMime: "image/png" }),
    });
    expect(getProfileAvatar(profile.id, options)).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      mime: "image/png",
      updatedAt: expect.any(Number),
    });
  });
});
