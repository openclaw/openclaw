import { expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { tableHasColumn } from "../../state/openclaw-state-db-schema-helpers.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import {
  linkEmail,
  setAvatar,
  setDisplayName,
  setUserProfileRole,
  syncGitHubIdentity,
} from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import type { RespondFn } from "./response-types.js";
import { usersHandlers } from "./users.js";

it("commits profile display and avatar edits through their Gateway handlers without host SQL", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "users-setters-" });
  let catalog: Awaited<ReturnType<typeof prepareUserProfileCatalog>> | undefined;
  try {
    const person = ensureProfileForEmail("setter@example.test");
    catalog = await prepareUserProfileCatalog();
    const refreshConnectedUserProfile = vi.fn();
    requireNodeSqlite();
    const calls = observeMainThreadSql();
    for (const [method, params, expected] of [
      ["users.setDisplayName", { displayName: "Current name" }, { displayName: "Current name" }],
      ["users.setAvatar", { mime: "image/png", avatarBase64: "AQI=" }, { hasAvatar: true }],
    ] as const) {
      const respond = vi.fn();
      await usersHandlers[method]!({
        req: {} as never,
        params: { profileId: person.id, ...params },
        respond,
        context: { getRuntimeConfig: () => ({}), refreshConnectedUserProfile } as never,
        client: { connect: { role: "operator", scopes: ["operator.admin"] } } as never,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        true,
        expect.objectContaining({
          profile: expect.objectContaining({ id: person.id, ...expected }),
        }),
      );
      expect(refreshConnectedUserProfile).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: person.id, ...expected }),
      );
    }
    calls.expectIdle();
  } finally {
    vi.restoreAllMocks();
    catalog?.release();
    await state.cleanup();
  }
});

it("enforces scoped, bounded users.list dispatch without filtering profiles or running host SQL", async () => {
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
    setUserProfileRole(grace.id, "reader");
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
    const profiles = [
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
    ];
    const selected = {
      profiles,
      githubProfiles: [{ accountId: 102, profileId: alpha.id }],
    };
    const cases: {
      name: string;
      params: Record<string, unknown>;
      scopes?: string[];
      expected: Parameters<RespondFn>;
    }[] = [
      {
        name: "ordinary empty params retain the original response shape",
        params: {},
        expected: [true, { profiles }],
      },
      {
        name: "empty selection returns no numeric associations",
        params: { githubAccountIds: [] },
        expected: [true, { profiles, githubProfiles: [] }],
      },
      {
        name: "selected secondary identity excludes the unrequested primary identity",
        params: { githubAccountIds: [1, 102, 999] },
        expected: [true, selected],
      },
      {
        name: "500 unique positive safe integers include a match in the last position",
        params: {
          githubAccountIds: [
            Number.MAX_SAFE_INTEGER,
            ...Array.from({ length: 498 }, (_entry, index) => index + 1000),
            102,
          ],
        },
        expected: [true, selected],
      },
      ...[
        {
          name: "501 account IDs",
          githubAccountIds: Array.from({ length: 501 }, (_entry, index) => index + 1),
        },
        { name: "duplicate account IDs", githubAccountIds: [102, 102] },
        { name: "zero account ID", githubAccountIds: [0] },
        { name: "negative account ID", githubAccountIds: [-1] },
        { name: "fractional account ID", githubAccountIds: [1.5] },
        { name: "unsafe integer account ID", githubAccountIds: [Number.MAX_SAFE_INTEGER + 1] },
      ].map(({ name, githubAccountIds }) => ({
        name,
        params: { githubAccountIds },
        expected: [
          false,
          undefined,
          expect.objectContaining({
            code: "INVALID_REQUEST",
            message: expect.stringMatching(/^invalid users\.list params:/),
          }),
        ] satisfies Parameters<RespondFn>,
      })),
      ...[[], ["operator.approvals"]].map((scopes) => ({
        name: `insufficient scopes: ${JSON.stringify(scopes)}`,
        params: { githubAccountIds: [102, 999] },
        scopes,
        expected: [
          false,
          undefined,
          {
            code: "FORBIDDEN",
            message: "missing scope: operator.read",
            details: {
              code: "MISSING_SCOPE",
              missingScope: "operator.read",
              requiredScopes: ["operator.read"],
            },
          },
        ] satisfies Parameters<RespondFn>,
      })),
      {
        name: "ordinary response remains unchanged after selected reads and rejections",
        params: {},
        expected: [true, { profiles }],
      },
    ];
    const context = createContext();
    requireNodeSqlite();
    const calls = observeMainThreadSql();
    try {
      for (const scenario of cases) {
        const respond = vi.fn<RespondFn>();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: scenario.name,
            method: "users.list",
            params: scenario.params,
          },
          respond,
          context,
          client: createOperatorClient({
            profileId: alpha.id,
            scopes: scenario.scopes ?? ["operator.read"],
          }),
          isWebchatConnect: () => false,
        });
        expect(respond.mock.calls, scenario.name).toEqual([scenario.expected]);
        calls.expectIdle();
      }
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
      requireNodeSqlite();
      const calls = observeMainThreadSql();
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
        calls.expectIdle();
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

    setUserProfileRole(profile.id, "maintainer");
    await read(expect.objectContaining({ id: profile.id, role: "maintainer" }));
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
  } finally {
    await state.cleanup();
  }
});
