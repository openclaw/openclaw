import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
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
function upload(id: string, bytes: Uint8Array) {
  expect(setAvatar(id, bytes, "image/png", options).ok).toBe(true);
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
  upload(profile.id, bytes);
  const uploaded = await inspect(profile.id);
  expect(uploaded.hasAvatar).toBe(true);
  expect((await uploaded.loadBytes())?.bytes).toEqual(bytes);
});

it.each(["settled", "pending"] as const)(
  "evicts %s avatar bytes without losing warm reads or in-flight coalescing",
  async (phase) => {
    const bytes = Buffer.alloc(512 * 1024, 7);
    const profiles = Array.from({ length: 33 }, (_, index) => {
      const profile = ensureProfileForEmail(`avatar-${index}@example.test`, options);
      upload(profile.id, bytes);
      return profile;
    });
    await hydrate();
    const load = async (index: number) => (await inspect(profiles[index]!.id)).loadBytes();
    const retained = await inspect(profiles[1]!.id);
    const started = createDeferred();
    const release = createDeferred();
    const originalRead = stateReads.executeExistingOpenClawStateRead;
    const heldRead =
      phase === "pending"
        ? observeReads().mockImplementationOnce(async (...args) => {
            const result = await originalRead(...args);
            started.resolve();
            await release.promise;
            return result;
          })
        : undefined;
    const firstLoad = retained.loadBytes();
    if (phase === "pending") {
      await started.promise;
    } else {
      await firstLoad;
    }
    for (let index = 0; index < 32; index++) {
      if (index !== 1) {
        await load(index);
      }
    }
    await load(0);
    await load(32);
    try {
      if (phase === "pending") {
        expect(retained.loadBytes()).toBe(firstLoad);
      }
    } finally {
      release.resolve();
      await firstLoad;
      heldRead?.mockRestore();
    }

    const other = ensureProfileForEmail("other@example.test", options);
    setDisplayName(other.id, "Changed name", options);
    const read = observeReads();
    const prepared = await inspect(profiles[0]!.id);
    expect(prepared.isCurrent()).toBe(true);
    expect(bytes.equals((await prepared.loadBytes())?.bytes ?? Buffer.alloc(0)), "warm").toBe(true);
    expect(bytes.equals((await load(0))?.bytes ?? Buffer.alloc(0)), "warm").toBe(true);
    expect(read).not.toHaveBeenCalled();
    // A retained reader must not keep an evicted payload outside the byte budget.
    expect(bytes.equals((await retained.loadBytes())?.bytes ?? Buffer.alloc(0)), "cold").toBe(true);
    expect(read).toHaveBeenCalledOnce();
  },
);

it.each(["database close and reopen", "avatar replacement"] as const)(
  "requires fresh avatar reads after %s",
  async (boundary) => {
    const profile = ensureProfileForEmail("lifetime@example.test", options);
    let bytes = new Uint8Array([1, 2, 3]);
    upload(profile.id, bytes);
    await hydrate();
    const warm = await inspect(profile.id);
    expect((await warm.loadBytes())?.bytes).toEqual(bytes);

    if (boundary === "database close and reopen") {
      await closeOpenClawStateDatabaseByPathAsync(options.path);
      openOpenClawStateDatabase(options);
      expect(() => warm.loadBytes()).toThrow("OpenClaw state database read admission changed");
    } else {
      bytes = new Uint8Array([4, 5]);
      upload(profile.id, bytes);
      await expect(warm.loadBytes()).resolves.toBeUndefined();
    }

    const fresh = await inspect(profile.id);
    expect(fresh.isCurrent()).toBe(true);
    expect((await fresh.loadBytes())?.bytes).toEqual(bytes);
  },
);
