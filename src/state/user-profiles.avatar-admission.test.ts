import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import {
  getUserProfileDisplay,
  readUserProfileIdentity,
  prepareUserProfileCatalog,
} from "./user-profile-list.js";
import { setUserProfileRole } from "./user-profile-writes.worker.js";
import { adoptTailscaleProfileAvatar, ensureProfileForEmail } from "./user-profiles.js";

it("preserves a native first-use role in avatar publication after warming a legacy worker", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "avatar-legacy-role-",
  });
  let release = () => {};
  try {
    const { db } = openOpenClawStateDatabase();
    db.exec(`CREATE TABLE user_profiles (
      id TEXT NOT NULL PRIMARY KEY, display_name TEXT, avatar BLOB, avatar_mime TEXT,
      avatar_sha256 TEXT, merged_into TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`);
    const profile = ensureProfileForEmail("legacy-avatar@example.test");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    await adoptTailscaleProfileAvatar(profile.id, undefined);
    expect(tableHasColumn(db, "user_profiles", "role")).toBe(false);
    setUserProfileRole(profile.id, "reader");
    release = (await prepareUserProfileCatalog()).release;
    const bytes = readFileSync(join(process.cwd(), "ui/public/favicon-32.png"));
    const adopted = await adoptTailscaleProfileAvatar(
      profile.id,
      "https://avatars.example.test/p",
      {},
      {
        fetchImpl: vi.fn(
          async () =>
            new Response(Uint8Array.from(bytes).buffer, {
              headers: { "content-type": "image/png" },
            }),
        ),
      },
    );
    expect(adopted.role).toBe("reader");
    expect(readUserProfileIdentity(profile.id)?.role).toBe("reader");
    expect(getUserProfileDisplay(profile.id).hasAvatar).toBe(true);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
  } finally {
    release();
    await state.cleanup();
  }
});
