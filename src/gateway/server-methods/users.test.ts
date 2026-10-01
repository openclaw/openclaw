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

  it.each([
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
  ])("rejects malformed $method before reaching user state", async ({ method, params }) => {
    const invalid = { ...params, unexpected: true };
    const original = structuredClone(invalid);
    const unreadableState = new Proxy(
      {},
      {
        get() {
          throw new Error("invalid users request reached owner state");
        },
      },
    );

    const respond = await runUsersHandler(method, invalid, unreadableState, unreadableState);

    expect(respond.mock.calls).toEqual([
      [
        false,
        undefined,
        {
          code: "INVALID_REQUEST",
          message: `invalid ${method} params: at root: unexpected property 'unexpected'`,
        },
      ],
    ]);
    expect(invalid).toEqual(original);
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
  });

  it("lists profiles through the read method", async () => {
    listProfiles.mockResolvedValue([{ id: "profile-1" }]);

    expect(await runUsersHandler("users.list", {})).toHaveBeenCalledWith(true, {
      profiles: [{ id: "profile-1" }],
    });
  });

  it("creates and returns the caller's profile idempotently", async () => {
    ensureProfileIdForEmail.mockResolvedValue(profile.id);
    getUserProfileListItem.mockReturnValue(profile);

    const first = await runUsersHandler("users.self", {}, selfClient);
    const second = await runUsersHandler("users.self", {}, selfClient);

    expect(first).toHaveBeenCalledWith(true, { profile });
    expect(second).toHaveBeenCalledWith(true, { profile });
    expect(validateUsersSelfResult(first.mock.calls[0]?.[1])).toBe(true);
    expect(getUserProfileListItem).toHaveBeenNthCalledWith(1, profile.id);
    expect(getUserProfileListItem).toHaveBeenNthCalledWith(2, profile.id);
  });

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

  it.each(["provider", "owner"])(
    "uses the connect-time %s profile without recreating an email alias",
    async (kind) => {
      const providerClient = connectedProfileClient(kind);
      getUserProfileListItem.mockReturnValue({ ...profile, emails: [] });

      const respond = await runUsersHandler("users.self", {}, providerClient);

      expect(respond).toHaveBeenCalledWith(true, { profile: { ...profile, emails: [] } });
      expect(ensureProfileIdForEmail).not.toHaveBeenCalled();
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

  it("keeps generic proxy identities on the legacy profile fallback", async () => {
    const proxyClient = {
      authenticatedUserId: "ada@github",
      connect: { scopes: ["operator.write"] },
    };
    ensureProfileIdForEmail.mockResolvedValue(profile.id);
    getUserProfileListItem.mockReturnValue(profile);

    const respond = await runUsersHandler("users.self", {}, proxyClient);

    expect(respond).toHaveBeenCalledWith(true, { profile });
    expect(ensureProfileIdForEmail).toHaveBeenCalledWith("ada@github", {}, expect.any(Function));
  });

  it("does not recreate a failed Tailscale provider snapshot as an email alias", async () => {
    const tailscaleClient = {
      authenticatedUserId: "ada@github",
      authenticatedUserIsTailscaleProvider: true,
      connect: { scopes: ["operator.write"] },
    };

    const respond = await runUsersHandler("users.self", {}, tailscaleClient);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
    );
    expect(ensureProfileIdForEmail).not.toHaveBeenCalled();
  });

  it("rejects users.self without an authenticated user", async () => {
    expect(
      await runUsersHandler("users.self", {}, { connect: { scopes: ["operator.write"] } }),
    ).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "FORBIDDEN",
        message: "users.self requires an authenticated user",
      }),
    );
    expect(ensureProfileIdForEmail).not.toHaveBeenCalled();
  });

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

  it("returns protocol-complete display name mutations", async () => {
    setCanonicalUserProfileDisplayName.mockResolvedValue({ profile, display });
    const refreshConnectedUserProfile = vi.fn();

    const respond = await runUsersHandler(
      "users.setDisplayName",
      {
        profileId: "profile-1",
        displayName: "Ada",
      },
      adminClient,
      { refreshConnectedUserProfile },
    );

    expect(validateUsersSetDisplayNameResult(respond.mock.calls[0]?.[1])).toBe(true);
    expect(refreshConnectedUserProfile).toHaveBeenCalledWith({
      id: profile.id,
      displayName: profile.displayName,
      avatarRevision: "1",
      hasAvatar: false,
      updatedAt: profile.updatedAt,
    });
  });

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
    expect(await pending).toHaveBeenCalledExactlyOnceWith(true, { profile: firstProfile });
    expect(refreshConnectedUserProfile).toHaveBeenCalledExactlyOnceWith({
      id: profile.id,
      displayName: "Later name",
      avatarRevision: "3",
      hasAvatar: false,
      updatedAt: 3,
    });
  });

  it("assigns a configured profile role and invalidates its cached policy", async () => {
    const assignedProfile = { ...profile, role: "guest", updatedAt: 2 };
    const disconnectClientsForUserProfile = vi.fn();
    setUserProfileRole.mockReturnValue(assignedProfile);

    const respond = await runUsersHandler(
      "users.setRole",
      { profileId: profile.id, role: "guest" },
      adminClient,
      {
        getRuntimeConfig: () => ({ gateway: { roles: { definitions: { guest: {} } } } }),
        disconnectClientsForUserProfile,
      },
    );

    expect(respond).toHaveBeenCalledWith(true, { profile: assignedProfile });
    expect(validateUsersSetRoleResult(respond.mock.calls[0]?.[1])).toBe(true);
    expect(setUserProfileRole).toHaveBeenCalledWith(profile.id, "guest", {
      assertCurrent: expect.any(Function),
      onCommitted: expect.any(Function),
    });
    expect(invalidateOperatorRolePolicy).toHaveBeenCalledWith(profile.id);
    expect(invalidateOperatorRolePolicy.mock.invocationCallOrder[0]).toBeLessThan(
      respond.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(disconnectClientsForUserProfile).toHaveBeenCalledWith(profile.id);
    expect(disconnectClientsForUserProfile.mock.invocationCallOrder[0]).toBeLessThan(
      respond.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("clears profile roles even when role definitions have been removed", async () => {
    setUserProfileRole.mockReturnValue(profile);

    const respond = await runUsersHandler(
      "users.setRole",
      { profileId: profile.id, role: null },
      adminClient,
      { getRuntimeConfig: () => ({}) },
    );

    expect(respond).toHaveBeenCalledWith(true, { profile });
    expect(setUserProfileRole).toHaveBeenCalledWith(profile.id, null, {
      assertCurrent: expect.any(Function),
      onCommitted: expect.any(Function),
    });
    expect(invalidateOperatorRolePolicy).toHaveBeenCalledWith(profile.id);
  });

  it("rejects undefined profile roles before changing storage or cached policy", async () => {
    const respond = await runUsersHandler(
      "users.setRole",
      { profileId: profile.id, role: "maintainer" },
      adminClient,
      { getRuntimeConfig: () => ({ gateway: { roles: { definitions: { guest: {} } } } }) },
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("gateway.roles.definitions"),
      }),
    );
    expect(setUserProfileRole).not.toHaveBeenCalled();
    expect(invalidateOperatorRolePolicy).not.toHaveBeenCalled();
  });

  it("rejects malformed profile role assignments before reading configuration", async () => {
    const getRuntimeConfig = vi.fn();

    const respond = await runUsersHandler(
      "users.setRole",
      { profileId: profile.id, role: "   " },
      adminClient,
      { getRuntimeConfig },
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(getRuntimeConfig).not.toHaveBeenCalled();
    expect(setUserProfileRole).not.toHaveBeenCalled();
  });

  it("returns protocol-complete avatar mutations", async () => {
    const firstProfile = {
      ...profile,
      avatarMime: "image/png" as const,
      hasAvatar: true,
      updatedAt: 2,
    };
    const secondProfile = { ...firstProfile };
    setCanonicalUserProfileAvatar
      .mockResolvedValueOnce({
        ok: true,
        value: {
          profile: firstProfile,
          display: { ...display, avatarRevision: "first-content-hash-png", hasAvatar: true },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          profile: secondProfile,
          display: { ...display, avatarRevision: "second-content-hash-png", hasAvatar: true },
        },
      });
    readResidentUserProfileRevision
      .mockReturnValueOnce({
        ...residentProfile,
        avatar_mime: "image/png",
        avatar_sha256: "first-content-hash",
        has_avatar: 1,
        updated_at: firstProfile.updatedAt,
      })
      .mockReturnValueOnce({
        ...residentProfile,
        avatar_mime: "image/png",
        avatar_sha256: "second-content-hash",
        has_avatar: 1,
        updated_at: secondProfile.updatedAt,
      });
    const refreshConnectedUserProfile = vi.fn();

    const firstRespond = await runUsersHandler(
      "users.setAvatar",
      {
        profileId: "profile-1",
        mime: "image/png",
        avatarBase64: "AQ==",
      },
      adminClient,
      { refreshConnectedUserProfile },
    );
    const secondRespond = await runUsersHandler(
      "users.setAvatar",
      {
        profileId: profile.id,
        mime: "image/png",
        avatarBase64: "Ag==",
      },
      adminClient,
      { refreshConnectedUserProfile },
    );

    expect(validateUsersSetAvatarResult(firstRespond.mock.calls[0]?.[1])).toBe(true);
    expect(validateUsersSetAvatarResult(secondRespond.mock.calls[0]?.[1])).toBe(true);
    expect(firstRespond).toHaveBeenCalledWith(true, {
      profile: firstProfile,
      avatarRevision: "first-content-hash-png",
    });
    expect(secondRespond).toHaveBeenCalledWith(true, {
      profile: secondProfile,
      avatarRevision: "second-content-hash-png",
    });
    expect(firstProfile.updatedAt).toBe(secondProfile.updatedAt);
    expect(refreshConnectedUserProfile).toHaveBeenNthCalledWith(1, {
      id: firstProfile.id,
      displayName: firstProfile.displayName,
      avatarRevision: "first-content-hash-png",
      hasAvatar: true,
      updatedAt: firstProfile.updatedAt,
    });
    expect(refreshConnectedUserProfile).toHaveBeenNthCalledWith(2, {
      id: secondProfile.id,
      displayName: secondProfile.displayName,
      avatarRevision: "second-content-hash-png",
      hasAvatar: true,
      updatedAt: secondProfile.updatedAt,
    });
    expect(refreshConnectedUserProfile.mock.invocationCallOrder[0]).toBeLessThan(
      firstRespond.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(refreshConnectedUserProfile.mock.invocationCallOrder[1]).toBeLessThan(
      secondRespond.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("rejects blank email aliases as invalid requests", async () => {
    expect(
      await runUsersHandler("users.linkEmail", {
        email: "   ",
        targetProfileId: "profile-1",
      }),
    ).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST", message: "email must not be empty" }),
    );
    expect(linkEmail).not.toHaveBeenCalled();
  });

  it("rejects malformed avatar payloads before storage", async () => {
    expect(
      await runUsersHandler("users.setAvatar", {
        profileId: "profile-1",
        mime: "image/png",
        avatarBase64: "not base64",
      }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(setCanonicalUserProfileAvatar).not.toHaveBeenCalled();
  });

  it("returns avatar constraint failures as invalid requests", async () => {
    setCanonicalUserProfileAvatar.mockResolvedValue({
      ok: false,
      error: { code: "avatar_too_large" },
    });

    expect(
      await runUsersHandler(
        "users.setAvatar",
        {
          profileId: "profile-1",
          mime: "image/png",
          avatarBase64: "AQ==",
        },
        adminClient,
      ),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  it("allows an identified write caller to edit its own profile", async () => {
    ensureProfileIdForEmail.mockResolvedValue(profile.id);
    setCanonicalUserProfileDisplayName.mockResolvedValue({ profile, display });
    setCanonicalUserProfileAvatar.mockResolvedValue({ ok: true, value: { profile, display } });

    const displayName = await runUsersHandler(
      "users.setDisplayName",
      { profileId: "profile-1", displayName: "Ada Lovelace" },
      selfClient,
    );
    const avatar = await runUsersHandler(
      "users.setAvatar",
      { profileId: "profile-1", mime: "image/png", avatarBase64: "AQ==" },
      selfClient,
    );

    expect(displayName).toHaveBeenCalledWith(true, { profile });
    expect(avatar).toHaveBeenCalledWith(true, {
      profile,
      avatarRevision: String(profile.updatedAt),
    });
    expect(ensureProfileIdForEmail).toHaveBeenCalledWith(
      "ada@example.com",
      {},
      expect.any(Function),
    );
  });

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

  it("reports rejected profile acquisition without applying an avatar mutation", async () => {
    ensureProfileIdForEmail.mockRejectedValueOnce(new Error("profile worker unavailable"));

    const respond = await runUsersHandler(
      "users.setAvatar",
      { profileId: profile.id, mime: "image/png", avatarBase64: "AQ==" },
      selfClient,
    );

    expect(respond).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", message: "profile worker unavailable" }),
    );
    expect(setCanonicalUserProfileAvatar).not.toHaveBeenCalled();
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

  it.each(["provider", "owner"])(
    "authorizes %s profile edits from the connect-time profile id",
    async (kind) => {
      const providerClient = connectedProfileClient(kind);
      setCanonicalUserProfileDisplayName.mockResolvedValue({ profile, display });

      expect(
        await runUsersHandler(
          "users.setDisplayName",
          { profileId: profile.id, displayName: "Ada Lovelace" },
          providerClient,
        ),
      ).toHaveBeenCalledWith(true, { profile });
      expect(ensureProfileIdForEmail).not.toHaveBeenCalled();
    },
  );

  it("denies an identified write caller changing another profile's avatar", async () => {
    ensureProfileIdForEmail.mockResolvedValue(profile.id);

    expect(
      await runUsersHandler(
        "users.setAvatar",
        { profileId: "profile-2", mime: "image/png", avatarBase64: "AQ==" },
        selfClient,
      ),
    ).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "FORBIDDEN",
        message: "profile edits require the owning user or operator.admin",
      }),
    );
    expect(setCanonicalUserProfileAvatar).not.toHaveBeenCalled();
  });

  it("allows an owner to edit through a tombstoned durable profile id", async () => {
    ensureProfileIdForEmail.mockResolvedValue(profile.id);
    prepareUserProfileRoleAuthority.mockResolvedValue({
      profileId: profile.id,
      isCurrent: () => true,
    });
    setCanonicalUserProfileDisplayName.mockResolvedValue({ profile, display });

    expect(
      await runUsersHandler(
        "users.setDisplayName",
        { profileId: "merged-profile-1", displayName: "Ada Lovelace" },
        selfClient,
      ),
    ).toHaveBeenCalledWith(true, { profile });
    expect(prepareUserProfileRoleAuthority).toHaveBeenCalledWith("merged-profile-1");
  });
});
