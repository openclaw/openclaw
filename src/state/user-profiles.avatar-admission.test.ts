import { expect, it, vi } from "vitest";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import {
  getUserProfileDisplay,
  readResidentUserProfileIdentity,
  prepareUserProfileCatalog,
} from "./user-profile-list.js";
import { setUserProfileRole } from "./user-profile-writes.worker.js";
import { avatarPng, avatarResponse } from "./user-profiles-fixture.test-support.js";
import { adoptTailscaleProfileAvatar, ensureProfileForEmail } from "./user-profiles.js";

it("preserves a native first-use role in avatar publication after warming a legacy worker", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "avatar-legacy-role-",
  });
  let release = () => {};
  const fetchSpy = vi.spyOn(globalThis, "fetch");
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
    const bytes = avatarPng();
    fetchSpy.mockImplementation(async () => avatarResponse(bytes));
    const adopted = await adoptTailscaleProfileAvatar(profile.id, "https://avatars.example.test/p");
    expect(adopted.role).toBe("reader");
    expect(readResidentUserProfileIdentity(profile.id)?.role).toBe("reader");
    expect(getUserProfileDisplay(profile.id).hasAvatar).toBe(true);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
  } finally {
    fetchSpy.mockRestore();
    release();
    await state.cleanup();
  }
});
