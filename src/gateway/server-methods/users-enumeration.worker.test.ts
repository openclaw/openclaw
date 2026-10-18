import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { tableHasColumn } from "../../state/openclaw-state-db-schema-helpers.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as profileAuthority from "../../state/user-channel-identity-operations.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import {
  mergeCanonicalUserProfiles,
  setCanonicalUserProfileRole,
} from "../../state/user-profile-writes.js";
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

let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
let catalog: Awaited<ReturnType<typeof prepareUserProfileCatalog>> | undefined;
let context: ReturnType<typeof createContext>;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "users-enumeration-" });
  context = createContext();
});
afterEach(async () => {
  vi.restoreAllMocks();
  catalog?.release();
  catalog = undefined;
  await state?.cleanup();
});

function dispatch(method: string, profileId: string, scopes = ["operator.read"], params = {}) {
  const respond = vi.fn<RespondFn>();
  const request = handleGatewayRequest({
    req: { type: "req", id: profileId, method, params },
    respond,
    context,
    client: createOperatorClient({ profileId, scopes }),
    isWebchatConnect: () => false,
    extraHandlers: usersHandlers,
  });
  return { respond, request };
}

function expectedProfile(id: string, displayName: string, createdAt: number, overrides = {}) {
  return {
    id,
    displayName,
    createdAt,
    updatedAt: createdAt + 10,
    avatarMime: null,
    mergedInto: null,
    emails: [],
    githubIdentity: null,
    hasAvatar: false,
    roleSource: "default",
    ...overrides,
  };
}

it("returns only the authenticated person's private emails from the shared users.self catalog", async () => {
  const people = ["alpha-private@example.test", "bravo-private@example.test"].map((email) => ({
    email,
    profile: ensureProfileForEmail(email),
  }));
  catalog = await prepareUserProfileCatalog();
  for (const { email, profile } of people) {
    const expected = {
      profile: { ...profile, emails: [email], githubIdentity: null, hasAvatar: false },
    };
    for (const scopes of [["operator.read"], []]) {
      const { respond, request } = dispatch("users.self", profile.id, scopes);
      await request;
      expect(respond.mock.calls).toEqual([
        scopes.length
          ? [true, expected]
          : [false, undefined, expect.objectContaining({ code: "FORBIDDEN" })],
      ]);
    }
  }
});

it.each(["role", "identity"] as const)(
  "rejects users.self when a committed %s change revokes its prepared profile before response",
  async (change) => {
    const resume = createDeferredCore();
    const person = ensureProfileForEmail("original-private@example.test");
    const replacement = ensureProfileForEmail("replacement-private@example.test");
    catalog = await prepareUserProfileCatalog();
    const prepared = createDeferredCore();
    const prepare = profileAuthority.prepareUserProfileRoleAuthority;
    using preparation = vi.spyOn(profileAuthority, "prepareUserProfileRoleAuthority");
    preparation.mockImplementation(async (profileId, options) => {
      const authority = await prepare(profileId, options);
      if (options?.includeProfile) {
        prepared.resolve();
        await resume.promise;
      }
      return authority;
    });
    const { respond, request } = dispatch("users.self", person.id);
    try {
      await Promise.race([prepared.promise, request]);
      expect(respond).not.toHaveBeenCalled();
      if (change === "role") {
        await setCanonicalUserProfileRole(person.id, "reader");
      } else {
        await mergeCanonicalUserProfiles(person.id, replacement.id);
      }
    } finally {
      resume.resolve();
      await request;
    }
    expect(respond.mock.calls).toEqual([
      [
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: "Gateway requester profile changed",
        }),
      ],
    ]);
  },
);

it("commits profile display and avatar edits through their Gateway handlers without host SQL", async () => {
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
});

it("enforces scoped, bounded users.list dispatch without filtering profiles or running host SQL", async () => {
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
    expectedProfile(alpha.id, "Alpha", 1, {
      avatarMime: "image/png",
      emails: ["alpha@example.test", "old@example.test"],
      githubIdentity: {
        login: "alpha-primary",
        profileUrl: "https://github.com/alpha-primary",
        avatarUrl: "https://avatars.githubusercontent.com/u/101?v=4",
      },
      hasAvatar: true,
    }),
    expectedProfile(retired.id, "old", 2, { mergedInto: alpha.id }),
    expectedProfile(grace.id, "Grace", 3, { emails: ["grace@example.test"], role: "reader" }),
  ];
  const selected = {
    profiles,
    githubProfiles: [{ accountId: 102, profileId: alpha.id }],
  };
  const maximumSelection = [
    Number.MAX_SAFE_INTEGER,
    ...Array.from({ length: 498 }, (_entry, index) => index + 1000),
    102,
  ];
  const cases: [string, Record<string, unknown>, Parameters<RespondFn>, string[]?][] = [
    ["ordinary response", {}, [true, { profiles }]],
    ["empty selection", { githubAccountIds: [] }, [true, { profiles, githubProfiles: [] }]],
    ["secondary identity only", { githubAccountIds: [1, 102, 999] }, [true, selected]],
    ["500 IDs, match last", { githubAccountIds: maximumSelection }, [true, selected]],
    ...[
      ["501 account IDs", Array.from({ length: 501 }, (_entry, index) => index + 1)],
      ["duplicate", [102, 102]],
      ["zero", [0]],
      ["negative", [-1]],
      ["fractional", [1.5]],
      ["unsafe", [Number.MAX_SAFE_INTEGER + 1]],
    ].map(([name, githubAccountIds]): (typeof cases)[number] => [
      String(name),
      { githubAccountIds },
      [
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringMatching(/^invalid users\.list params:/),
        }),
      ],
    ]),
    ...[[], ["operator.approvals"]].map((scopes): (typeof cases)[number] => [
      `insufficient scopes: ${JSON.stringify(scopes)}`,
      { githubAccountIds: [102, 999] },
      [
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
      ],
      scopes,
    ]),
    ["unchanged after reads and rejections", {}, [true, { profiles }]],
  ];
  requireNodeSqlite();
  const calls = observeMainThreadSql();
  for (const [name, params, expected, scopes] of cases) {
    const { respond, request } = dispatch("users.list", alpha.id, scopes, params);
    await request;
    expect(respond.mock.calls, name).toEqual([expected]);
    calls.expectIdle();
  }
});

it("observes native first-use role assignment after warming a legacy worker reader", async () => {
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
        context: createContext(),
        client: null,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, { profiles: [expected] });
      calls.expectIdle();
    } finally {
      vi.restoreAllMocks();
    }
  };
  await read(
    expectedProfile(profile.id, "legacy", profile.createdAt, {
      updatedAt: profile.updatedAt,
      emails: ["legacy@example.test"],
    }),
  );
  expect(tableHasColumn(db, "user_profiles", "role")).toBe(false);

  setUserProfileRole(profile.id, "maintainer");
  await read(
    expect.objectContaining({ id: profile.id, role: "maintainer", roleSource: "default" }),
  );
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
});
