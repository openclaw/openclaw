import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
import {
  validateUsersSetAvatarResult,
  validateUsersSetDisplayNameResult,
  validateUsersSetRoleResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { UserProfileOwnerError } from "../../state/user-profiles-schema.js";
import type { ProfileDisplayRow } from "../../state/user-profiles.types.js";
import { usersHandlers } from "./users.js";

const linkEmail = vi.hoisted(() => vi.fn());
const mergeProfiles = vi.hoisted(() => vi.fn());
const listProfiles = vi.hoisted(() => vi.fn());
const setCanonicalUserProfileAvatar = vi.hoisted(() => vi.fn());
const setCanonicalUserProfileDisplayName = vi.hoisted(() => vi.fn());
const setUserProfileRole = vi.hoisted(() => vi.fn());
const invalidateOperatorRolePolicy = vi.hoisted(() => vi.fn());
const ensureProfileIdForEmail = vi.hoisted(() => vi.fn());
let disclosedProfile: unknown;
let authorityCurrent = true;
const prepareUserProfileRoleAuthority = vi.hoisted(() => vi.fn());
const readResidentUserProfileRevision = vi.hoisted(() =>
  vi.fn<typeof import("../../state/user-profile-list.js").readResidentUserProfileRevision>(),
);

vi.mock("../../state/user-profile-email.js", () => ({ ensureProfileIdForEmail }));
// mock-isolation: Exercise RPC admission independently of the shared-state worker.
vi.mock("../../state/user-channel-identity-operations.js", () => ({
  prepareUserProfileRoleAuthority,
}));

vi.mock("../../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-profile-list.js")>()),
  readResidentUserProfileRevision,
}));

vi.mock("../../state/user-profile-writes.js", () => ({
  linkCanonicalUserProfileEmail: linkEmail,
  mergeCanonicalUserProfiles: mergeProfiles,
  setCanonicalUserProfileAvatar,
  setCanonicalUserProfileDisplayName,
  setCanonicalUserProfileRole: async (
    ...args: Parameters<
      typeof import("../../state/user-profile-writes.js").setCanonicalUserProfileRole
    >
  ) => {
    const profile = await setUserProfileRole(...args);
    args[2]?.onCommitted?.(profile.id);
    return profile;
  },
}));

// mock-isolation: Profile disclosure comes from the mocked authority reader above.
vi.mock("../../state/user-profiles.js", async () => {
  const { UserProfileNotFoundError } = await vi.importActual<
    typeof import("../../state/user-profiles-schema.js")
  >("../../state/user-profiles-schema.js");
  return {
    listProfiles,
    UserProfileNotFoundError,
  };
});

vi.mock("../operator-role-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../operator-role-policy.js")>()),
  invalidateOperatorRolePolicy,
}));

async function runUsersHandler(
  method: keyof typeof usersHandlers,
  params: object,
  client?: object,
  context: object = {},
  options: { signal?: AbortSignal; respond?: ReturnType<typeof vi.fn> } = {},
) {
  const respond = options.respond ?? vi.fn();
  await expectDefined(
    usersHandlers[method],
    `${method} test invariant`,
  )({
    client,
    context: { getRuntimeConfig: () => ({}), ...context },
    params,
    respond,
    ...options,
  } as never);
  return respond;
}

function expectFailure(respond: ReturnType<typeof vi.fn>, error = { code: "UNAVAILABLE" }) {
  expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, expect.objectContaining(error));
}

function pauseWrite<T>(value: T) {
  const entered = createDeferred();
  const release = createDeferred();
  return {
    entered,
    release,
    run: async () => {
      entered.resolve();
      await release.promise;
      return value;
    },
  };
}

async function finishWrite(
  gate: Pick<ReturnType<typeof pauseWrite>, "entered" | "release">,
  pending: ReturnType<typeof runUsersHandler>,
  whilePending: () => void,
) {
  try {
    await awaitGateBeforeSettlement(gate.entered.promise, pending, "profile write was not awaited");
    whilePending();
  } finally {
    gate.release.resolve();
    await pending;
  }
  return pending;
}

function expectError(respond: ReturnType<typeof vi.fn>, error: object) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
}

function expectUntouched(...mocks: ReturnType<typeof vi.fn>[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

const profile = {
  id: "profile-1",
  displayName: "Ada",
  avatarMime: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 1,
  emails: ["ada@example.com"],
  githubIdentity: null,
  hasAvatar: false,
};
const display = {
  id: profile.id,
  displayName: profile.displayName,
  avatarRevision: String(profile.updatedAt),
  hasAvatar: profile.hasAvatar,
};
const residentProfile: ProfileDisplayRow = {
  id: profile.id,
  display_name: profile.displayName,
  avatar_mime: null,
  avatar_sha256: null,
  merged_into: null,
  created_at: profile.createdAt,
  updated_at: profile.updatedAt,
  role: null,
  has_avatar: 0,
};
const adminClient = {
  connect: { scopes: ["operator.admin"] },
  authenticatedUserProfile: { profileId: "gateway-owner" },
};
const selfClient = {
  authenticatedUserId: "ada@example.com",
  connect: { scopes: ["operator.write"] },
};
const profileBinding = {
  profileId: profile.id,
  displayName: "Ada",
  hasAvatar: false,
  updatedAt: 1,
};
const avatarParams = { profileId: profile.id, mime: "image/png", avatarBase64: "AQ==" };
const nameParams = { profileId: profile.id, displayName: "Ada" };
const roleConfig = {
  getRuntimeConfig: () => ({ gateway: { roles: { definitions: { guest: {} } } } }),
};
const effects = [
  ensureProfileIdForEmail,
  prepareUserProfileRoleAuthority,
  linkEmail,
  mergeProfiles,
  readResidentUserProfileRevision,
  listProfiles,
  setCanonicalUserProfileAvatar,
  setCanonicalUserProfileDisplayName,
  setUserProfileRole,
  invalidateOperatorRolePolicy,
];

beforeEach(() => {
  for (const effect of effects) {
    effect.mockReset();
  }
  prepareUserProfileRoleAuthority.mockImplementation(async (profileId: string) => ({
    profileId,
    listItem: disclosedProfile,
    isCurrent: () => authorityCurrent,
  }));
  authorityCurrent = true;
  disclosedProfile = profile;
  readResidentUserProfileRevision.mockReturnValue(residentProfile);
});

const malformedRequests = [
  ["users.list", {}],
  ["users.self", {}],
  ["users.prefs.get", { keys: ["ui.theme"] }],
  ["users.prefs.set", { entries: { "ui.theme": "claw" } }],
  ["users.linkEmail", { email: "ada@example.test", targetProfileId: "profile-1" }],
  ["users.setDisplayName", nameParams],
  ["users.setRole", { profileId: "profile-1", role: null }],
  ["users.setAvatar", avatarParams],
] as const;
type InvalidRequest = [string, object, (string | RegExp)?, boolean?, boolean?];
const malformed = malformedRequests.map<InvalidRequest>(([method, params]) => [
  method,
  { ...params, unexpected: true },
  `invalid ${method} params: at root: unexpected property 'unexpected'`,
  true,
]);
it.each<InvalidRequest>([
  ...malformed,
  ["users.setRole", { profileId: profile.id, role: "   " }],
  ["users.linkEmail", { email: "   ", targetProfileId: profile.id }, "email must not be empty"],
  ["users.setAvatar", { ...avatarParams, avatarBase64: "not base64" }],
  [
    "users.setRole",
    { profileId: profile.id, role: "maintainer" },
    /gateway\.roles\.definitions/,
    false,
    true,
  ],
])(
  "rejects invalid %s params before state effects: %j",
  async (method, params, message, schema, readsConfig) => {
    const original = structuredClone(params);
    const unreadableState = new Proxy(
      {},
      {
        get() {
          throw new Error("invalid users request reached owner state");
        },
      },
    );
    const getRuntimeConfig = vi.fn(roleConfig.getRuntimeConfig);
    const respond = await runUsersHandler(
      method,
      params,
      unreadableState,
      schema ? unreadableState : { getRuntimeConfig },
    );
    const error = {
      code: "INVALID_REQUEST",
      ...(message
        ? { message: message instanceof RegExp ? expect.stringMatching(message) : message }
        : {}),
    };
    expect(respond.mock.calls).toEqual([
      [false, undefined, schema ? error : expect.objectContaining(error)],
    ]);
    expect(params).toEqual(original);
    if (!readsConfig) {
      expect(getRuntimeConfig).not.toHaveBeenCalled();
    }
    expectUntouched(...effects);
  },
);

function connectedProfileClient() {
  return {
    authenticatedUserProfile: { ...profileBinding },
    connect: { scopes: ["operator.write"] },
  };
}

it("keeps unresolved users.self unavailable and retryable when GitHub lookup fails", async () => {
  const providerClient: Record<string, unknown> = {
    authenticatedUserId: "ada@github",
    authenticatedUserIsTailscaleProvider: true,
    connect: { scopes: ["operator.write"] },
  };
  const authenticatedGitHubIdentitySync = vi
    .fn()
    .mockRejectedValueOnce(new Error("network unavailable"))
    .mockImplementationOnce(async () => {
      providerClient.authenticatedUserProfile = { ...profileBinding };
      return { profileId: profile.id, updatedAt: profile.updatedAt };
    });
  providerClient.authenticatedGitHubIdentitySync = authenticatedGitHubIdentitySync;
  expectError(await runUsersHandler("users.self", {}, providerClient), {
    code: "UNAVAILABLE",
    retryable: true,
    details: { code: "AUTHENTICATED_PROFILE_UNAVAILABLE" },
  });
  expect(await runUsersHandler("users.self", {}, providerClient)).toHaveBeenCalledWith(true, {
    profile,
  });
  expect(authenticatedGitHubIdentitySync).toHaveBeenCalledTimes(2);
});

it.each([
  [
    {
      ...selfClient,
      authenticatedUserId: "ada@github",
      authenticatedUserIsTailscaleProvider: true,
    },
    { code: "UNAVAILABLE", retryable: true },
  ],
  [
    { connect: { scopes: ["operator.write"] } },
    { code: "FORBIDDEN", message: "users.self requires an authenticated user" },
  ],
])("rejects unresolved users.self for %j without creating an alias", async (client, error) => {
  expectError(await runUsersHandler("users.self", {}, client), error);
  expect(ensureProfileIdForEmail).not.toHaveBeenCalled();
});

it.each(["users.linkEmail", "users.merge"] as const)(
  "suppresses %s publications when the administrator changes during the write",
  async (method) => {
    const gate = pauseWrite({ profile, movedAliasKinds: ["email"] });
    const client = {
      connect: { role: "operator", scopes: ["operator.admin"] },
      authenticatedUserProfile: { profileId: "admin-profile" },
    };
    const store = method === "users.merge" ? mergeProfiles : linkEmail;
    store.mockImplementationOnce(gate.run);
    const refresh = vi.fn();
    const broadcast = vi.fn();
    const pending = runUsersHandler(
      method,
      method === "users.merge"
        ? { sourceProfileId: "source-profile", targetProfileId: profile.id }
        : { email: "ada@example.com", targetProfileId: profile.id },
      client,
      { refreshConnectedUserProfile: refresh, broadcast },
    );
    const respond = await finishWrite(gate, pending, () => {
      expectUntouched(refresh, broadcast);
      client.authenticatedUserProfile.profileId = "replacement-profile";
    });
    if (method === "users.merge") {
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        profile,
        movedAliasKinds: ["email"],
      });
    } else {
      expectFailure(respond);
    }
    expectUntouched(refresh, broadcast);
  },
);

it.each([
  [
    "users.linkEmail",
    "merge",
    { email: "person@example.test", targetProfileId: "gateway-owner" },
    linkEmail,
    "the shared owner profile cannot be merged; sign in with a personal identity instead",
  ],
  [
    "users.setRole",
    "role",
    { profileId: "gateway-owner", role: "guest" },
    setUserProfileRole,
    "the shared owner profile is not governed by operator roles",
  ],
] as const)(
  "maps owner rejection from %s to an invalid request",
  async (method, operation, params, store, message) => {
    store.mockImplementationOnce(() => {
      throw new UserProfileOwnerError(operation);
    });
    const refresh = vi.fn();
    const disconnect = vi.fn();

    const respond = await runUsersHandler(method, params, adminClient, {
      ...roleConfig,
      refreshConnectedUserProfile: refresh,
      disconnectClientsForUserProfile: disconnect,
    });

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message,
    });
    expectUntouched(refresh, disconnect, invalidateOperatorRolePolicy);
  },
);

it("refreshes from the current catalog when an older name write returns late", async () => {
  const firstProfile = { ...profile, displayName: "First name", updatedAt: 2 };
  const gate = pauseWrite({ profile: firstProfile });
  setCanonicalUserProfileDisplayName.mockImplementationOnce(gate.run);
  const refresh = vi.fn();
  const pending = runUsersHandler(
    "users.setDisplayName",
    { profileId: profile.id, displayName: "First name" },
    adminClient,
    { refreshConnectedUserProfile: refresh },
  );
  const respond = await finishWrite(gate, pending, () => {
    expectUntouched(refresh);
    readResidentUserProfileRevision.mockReturnValue({
      ...residentProfile,
      display_name: "Later name",
      updated_at: 3,
    });
  });
  expect(respond).toHaveBeenCalledExactlyOnceWith(true, { profile: firstProfile });
  expect(validateUsersSetDisplayNameResult(respond.mock.calls[0]?.[1])).toBe(true);
  expect(refresh).toHaveBeenCalledExactlyOnceWith({
    id: profile.id,
    displayName: "Later name",
    avatarRevision: "3",
    hasAvatar: false,
    updatedAt: 3,
  });
});

it.each(["guest", null])("sets role %s and invalidates policy before responding", async (role) => {
  const assignedProfile = role ? { ...profile, role, updatedAt: 2 } : profile;
  const disconnect = vi.fn();
  setUserProfileRole.mockReturnValue(assignedProfile);
  const respond = await runUsersHandler(
    "users.setRole",
    { profileId: profile.id, role },
    adminClient,
    {
      ...(role ? roleConfig : {}),
      ...(role ? { disconnectClientsForUserProfile: disconnect } : {}),
    },
  );
  expect(respond).toHaveBeenCalledWith(true, { profile: assignedProfile });
  expect(validateUsersSetRoleResult(respond.mock.calls[0]?.[1])).toBe(true);
  expect(setUserProfileRole).toHaveBeenCalledWith(profile.id, role, {
    assertCurrent: expect.any(Function),
    onCommitted: expect.any(Function),
  });
  for (const publish of [invalidateOperatorRolePolicy, ...(role ? [disconnect] : [])]) {
    expect(publish).toHaveBeenCalledWith(profile.id);
    expect(publish.mock.invocationCallOrder[0]).toBeLessThan(
      respond.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  }
});

it("returns content-based avatar revisions even for edits with identical timestamps", async () => {
  const edited = { ...profile, avatarMime: "image/png" as const, hasAvatar: true, updatedAt: 2 };
  const refresh = vi.fn();
  for (const [index, hash] of ["first-content-hash", "second-content-hash"].entries()) {
    const avatarRevision = `${hash}-png`;
    setCanonicalUserProfileAvatar.mockResolvedValueOnce({
      ok: true,
      value: { profile: edited, display: { ...display, avatarRevision, hasAvatar: true } },
    });
    readResidentUserProfileRevision.mockReturnValueOnce({
      ...residentProfile,
      avatar_mime: "image/png",
      avatar_sha256: hash,
      has_avatar: 1,
      updated_at: edited.updatedAt,
    });
    const respond = await runUsersHandler(
      "users.setAvatar",
      { ...avatarParams, avatarBase64: index === 0 ? "AQ==" : "Ag==" },
      adminClient,
      { refreshConnectedUserProfile: refresh },
    );
    expect(validateUsersSetAvatarResult(respond.mock.calls[0]?.[1])).toBe(true);
    expect(respond).toHaveBeenCalledWith(true, { profile: edited, avatarRevision });
    expect(refresh).toHaveBeenNthCalledWith(index + 1, {
      id: edited.id,
      displayName: edited.displayName,
      avatarRevision,
      hasAvatar: true,
      updatedAt: edited.updatedAt,
    });
    expect(refresh.mock.invocationCallOrder[index]).toBeLessThan(
      respond.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  }
});

it.each(["constraint", "acquisition", "foreign"])(
  "rejects avatar writes after %s failure",
  async (kind) => {
    ensureProfileIdForEmail.mockResolvedValue(profile.id);
    if (kind === "acquisition") {
      ensureProfileIdForEmail.mockRejectedValueOnce(new Error("profile worker unavailable"));
    }
    setCanonicalUserProfileAvatar.mockResolvedValue({
      ok: false,
      error: { code: "avatar_too_large" },
    });
    const respond = await runUsersHandler(
      "users.setAvatar",
      {
        ...avatarParams,
        profileId: kind === "foreign" ? "profile-2" : profile.id,
      },
      kind === "constraint" ? adminClient : selfClient,
    );
    const error =
      kind === "constraint"
        ? { code: "INVALID_REQUEST" }
        : kind === "acquisition"
          ? { code: "UNAVAILABLE", message: "profile worker unavailable" }
          : {
              code: "FORBIDDEN",
              message: "profile edits require the owning user or operator.admin",
            };
    expectFailure(respond, error);
    if (kind !== "constraint") {
      expect(setCanonicalUserProfileAvatar).not.toHaveBeenCalled();
    }
  },
);

it.each([
  "unchanged",
  "disconnect",
  "request cancellation",
  "profile replacement",
  "email replacement",
  "email relink",
  "role revocation",
] as const)("settles profile acquisition before mutation after %s", async (change) => {
  const gate = pauseWrite({ profileId: profile.id, isCurrent: () => authorityCurrent });
  const connection = new AbortController();
  const request = new AbortController();
  const client = {
    ...selfClient,
    connId: "profile-requester",
    connectionSignal: connection.signal,
    authenticatedUserProfile: undefined as { profileId: string } | undefined,
  };
  ensureProfileIdForEmail.mockResolvedValue(profile.id);
  prepareUserProfileRoleAuthority.mockImplementationOnce(gate.run);
  setCanonicalUserProfileDisplayName.mockResolvedValue({ profile });
  const pending = runUsersHandler(
    "users.setDisplayName",
    { profileId: profile.id, displayName: "Ada Lovelace" },
    client,
    {},
    { signal: request.signal },
  );
  const respond = await finishWrite(gate, pending, () => {
    expect(prepareUserProfileRoleAuthority).toHaveBeenCalled();
    expect(setCanonicalUserProfileDisplayName).not.toHaveBeenCalled();
    if (change === "disconnect") {
      connection.abort();
    } else if (change === "request cancellation") {
      request.abort();
    } else if (change === "profile replacement") {
      client.authenticatedUserProfile = { profileId: "replacement-profile" };
    } else if (change === "email replacement") {
      client.authenticatedUserId = "replacement@example.test";
    } else if (change === "email relink") {
      ensureProfileIdForEmail.mockResolvedValue("replacement-profile");
    } else if (change === "role revocation") {
      authorityCurrent = false;
    }
  });
  if (change === "unchanged") {
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, { profile });
    expect(setCanonicalUserProfileDisplayName).toHaveBeenCalledOnce();
  } else {
    expectFailure(respond);
    expect(setCanonicalUserProfileDisplayName).not.toHaveBeenCalled();
  }
});

it.each(
  ["users.setDisplayName", "users.setAvatar"].flatMap((method) =>
    ["active", "disconnect", "profile replacement", "role revocation", "rejection"].map(
      (change) => ({ method, change }),
    ),
  ),
)("settles $method before publishing after $change", async ({ method, change }) => {
  const connection = new AbortController();
  const client = {
    ...connectedProfileClient(),
    connectionSignal: connection.signal,
  };
  const avatar = method === "users.setAvatar";
  const store = avatar ? setCanonicalUserProfileAvatar : setCanonicalUserProfileDisplayName;
  const gate = pauseWrite(avatar ? { ok: true, value: { profile, display } } : { profile });
  store.mockImplementationOnce(gate.run);
  const refresh = vi.fn();
  const respond = vi.fn();
  const pending = runUsersHandler(
    method,
    avatar ? avatarParams : nameParams,
    client,
    { refreshConnectedUserProfile: refresh },
    { respond },
  );
  await finishWrite(gate, pending, () => {
    expectUntouched(respond, refresh);
    if (change === "disconnect") {
      connection.abort();
    } else if (change === "profile replacement") {
      client.authenticatedUserProfile.profileId = "replacement-profile";
    } else if (change === "role revocation") {
      authorityCurrent = false;
    } else if (change === "rejection") {
      gate.release.reject(new Error("profile worker unavailable"));
    }
  });
  expect(store).toHaveBeenCalledOnce();
  if (change === "active") {
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      true,
      avatar ? { profile, avatarRevision: display.avatarRevision } : { profile },
    );
    expect(refresh).toHaveBeenCalledExactlyOnceWith({
      ...display,
      updatedAt: profile.updatedAt,
    });
  } else {
    expectFailure(respond);
    expectUntouched(refresh);
  }
});
