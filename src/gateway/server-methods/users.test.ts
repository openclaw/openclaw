import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  validateUsersLinkEmailResult,
  validateUsersSelfResult,
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
const getUserProfileListItem = vi.hoisted(() => vi.fn());
const prepareUserProfileRoleAuthority = vi.hoisted(() => vi.fn());
const readResidentUserProfileRevision = vi.hoisted(() =>
  vi.fn<typeof import("../../state/user-profile-list.js").readResidentUserProfileRevision>(),
);

vi.mock("../../state/user-profile-email.js", () => ({ ensureProfileIdForEmail }));
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

vi.mock("../../state/user-profiles.js", async () => {
  const { UserProfileNotFoundError } = await vi.importActual<
    typeof import("../../state/user-profiles-schema.js")
  >("../../state/user-profiles-schema.js");
  return {
    getUserProfileListItem,
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
  options: { signal?: AbortSignal } = {},
) {
  const respond = vi.fn();
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

describe("users gateway methods", () => {
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

  beforeEach(() => {
    ensureProfileIdForEmail.mockReset();
    getUserProfileListItem.mockReset();
    prepareUserProfileRoleAuthority.mockReset();
    prepareUserProfileRoleAuthority.mockImplementation(async (profileId: string) => ({
      profileId,
      isCurrent: () => true,
    }));
    linkEmail.mockReset();
    mergeProfiles.mockReset();
    listProfiles.mockReset();
    setCanonicalUserProfileAvatar.mockReset();
    setCanonicalUserProfileDisplayName.mockReset();
    setUserProfileRole.mockReset();
    invalidateOperatorRolePolicy.mockReset();
    getUserProfileListItem.mockReturnValue(profile);
    readResidentUserProfileRevision.mockReset().mockReturnValue(residentProfile);
  });

  const malformedRequests = [
    { method: "users.list", params: {} },
    { method: "users.self", params: {} },
    { method: "users.prefs.get", params: { keys: ["ui.theme"] } },
    { method: "users.prefs.set", params: { entries: { "ui.theme": "claw" } } },
    {
      method: "users.linkEmail",
      params: { email: "ada@example.test", targetProfileId: "profile-1" },
    },
    {
      method: "users.setDisplayName",
      params: { profileId: "profile-1", displayName: "Ada" },
    },
    { method: "users.setRole", params: { profileId: "profile-1", role: null } },
    {
      method: "users.setAvatar",
      params: { profileId: "profile-1", mime: "image/png", avatarBase64: "AQ==" },
    },
  ].map(({ method, params }) => ({
    method,
    params: { ...params, unexpected: true },
    schema: true,
    message: `invalid ${method} params: at root: unexpected property 'unexpected'`,
  }));
  it.each<{
    method: string;
    params: object;
    schema?: boolean;
    message?: string | RegExp;
    readsConfig?: boolean;
  }>([
    ...malformedRequests,
    { method: "users.setRole", params: { profileId: profile.id, role: "   " } },
    {
      method: "users.linkEmail",
      params: { email: "   ", targetProfileId: profile.id },
      message: "email must not be empty",
    },
    {
      method: "users.setAvatar",
      params: { profileId: profile.id, mime: "image/png", avatarBase64: "not base64" },
    },
    {
      method: "users.setRole",
      params: { profileId: profile.id, role: "maintainer" },
      readsConfig: true,
      message: /gateway\.roles\.definitions/,
    },
  ])(
    "rejects invalid $method params before state effects: $params",
    async ({ method, params, schema, message, readsConfig }) => {
      const original = structuredClone(params);
      const unreadableState = new Proxy(
        {},
        {
          get() {
            throw new Error("invalid users request reached owner state");
          },
        },
      );
      const getRuntimeConfig = vi.fn(() => ({
        gateway: { roles: { definitions: { guest: {} } } },
      }));
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
      for (const effect of [
        ensureProfileIdForEmail,
        prepareUserProfileRoleAuthority,
        getUserProfileListItem,
        linkEmail,
        mergeProfiles,
        readResidentUserProfileRevision,
        listProfiles,
        setCanonicalUserProfileAvatar,
        setCanonicalUserProfileDisplayName,
        setUserProfileRole,
        invalidateOperatorRolePolicy,
      ]) {
        expect(effect).not.toHaveBeenCalled();
      }
    },
  );

  function connectedProfileClient(kind: string) {
    return {
      ...(kind === "provider"
        ? { authenticatedUserId: "ada@github", authenticatedUserIsTailscaleProvider: true }
        : {}),
      authenticatedUserProfile: {
        profileId: profile.id,
        displayName: "Ada",
        hasAvatar: false,
        updatedAt: 1,
      },
      connect: { scopes: ["operator.write"] },
    };
  }

  it.each(["email", "proxy", "provider", "owner"])(
    "resolves users.self idempotently from the %s identity",
    async (kind) => {
      const legacy = kind === "email" || kind === "proxy";
      const email = kind === "email" ? "ada@example.com" : "ada@github";
      const client = legacy
        ? { ...selfClient, authenticatedUserId: email }
        : connectedProfileClient(kind);
      const expected = legacy ? profile : { ...profile, emails: [] };
      ensureProfileIdForEmail.mockResolvedValue(profile.id);
      getUserProfileListItem.mockReturnValue(expected);
      for (let call = 1; call <= 2; call++) {
        const respond = await runUsersHandler("users.self", {}, client);
        expect(respond).toHaveBeenCalledWith(true, { profile: expected });
        expect(validateUsersSelfResult(respond.mock.calls[0]?.[1])).toBe(true);
        expect(getUserProfileListItem).toHaveBeenNthCalledWith(call, profile.id);
      }
      if (legacy) {
        expect(ensureProfileIdForEmail).toHaveBeenCalledWith(email, {}, expect.any(Function));
      } else {
        expect(ensureProfileIdForEmail).not.toHaveBeenCalled();
      }
    },
  );

  it("waits for the authenticated GitHub sync before returning users.self", async () => {
    let finishSync: (() => void) | undefined;
    const providerClient: Record<string, unknown> = {
      authenticatedUserId: "ada@github",
      authenticatedUserIsTailscaleProvider: true,
      connect: { scopes: ["operator.write"] },
    };
    const authenticatedGitHubIdentitySync = vi.fn(
      async () =>
        await new Promise<{ profileId: string; updatedAt: number }>((resolve) => {
          finishSync = () => {
            providerClient.authenticatedUserProfile = {
              profileId: profile.id,
              displayName: "Ada",
              hasAvatar: false,
              updatedAt: 1,
            };
            resolve({ profileId: profile.id, updatedAt: profile.updatedAt });
          };
        }),
    );
    providerClient.authenticatedGitHubIdentitySync = authenticatedGitHubIdentitySync;
    getUserProfileListItem.mockReturnValue(profile);

    const pending = runUsersHandler("users.self", {}, providerClient);
    await Promise.resolve();

    expect(authenticatedGitHubIdentitySync).toHaveBeenCalledOnce();
    expect(getUserProfileListItem).not.toHaveBeenCalled();
    finishSync?.();
    const respond = await pending;
    expect(respond).toHaveBeenCalledWith(true, { profile });
  });

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
        providerClient.authenticatedUserProfile = {
          profileId: profile.id,
          displayName: "Ada",
          hasAvatar: false,
          updatedAt: 1,
        };
        return { profileId: profile.id, updatedAt: profile.updatedAt };
      });
    providerClient.authenticatedGitHubIdentitySync = authenticatedGitHubIdentitySync;
    getUserProfileListItem.mockReturnValue(profile);

    expect(await runUsersHandler("users.self", {}, providerClient)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: true,
        details: { code: "AUTHENTICATED_PROFILE_UNAVAILABLE" },
      }),
    );
    expect(await runUsersHandler("users.self", {}, providerClient)).toHaveBeenCalledWith(true, {
      profile,
    });
    expect(authenticatedGitHubIdentitySync).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      client: {
        ...selfClient,
        authenticatedUserId: "ada@github",
        authenticatedUserIsTailscaleProvider: true,
      },
      error: { code: "UNAVAILABLE", retryable: true },
    },
    {
      client: { connect: { scopes: ["operator.write"] } },
      error: { code: "FORBIDDEN", message: "users.self requires an authenticated user" },
    },
  ])(
    "rejects unresolved users.self with $error.code without creating an alias",
    async ({ client, error }) => {
      expect(await runUsersHandler("users.self", {}, client)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining(error),
      );
      expect(ensureProfileIdForEmail).not.toHaveBeenCalled();
    },
  );

  it("validates and routes email links", async () => {
    linkEmail.mockReturnValue({
      profile,
      display: {
        id: profile.id,
        displayName: profile.displayName,
        avatarRevision: String(profile.updatedAt),
        hasAvatar: profile.hasAvatar,
      },
    });
    const refreshConnectedUserProfile = vi.fn();
    const broadcast = vi.fn();

    const respond = await runUsersHandler(
      "users.linkEmail",
      {
        email: "ada@example.com",
        targetProfileId: "profile-1",
      },
      undefined,
      { refreshConnectedUserProfile, broadcast },
    );

    expect(respond).toHaveBeenCalledWith(true, { profile });
    expect(validateUsersLinkEmailResult(respond.mock.calls[0]?.[1])).toBe(true);
    expect(linkEmail).toHaveBeenCalledWith("ada@example.com", "profile-1", {
      assertCurrent: expect.any(Function),
    });
    expect(broadcast).toHaveBeenCalledWith("chat.metadata.changed", {}, { dropIfSlow: true });
    expect(refreshConnectedUserProfile).toHaveBeenCalledWith({
      id: profile.id,
      displayName: profile.displayName,
      avatarRevision: String(profile.updatedAt),
      hasAvatar: profile.hasAvatar,
      updatedAt: profile.updatedAt,
    });
  });

  it.each(["users.linkEmail", "users.merge"] as const)(
    "suppresses %s publications when the administrator changes during the write",
    async (method) => {
      const entered = createDeferred();
      const release = createDeferred();
      const client = {
        connect: { role: "operator", scopes: ["operator.admin"] },
        authenticatedUserProfile: { profileId: "admin-profile" },
      };
      const store = method === "users.merge" ? mergeProfiles : linkEmail;
      store.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { profile, display, movedAliasKinds: ["email"] };
      });
      const refreshConnectedUserProfile = vi.fn();
      const broadcast = vi.fn();
      const pending = runUsersHandler(
        method,
        method === "users.merge"
          ? { sourceProfileId: "source-profile", targetProfileId: profile.id }
          : { email: "ada@example.com", targetProfileId: profile.id },
        client,
        { refreshConnectedUserProfile, broadcast },
      );
      try {
        await awaitGateBeforeSettlement(entered.promise, pending, "profile write was not awaited");
        expect(refreshConnectedUserProfile).not.toHaveBeenCalled();
        expect(broadcast).not.toHaveBeenCalled();
        client.authenticatedUserProfile.profileId = "replacement-profile";
      } finally {
        release.resolve();
        await pending;
      }
      const respond = await pending;
      if (method === "users.merge") {
        expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
          profile,
          movedAliasKinds: ["email"],
        });
      } else {
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE" }),
        );
      }
      expect(refreshConnectedUserProfile).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      method: "users.linkEmail",
      operation: "merge",
      params: { email: "person@example.test", targetProfileId: "gateway-owner" },
      store: linkEmail,
      message:
        "the shared owner profile cannot be merged; sign in with a personal identity instead",
    },
    {
      method: "users.setRole",
      operation: "role",
      params: { profileId: "gateway-owner", role: "guest" },
      store: setUserProfileRole,
      message: "the shared owner profile is not governed by operator roles",
    },
  ] as const)(
    "maps owner rejection from $method to an invalid request",
    async ({ method, operation, params, store, message }) => {
      store.mockImplementationOnce(() => {
        throw new UserProfileOwnerError(operation);
      });
      const refreshConnectedUserProfile = vi.fn();
      const disconnectClientsForUserProfile = vi.fn();

      const respond = await runUsersHandler(method, params, adminClient, {
        getRuntimeConfig: () => ({ gateway: { roles: { definitions: { guest: {} } } } }),
        refreshConnectedUserProfile,
        disconnectClientsForUserProfile,
      });

      expect(respond).toHaveBeenCalledWith(false, undefined, {
        code: "INVALID_REQUEST",
        message,
      });
      expect(refreshConnectedUserProfile).not.toHaveBeenCalled();
      expect(disconnectClientsForUserProfile).not.toHaveBeenCalled();
      expect(invalidateOperatorRolePolicy).not.toHaveBeenCalled();
    },
  );

  it("refreshes from the current catalog when an older name write returns late", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const firstProfile = { ...profile, displayName: "First name", updatedAt: 2 };
    setCanonicalUserProfileDisplayName.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return {
        profile: firstProfile,
        display: { ...display, displayName: "First name", avatarRevision: "2" },
      };
    });
    const refreshConnectedUserProfile = vi.fn();
    const pending = runUsersHandler(
      "users.setDisplayName",
      { profileId: profile.id, displayName: "First name" },
      adminClient,
      { refreshConnectedUserProfile },
    );
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "profile write was not awaited");
      expect(refreshConnectedUserProfile).not.toHaveBeenCalled();
      readResidentUserProfileRevision.mockReturnValue({
        ...residentProfile,
        display_name: "Later name",
        updated_at: 3,
      });
    } finally {
      release.resolve();
      await pending;
    }
    const respond = await pending;
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, { profile: firstProfile });
    expect(validateUsersSetDisplayNameResult(respond.mock.calls[0]?.[1])).toBe(true);
    expect(refreshConnectedUserProfile).toHaveBeenCalledExactlyOnceWith({
      id: profile.id,
      displayName: "Later name",
      avatarRevision: "3",
      hasAvatar: false,
      updatedAt: 3,
    });
  });

  it.each(["guest", null])(
    "sets role %s and invalidates policy before responding",
    async (role) => {
      const assignedProfile = role ? { ...profile, role, updatedAt: 2 } : profile;
      const disconnectClientsForUserProfile = vi.fn();
      setUserProfileRole.mockReturnValue(assignedProfile);
      const respond = await runUsersHandler(
        "users.setRole",
        { profileId: profile.id, role },
        adminClient,
        {
          getRuntimeConfig: () =>
            role ? { gateway: { roles: { definitions: { guest: {} } } } } : {},
          ...(role ? { disconnectClientsForUserProfile } : {}),
        },
      );
      expect(respond).toHaveBeenCalledWith(true, { profile: assignedProfile });
      expect(validateUsersSetRoleResult(respond.mock.calls[0]?.[1])).toBe(true);
      expect(setUserProfileRole).toHaveBeenCalledWith(profile.id, role, {
        assertCurrent: expect.any(Function),
        onCommitted: expect.any(Function),
      });
      for (const publish of [
        invalidateOperatorRolePolicy,
        ...(role ? [disconnectClientsForUserProfile] : []),
      ]) {
        expect(publish).toHaveBeenCalledWith(profile.id);
        expect(publish.mock.invocationCallOrder[0]).toBeLessThan(
          respond.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
      }
    },
  );

  it("returns content-based avatar revisions even for edits with identical timestamps", async () => {
    const edited = { ...profile, avatarMime: "image/png" as const, hasAvatar: true, updatedAt: 2 };
    const refreshConnectedUserProfile = vi.fn();
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
        { profileId: profile.id, mime: "image/png", avatarBase64: index === 0 ? "AQ==" : "Ag==" },
        adminClient,
        { refreshConnectedUserProfile },
      );
      expect(validateUsersSetAvatarResult(respond.mock.calls[0]?.[1])).toBe(true);
      expect(respond).toHaveBeenCalledWith(true, { profile: edited, avatarRevision });
      expect(refreshConnectedUserProfile).toHaveBeenNthCalledWith(index + 1, {
        id: edited.id,
        displayName: edited.displayName,
        avatarRevision,
        hasAvatar: true,
        updatedAt: edited.updatedAt,
      });
      expect(refreshConnectedUserProfile.mock.invocationCallOrder[index]).toBeLessThan(
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
          profileId: kind === "foreign" ? "profile-2" : profile.id,
          mime: "image/png",
          avatarBase64: "AQ==",
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
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining(error),
      );
      if (kind !== "constraint") {
        expect(setCanonicalUserProfileAvatar).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["email", "provider", "owner", "merged"])(
    "allows profile edits through the %s identity",
    async (kind) => {
      const legacy = kind === "email" || kind === "merged";
      const client = legacy ? selfClient : connectedProfileClient(kind);
      const target = kind === "merged" ? "merged-profile-1" : profile.id;
      ensureProfileIdForEmail.mockResolvedValue(profile.id);
      prepareUserProfileRoleAuthority.mockResolvedValue({
        profileId: profile.id,
        isCurrent: () => true,
      });
      setCanonicalUserProfileDisplayName.mockResolvedValue({ profile, display });
      setCanonicalUserProfileAvatar.mockResolvedValue({ ok: true, value: { profile, display } });
      expect(
        await runUsersHandler(
          "users.setDisplayName",
          { profileId: target, displayName: "Ada Lovelace" },
          client,
        ),
      ).toHaveBeenCalledWith(true, { profile });
      if (kind === "email") {
        expect(
          await runUsersHandler(
            "users.setAvatar",
            { profileId: target, mime: "image/png", avatarBase64: "AQ==" },
            client,
          ),
        ).toHaveBeenCalledWith(true, { profile, avatarRevision: String(profile.updatedAt) });
      }
      if (legacy) {
        expect(ensureProfileIdForEmail).toHaveBeenCalledWith(
          "ada@example.com",
          {},
          expect.any(Function),
        );
        expect(prepareUserProfileRoleAuthority).toHaveBeenCalledWith(target);
      } else {
        expect(ensureProfileIdForEmail).not.toHaveBeenCalled();
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
    const entered = createDeferred();
    const release = createDeferred();
    const connection = new AbortController();
    const request = new AbortController();
    const client = {
      ...selfClient,
      connId: "profile-requester",
      connectionSignal: connection.signal,
      authenticatedUserProfile: undefined as { profileId: string } | undefined,
    };
    let authorityCurrent = true;
    ensureProfileIdForEmail.mockResolvedValue(profile.id);
    prepareUserProfileRoleAuthority.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { profileId: profile.id, isCurrent: () => authorityCurrent };
    });
    setCanonicalUserProfileDisplayName.mockResolvedValue({ profile, display });
    const pending = runUsersHandler(
      "users.setDisplayName",
      { profileId: profile.id, displayName: "Ada Lovelace" },
      client,
      {},
      { signal: request.signal },
    );
    try {
      await Promise.race([entered.promise, pending]);
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
    } finally {
      release.resolve();
      await pending;
    }
    const respond = await pending;
    if (change === "unchanged") {
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, { profile });
      expect(setCanonicalUserProfileDisplayName).toHaveBeenCalledOnce();
    } else {
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
      );
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
    const entered = createDeferred();
    const release = createDeferred();
    const connection = new AbortController();
    const client = {
      ...connectedProfileClient("owner"),
      connectionSignal: connection.signal,
    };
    let authorityCurrent = true;
    prepareUserProfileRoleAuthority.mockImplementation(async (profileId: string) => ({
      profileId,
      isCurrent: () => authorityCurrent,
    }));
    const avatar = method === "users.setAvatar";
    const store = avatar ? setCanonicalUserProfileAvatar : setCanonicalUserProfileDisplayName;
    store.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return avatar ? { ok: true, value: { profile, display } } : { profile, display };
    });
    const refreshConnectedUserProfile = vi.fn();
    const respond = vi.fn();
    const pending = Promise.resolve(
      expectDefined(
        usersHandlers[method],
        `${method} test invariant`,
      )({
        client,
        context: { getRuntimeConfig: () => ({}), refreshConnectedUserProfile },
        params: avatar
          ? { profileId: profile.id, mime: "image/png", avatarBase64: "AQ==" }
          : { profileId: profile.id, displayName: "Ada" },
        respond,
      } as never),
    );
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "profile write was not awaited");
      expect(respond).not.toHaveBeenCalled();
      expect(refreshConnectedUserProfile).not.toHaveBeenCalled();
      if (change === "disconnect") {
        connection.abort();
      } else if (change === "profile replacement") {
        client.authenticatedUserProfile.profileId = "replacement-profile";
      } else if (change === "role revocation") {
        authorityCurrent = false;
      } else if (change === "rejection") {
        release.reject(new Error("profile worker unavailable"));
      }
    } finally {
      release.resolve();
      await pending;
    }
    expect(store).toHaveBeenCalledOnce();
    if (change === "active") {
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        true,
        avatar ? { profile, avatarRevision: display.avatarRevision } : { profile },
      );
      expect(refreshConnectedUserProfile).toHaveBeenCalledExactlyOnceWith({
        ...display,
        updatedAt: profile.updatedAt,
      });
    } else {
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
      );
      expect(refreshConnectedUserProfile).not.toHaveBeenCalled();
    }
  });
});
