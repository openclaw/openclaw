import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  adoptTailscaleProfileAvatar,
  ensureProfileForEmail,
  getProfileAvatar,
  listProfiles,
  setDisplayName,
} from "./user-profiles.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
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
      expect(listProfiles(options)).toEqual([
        expect.objectContaining({ id: other.id, hasAvatar: false }),
      ]);
    } finally {
      response.resolve(new Response("unavailable", { status: 503 }));
      await Promise.allSettled([pending]);
    }
  },
);
