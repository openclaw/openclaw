import { describe, expect, it } from "vitest";
import { buildAuthenticatedPresenceUser } from "./authenticated-presence-user.js";

describe("authenticated presence user", () => {
  it.each(["Ada", null])(
    "publishes the owner profile with display name %s and no email",
    (displayName) => {
      expect(
        buildAuthenticatedPresenceUser({
          authenticatedUserId: "private-login@example.test",
          authenticatedUserProfile: {
            profileId: "owner-profile",
            displayName,
            avatarRevision: "1",
          },
        }),
      ).toEqual({
        id: "owner-profile",
        identity: { type: "profile", id: "owner-profile" },
        ...(displayName ? { name: displayName } : {}),
        avatarUrl: "/api/users/owner-profile/avatar?v=1",
      });
    },
  );

  it.each([
    [{ authenticatedUserId: "private-login@example.test" }, undefined],
    [{ authenticatedUserId: "public-handle" }, { id: "public-handle" }],
    [
      { authenticatedUserId: "public-handle@github", authenticatedUserIsTailscaleProvider: true },
      { id: "public-handle@github" },
    ],
  ] as const)("keeps private principals out of unresolved presence: %j", (params, expected) => {
    expect(buildAuthenticatedPresenceUser(params)).toEqual(expected);
  });
});
