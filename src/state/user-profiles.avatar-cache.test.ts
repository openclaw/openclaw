import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as stateReads from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { prepareUserProfileCatalog } from "./user-profile-list.js";
import { setAvatar, setDisplayName } from "./user-profile-writes.worker.js";
import { createProfileAvatarReader } from "./user-profiles-avatar.js";
import { ensureProfileForEmail } from "./user-profiles.js";

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

it.each(["settled", "pending"] as const)(
  "evicts %s avatar bytes without losing warm reads or in-flight coalescing",
  async (phase) => {
    const options = fixture();
    const inspect = (id: string) => createProfileAvatarReader(id, options).inspect();
    const upload = (id: string, bytes: Uint8Array) =>
      expect(setAvatar(id, bytes, "image/png", options).ok).toBe(true);
    const hydrate = async () => {
      releases.push((await prepareUserProfileCatalog(options)).release);
    };
    const observeReads = () => vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    const bytes = new Uint8Array(512 * 1024).fill(7);
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
    expect((await prepared.loadBytes())?.bytes).toEqual(bytes);
    expect((await load(0))?.bytes).toEqual(bytes);
    expect(read).not.toHaveBeenCalled();
    // A retained reader must not keep an evicted payload outside the byte budget.
    expect((await retained.loadBytes())?.bytes).toEqual(bytes);
    expect(read).toHaveBeenCalledOnce();
  },
);

it.each(["database close and reopen", "avatar replacement"] as const)(
  "requires fresh avatar reads after %s",
  async (boundary) => {
    const options = fixture();
    const profile = ensureProfileForEmail("lifetime@example.test", options);
    let bytes = new Uint8Array([1, 2, 3]);
    expect(setAvatar(profile.id, bytes, "image/png", options).ok).toBe(true);
    const release = (await prepareUserProfileCatalog(options)).release;
    releases.push(release);
    const warm = await createProfileAvatarReader(profile.id, options).inspect();
    expect((await warm.loadBytes())?.bytes).toEqual(bytes);

    if (boundary === "database close and reopen") {
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
