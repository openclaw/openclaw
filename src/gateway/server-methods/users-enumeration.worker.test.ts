import { expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { tableHasColumn } from "../../state/openclaw-state-db-schema-helpers.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  ensureProfileForEmail,
  linkEmail,
  setAvatar,
  setDisplayName,
  syncGitHubIdentity,
} from "../../state/user-profiles.js";
import { seedUserProfileRole } from "../../state/user-profiles.test-support.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { usersHandlers } from "./users.js";

it("enumerates protocol profile facts through the real users.list entry without host SQL", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "users-enumeration-",
  });
  try {
    const alpha = ensureProfileForEmail("alpha@example.test");
    const retired = ensureProfileForEmail("old@example.test");
    const grace = ensureProfileForEmail("grace@example.test");
    linkEmail("old@example.test", alpha.id);
    setDisplayName(alpha.id, "Alpha");
    setDisplayName(grace.id, "Grace");
    seedUserProfileRole(grace.id, "reader");
    expect(setAvatar(alpha.id, new Uint8Array([1, 2]), "image/png").ok).toBe(true);
    syncGitHubIdentity({
      identity: { accountId: 101, login: "alpha-primary" },
      authenticationAlias: { kind: "email", email: "alpha@example.test" },
    });
    const { db } = openOpenClawStateDatabase();
    db.prepare(
      "INSERT INTO user_profile_identities (provider, subject, profile_id, canonical_login, created_at) VALUES ('github', '102', ?, 'alpha-secondary', 1)",
    ).run(alpha.id);
    [alpha.id, retired.id, grace.id].forEach((id, index) => {
      db.prepare("UPDATE user_profiles SET created_at = ?, updated_at = ? WHERE id = ?").run(
        index + 1,
        index + 11,
        id,
      );
    });
    const { DatabaseSync, StatementSync } = requireNodeSqlite();
    const calls = [
      vi.spyOn(DatabaseSync.prototype, "prepare"),
      vi.spyOn(DatabaseSync.prototype, "exec"),
      ...(["get", "all", "run", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      ),
    ];
    const respond = vi.fn();
    try {
      await usersHandlers["users.list"]!({
        req: {} as never,
        params: {},
        respond,
        context: {} as never,
        client: null,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        profiles: [
          {
            id: alpha.id,
            displayName: "Alpha",
            avatarMime: "image/png",
            mergedInto: null,
            createdAt: 1,
            updatedAt: 11,
            emails: ["alpha@example.test", "old@example.test"],
            githubIdentity: {
              login: "alpha-primary",
              profileUrl: "https://github.com/alpha-primary",
              avatarUrl: "https://avatars.githubusercontent.com/u/101?v=4",
            },
            hasAvatar: true,
          },
          {
            id: retired.id,
            displayName: "old",
            avatarMime: null,
            mergedInto: alpha.id,
            createdAt: 2,
            updatedAt: 12,
            emails: [],
            githubIdentity: null,
            hasAvatar: false,
          },
          {
            id: grace.id,
            displayName: "Grace",
            avatarMime: null,
            mergedInto: null,
            createdAt: 3,
            updatedAt: 13,
            emails: ["grace@example.test"],
            githubIdentity: null,
            hasAvatar: false,
            role: "reader",
          },
        ],
      });
      expect(calls.reduce((count, call) => count + call.mock.calls.length, 0)).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  } finally {
    await state.cleanup();
  }
});

it("observes native first-use role assignment after warming a legacy worker reader", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "users-role-" });
  try {
    const { db } = openOpenClawStateDatabase();
    db.exec(`CREATE TABLE user_profiles (
      id TEXT NOT NULL PRIMARY KEY, display_name TEXT, avatar BLOB, avatar_mime TEXT,
      avatar_sha256 TEXT, merged_into TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`);
    const profile = ensureProfileForEmail("legacy@example.test");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    const read = async (expected: unknown) => {
      const { DatabaseSync, StatementSync } = requireNodeSqlite();
      const calls = [
        vi.spyOn(DatabaseSync.prototype, "prepare"),
        vi.spyOn(DatabaseSync.prototype, "exec"),
        ...(["get", "all", "run", "iterate"] as const).map((method) =>
          vi.spyOn(StatementSync.prototype, method),
        ),
      ];
      const respond = vi.fn();
      try {
        await usersHandlers["users.list"]!({
          req: {} as never,
          params: {},
          respond,
          context: {} as never,
          client: null,
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledExactlyOnceWith(true, { profiles: [expected] });
        expect(calls.reduce((count, call) => count + call.mock.calls.length, 0)).toBe(0);
      } finally {
        vi.restoreAllMocks();
      }
    };
    await read({
      id: profile.id,
      displayName: "legacy",
      avatarMime: null,
      mergedInto: null,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      emails: ["legacy@example.test"],
      githubIdentity: null,
      hasAvatar: false,
    });
    expect(tableHasColumn(db, "user_profiles", "role")).toBe(false);

    seedUserProfileRole(profile.id, "maintainer");
    await read(expect.objectContaining({ id: profile.id, role: "maintainer" }));
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
  } finally {
    await state.cleanup();
  }
});
