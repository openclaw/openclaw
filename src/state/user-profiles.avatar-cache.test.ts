import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as stateReads from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { retainUserProfileCatalog } from "./user-profile-list.js";
import { createProfileAvatarReader } from "./user-profiles-avatar.js";
import { ensureProfileForEmail, setAvatar, setDisplayName } from "./user-profiles.js";

const paths: string[] = [];
const releases: (() => void)[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    for (const release of releases.splice(0)) {
      release();
    }
    vi.restoreAllMocks();
    await Promise.all(
      paths.splice(0).map((pathname) => closeOpenClawStateDatabaseByPathAsync(pathname)),
    );
    cleanup();
  });
});

function fixture() {
  const path = join(tempDirs.make("profile-avatar-cache-"), "openclaw.sqlite");
  paths.push(path);
  return { path };
}

it("evicts the least recently used avatar at the byte budget before the entry limit", async () => {
  const options = fixture();
  const bytes = new Uint8Array(512 * 1024).fill(7);
  const profiles = Array.from({ length: 33 }, (_, index) => {
    const profile = ensureProfileForEmail(`avatar-${index}@example.test`, options);
    expect(setAvatar(profile.id, bytes, "image/png", options).ok).toBe(true);
    return profile;
  });
  releases.push(retainUserProfileCatalog(options));
  const load = async (index: number) => {
    const profile = profiles[index];
    assert(profile);
    const prepared = await createProfileAvatarReader(profile.id, options).inspect();
    return await prepared.loadBytes();
  };
  for (let index = 0; index < 32; index++) {
    await load(index);
  }
  await load(0);
  await load(32);

  const read = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  expect(Buffer.from((await load(0))?.bytes ?? []).equals(bytes)).toBe(true);
  expect(read).not.toHaveBeenCalled();
  expect(Buffer.from((await load(1))?.bytes ?? []).equals(bytes)).toBe(true);
  expect(read.mock.calls.map(([, command]) => command.type)).toEqual([
    "userProfiles.avatar.inspect",
    "userProfiles.avatar.read",
  ]);
});

it.each(["catalog release", "database close and reopen", "avatar replacement"] as const)(
  "requires fresh avatar reads after %s",
  async (boundary) => {
    const options = fixture();
    const profile = ensureProfileForEmail("lifetime@example.test", options);
    let bytes = new Uint8Array([1, 2, 3]);
    expect(setAvatar(profile.id, bytes, "image/png", options).ok).toBe(true);
    const release = retainUserProfileCatalog(options);
    releases.push(release);
    const warm = await createProfileAvatarReader(profile.id, options).inspect();
    expect((await warm.loadBytes())?.bytes).toEqual(bytes);

    if (boundary === "catalog release") {
      release();
      releases.push(retainUserProfileCatalog(options));
    } else if (boundary === "database close and reopen") {
      await closeOpenClawStateDatabaseByPathAsync(options.path);
      openOpenClawStateDatabase(options);
    } else {
      bytes = new Uint8Array([4, 5]);
      expect(setAvatar(profile.id, bytes, "image/png", options).ok).toBe(true);
    }
    const staleBytes = (async () => warm.loadBytes())();
    if (boundary === "database close and reopen") {
      await expect(staleBytes).rejects.toThrow();
    } else {
      await expect(staleBytes).resolves.toBeUndefined();
    }

    const read = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    const fresh = await createProfileAvatarReader(profile.id, options).inspect();
    expect(fresh.isCurrent()).toBe(true);
    expect((await fresh.loadBytes())?.bytes).toEqual(bytes);
    expect(read.mock.calls.map(([, command]) => command.type)).toEqual([
      "userProfiles.avatar.inspect",
      "userProfiles.avatar.read",
    ]);
  },
);

it("preserves cached avatar bytes when another profile commits an edit", async () => {
  const options = fixture();
  const portrait = ensureProfileForEmail("portrait@example.test", options);
  const other = ensureProfileForEmail("other@example.test", options);
  const bytes = new Uint8Array([4, 5, 6]);
  expect(setAvatar(portrait.id, bytes, "image/png", options).ok).toBe(true);
  releases.push(retainUserProfileCatalog(options));
  await (await createProfileAvatarReader(portrait.id, options).inspect()).loadBytes();

  setDisplayName(other.id, "Changed name", options);
  const read = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  const prepared = await createProfileAvatarReader(portrait.id, options).inspect();
  expect(prepared.isCurrent()).toBe(true);
  expect((await prepared.loadBytes())?.bytes).toEqual(bytes);
  expect(read).not.toHaveBeenCalled();
});
