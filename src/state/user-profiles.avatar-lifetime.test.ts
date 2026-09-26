import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { readUserProfileVersion } from "./user-profile-events.js";
import { listUserProfilesSync } from "./user-profile-identity.read.js";
import { createProfileAvatarReader } from "./user-profiles-avatar.js";
import { getProfileAvatar } from "./user-profiles-avatar.test-support.js";
import {
  adoptTailscaleProfileAvatar,
  ensureProfileForEmail,
  setAvatar,
  setDisplayName,
} from "./user-profiles.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

it.each([false, true])(
  "keeps avatar adoption on its original database after handle replacement (fetched=%s)",
  async (fetched) => {
    const originalDirectory = tempDirs.make("openclaw-avatar-original-");
    const otherDirectory = tempDirs.make("openclaw-avatar-other-");
    const env = { OPENCLAW_STATE_DIR: originalDirectory };
    const options = { env };
    const profile = ensureProfileForEmail("avatar-lifetime@example.test", options);
    const original = openOpenClawStateDatabase(options);
    const originalOptions = { path: original.path };
    const entered = createDeferredCore();
    const response = createDeferredCore<Response>();
    const pending = adoptTailscaleProfileAvatar(
      profile.id,
      "https://avatars.example.test/profile",
      options,
      {
        fetchImpl: vi.fn(async () => {
          entered.resolve();
          return response.promise;
        }),
      },
    );
    try {
      await entered.promise;
      closeOpenClawStateDatabaseForTest();
      expect(original.db.isOpen).toBe(false);
      setDisplayName(profile.id, "Edited during fetch", originalOptions);
      env.OPENCLAW_STATE_DIR = otherDirectory;
      const other = ensureProfileForEmail("other@example.test", options);
      const bytes = readFileSync(join(process.cwd(), "ui/public/favicon-32.png"));
      response.resolve(
        fetched
          ? new Response(Uint8Array.from(bytes).buffer, {
              headers: { "content-type": "image/png" },
            })
          : new Response("unavailable", { status: 503 }),
      );

      await expect(pending).resolves.toMatchObject({
        id: profile.id,
        displayName: "Edited during fetch",
        avatarMime: fetched ? "image/png" : null,
      });
      expect(getProfileAvatar(profile.id, originalOptions)?.bytes).toEqual(
        fetched ? Uint8Array.from(bytes) : undefined,
      );
      expect(listUserProfilesSync(options)).toEqual([
        expect.objectContaining({ id: other.id, hasAvatar: false }),
      ]);
    } finally {
      response.resolve(new Response("unavailable", { status: 503 }));
      await Promise.allSettled([pending]);
    }
  },
);

it("refreshes foreign avatar commits through the originally selected database", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-avatar-read-owner-") };
  const profile = ensureProfileForEmail("avatar-reader@example.test", { env });
  expect(setAvatar(profile.id, new Uint8Array([1]), "image/png", { env }).ok).toBe(true);
  const reader = createProfileAvatarReader(profile.id, { env });
  const { path } = openOpenClawStateDatabase({ env });
  const prepared = await reader.inspect();
  const revision = readUserProfileVersion();
  const bytes = new Uint8Array([2, 3]);
  const foreign = new (requireNodeSqlite().DatabaseSync)(path);
  try {
    foreign
      .prepare("UPDATE user_profiles SET avatar = ?, avatar_sha256 = ? WHERE id = ?")
      .run(bytes, createHash("sha256").update(bytes).digest("hex"), profile.id);
    expect(readUserProfileVersion()).toBe(revision);
    expect(prepared.isCurrent()).toBe(true);
    env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-avatar-read-other-");
    await expect(prepared.loadBytes()).resolves.toBeUndefined();
    const refreshed = await reader.inspect();
    expect(refreshed.profile?.id).toBe(profile.id);
    expect(refreshed.avatar?.byteLength).toBe(bytes.byteLength);
    await expect(refreshed.loadBytes()).resolves.toMatchObject({ bytes });
  } finally {
    foreign.close();
  }
});
