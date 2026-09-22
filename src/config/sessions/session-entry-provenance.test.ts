import { describe, expect, it } from "vitest";
import { sessionPersonalProfileId, type SessionCreatedActor } from "./session-entry-provenance.js";

describe("sessionPersonalProfileId", () => {
  const creator: SessionCreatedActor = { type: "human", source: "profile", id: "profile-creator" };

  it("prefers the assigned human over the authenticated human creator", () => {
    expect(
      sessionPersonalProfileId({
        owner: { actor: { type: "human", id: "profile-owner", label: "profile-other" } },
        createdActor: creator,
      }),
    ).toBe("profile-owner");
  });

  it("uses the authenticated human creator when there is no assignment", () => {
    expect(sessionPersonalProfileId({ createdActor: creator })).toBe("profile-creator");
  });

  it.each(["agent", "system"] as const)(
    "falls back to the authenticated human creator for a %s assignment",
    (type) => {
      expect(
        sessionPersonalProfileId({
          owner: { actor: { type, id: "profile-not-a-human" } },
          createdActor: creator,
        }),
      ).toBe("profile-creator");
    },
  );

  it.each(["channel", "unknown"] as const)(
    "does not treat a %s creator ID or label as an authenticated profile",
    (source) => {
      expect(
        sessionPersonalProfileId({
          createdActor: { type: "human", source, id: "profile-creator", label: "profile-owner" },
        }),
      ).toBeUndefined();
    },
  );

  it("does not fall back or infer an ID from a label when an assigned human has no ID", () => {
    expect(
      sessionPersonalProfileId({
        owner: { actor: { type: "human", label: "profile-owner" } },
        createdActor: creator,
      }),
    ).toBeUndefined();
  });

  it("does not infer a creator profile from a display label", () => {
    expect(
      sessionPersonalProfileId({
        createdActor: { type: "human", source: "profile", label: "profile-creator" },
      }),
    ).toBeUndefined();
  });

  it("returns no profile when the session has no human identity", () => {
    expect(sessionPersonalProfileId(undefined)).toBeUndefined();
    expect(sessionPersonalProfileId({})).toBeUndefined();
    expect(
      sessionPersonalProfileId({
        owner: { actor: { type: "agent", id: "profile-owner" } },
        createdActor: { type: "system", id: "profile-creator" },
      }),
    ).toBeUndefined();
  });
});
