import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import * as stateReads from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { linkEmail, setAvatar, setDisplayName } from "./user-profile-writes.worker.js";
import { createProfileAvatarReader } from "./user-profiles-avatar.js";
import { useProfileDatabase } from "./user-profiles-fixture.test-support.js";
import { ensureProfileForEmail } from "./user-profiles.js";

const { options, hydrate } = useProfileDatabase("profile-avatar-cache-");
const inspect = (id: string) => createProfileAvatarReader(id, options).inspect();
const observeReads = () => vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
function expectByteFetch(read: ReturnType<typeof observeReads>) {
  expect(read.mock.calls.map(([, command]) => command.type)).toEqual([
    "userProfiles.avatar.inspect",
    "userProfiles.avatar.read",
  ]);
}

it("retains absent avatars until committed email or avatar changes", async () => {
  const profile = ensureProfileForEmail("gravatar@example.test", options);
  await hydrate();
  const first = await inspect(profile.id);
  expect(first).toMatchObject({ hasAvatar: false, emails: ["gravatar@example.test"] });
  const read = observeReads();
  expect(await (await inspect(profile.id)).loadBytes()).toBeUndefined();
  expect((await inspect(profile.id)).emails).toEqual(["gravatar@example.test"]);
  expect(read).not.toHaveBeenCalled();

  linkEmail("other@example.test", profile.id, options);
  expect(first.isCurrent()).toBe(false);
  expect((await inspect(profile.id)).emails).toEqual([
    "gravatar@example.test",
    "other@example.test",
  ]);
  expect(read).toHaveBeenCalledOnce();
  read.mockClear();
  const bytes = new Uint8Array([1, 2, 3]);
  expect(setAvatar(profile.id, bytes, "image/png", options).ok).toBe(true);
  const uploaded = await inspect(profile.id);
  expect(uploaded.hasAvatar).toBe(true);
  expect((await uploaded.loadBytes())?.bytes).toEqual(bytes);
  expectByteFetch(read);
});

it("evicts the least recently used avatar at the byte budget while preserving unrelated cached bytes", async () => {
  const bytes = new Uint8Array(512 * 1024).fill(7);
  const profiles = Array.from({ length: 33 }, (_, index) => {
    const profile = ensureProfileForEmail(`avatar-${index}@example.test`, options);
    expect(setAvatar(profile.id, bytes, "image/png", options).ok).toBe(true);
    return profile;
  });
  await hydrate();
  const load = async (index: number) => {
    const profile = profiles[index];
    assert(profile);
    const prepared = await inspect(profile.id);
    return await prepared.loadBytes();
  };
  for (let index = 0; index < 32; index++) {
    await load(index);
  }
  await load(0);
  await load(32);

  const other = ensureProfileForEmail("other@example.test", options);
  setDisplayName(other.id, "Changed name", options);
  const read = observeReads();
  const prepared = await inspect(profiles[0]!.id);
  expect(prepared.isCurrent()).toBe(true);
  expect((await prepared.loadBytes())?.bytes).toEqual(bytes);
  expect(Buffer.from((await load(0))?.bytes ?? []).equals(bytes)).toBe(true);
  expect(read).not.toHaveBeenCalled();
  expect(Buffer.from((await load(1))?.bytes ?? []).equals(bytes)).toBe(true);
  expectByteFetch(read);
});

it.each(["database close and reopen", "avatar replacement"] as const)(
  "requires fresh avatar reads after %s",
  async (boundary) => {
    const profile = ensureProfileForEmail("lifetime@example.test", options);
    let bytes = new Uint8Array([1, 2, 3]);
    expect(setAvatar(profile.id, bytes, "image/png", options).ok).toBe(true);
    await hydrate();
    const warm = await inspect(profile.id);
    expect((await warm.loadBytes())?.bytes).toEqual(bytes);

    if (boundary === "database close and reopen") {
      await closeOpenClawStateDatabaseByPathAsync(options.path);
      openOpenClawStateDatabase(options);
    } else {
      bytes = new Uint8Array([4, 5]);
      expect(setAvatar(profile.id, bytes, "image/png", options).ok).toBe(true);
    }
    if (boundary === "database close and reopen") {
      expect(() => warm.loadBytes()).toThrow("OpenClaw state database read admission changed");
    } else {
      await expect(warm.loadBytes()).resolves.toBeUndefined();
    }

    const read = observeReads();
    const fresh = await inspect(profile.id);
    expect(fresh.isCurrent()).toBe(true);
    expect((await fresh.loadBytes())?.bytes).toEqual(bytes);
    expectByteFetch(read);
  },
);
