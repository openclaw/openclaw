import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usersHandlers } from "./users.js";

const linkEmail = vi.hoisted(() => vi.fn());
const listProfiles = vi.hoisted(() => vi.fn());
const setAvatar = vi.hoisted(() => vi.fn());
const setDisplayName = vi.hoisted(() => vi.fn());

vi.mock("../../state/user-profiles.js", () => ({
  linkEmail,
  listProfiles,
  setAvatar,
  setDisplayName,
  UserProfileNotFoundError: class UserProfileNotFoundError extends Error {},
}));

async function runUsersHandler(method: keyof typeof usersHandlers, params: object) {
  const respond = vi.fn();
  await expectDefined(
    usersHandlers[method],
    `${method} test invariant`,
  )({ params, respond } as never);
  return respond;
}

describe("users gateway methods", () => {
  beforeEach(() => {
    linkEmail.mockReset();
    listProfiles.mockReset();
    setAvatar.mockReset();
    setDisplayName.mockReset();
  });

  it("lists profiles through the read method", async () => {
    listProfiles.mockReturnValue([{ id: "profile-1" }]);

    expect(await runUsersHandler("users.list", {})).toHaveBeenCalledWith(true, {
      profiles: [{ id: "profile-1" }],
    });
  });

  it("validates and routes email links", async () => {
    linkEmail.mockReturnValue({ id: "profile-1" });

    expect(
      await runUsersHandler("users.linkEmail", {
        email: "ada@example.com",
        targetProfileId: "profile-1",
      }),
    ).toHaveBeenCalledWith(true, { profile: { id: "profile-1" } });
    expect(linkEmail).toHaveBeenCalledWith("ada@example.com", "profile-1");
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
    expect(setAvatar).not.toHaveBeenCalled();
  });

  it("returns avatar constraint failures as invalid requests", async () => {
    setAvatar.mockReturnValue({ ok: false, error: { code: "avatar_too_large" } });

    expect(
      await runUsersHandler("users.setAvatar", {
        profileId: "profile-1",
        mime: "image/png",
        avatarBase64: "AQ==",
      }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
});
