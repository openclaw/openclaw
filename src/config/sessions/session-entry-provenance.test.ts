import { describe, expect, it } from "vitest";
import {
  inheritSpawnSessionOwner,
  sessionPersonalProfileId,
  type SessionCreatedActor,
} from "./session-entry-provenance.js";

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

describe("inheritSpawnSessionOwner", () => {
  const creator: SessionCreatedActor = { type: "human", source: "profile", id: "profile-vito" };
  const spawningAgent = { type: "agent" as const, id: "roboclaw" };

  it("assigns an authenticated human parent creator to the visible child", () => {
    expect(
      inheritSpawnSessionOwner({ createdActor: creator }, spawningAgent, "profile-vito", 42),
    ).toEqual({
      actor: { type: "human", id: "profile-vito" },
      assignedBy: spawningAgent,
      assignedAt: 42,
    });
  });

  it("uses the current human owner instead of the original creator", () => {
    expect(
      inheritSpawnSessionOwner(
        { owner: { actor: { type: "human", id: "profile-owner" } }, createdActor: creator },
        spawningAgent,
        "profile-owner",
        42,
      ),
    ).toMatchObject({ actor: { type: "human", id: "profile-owner" } });
  });

  it("requires the active requester to match the effective human owner", () => {
    expect(
      inheritSpawnSessionOwner({ createdActor: creator }, spawningAgent, "profile-other"),
    ).toMatchObject({ actor: spawningAgent });
    expect(
      inheritSpawnSessionOwner({ createdActor: creator }, spawningAgent, undefined),
    ).toMatchObject({ actor: spawningAgent });
  });

  it("matches a historical owner alias to the requester's canonical profile", () => {
    const resolveProfileId = (profileId: string) =>
      profileId === "profile-before-merge" ? "profile-after-merge" : profileId;
    expect(
      inheritSpawnSessionOwner(
        {
          owner: { actor: { type: "human", id: "profile-before-merge" } },
          createdActor: creator,
        },
        spawningAgent,
        "profile-after-merge",
        42,
        resolveProfileId,
      ),
    ).toEqual({
      actor: { type: "human", id: "profile-after-merge" },
      assignedBy: spawningAgent,
      assignedAt: 42,
    });
  });

  it("does not override an explicit agent owner or adopt an unlinked channel identity", () => {
    expect(
      inheritSpawnSessionOwner(
        { owner: { actor: { type: "agent", id: "another-agent" } }, createdActor: creator },
        spawningAgent,
        "profile-vito",
      ),
    ).toMatchObject({ actor: spawningAgent });
    expect(
      inheritSpawnSessionOwner(
        { createdActor: { type: "human", source: "channel", id: "discord-user" } },
        spawningAgent,
        "discord-user",
      ),
    ).toMatchObject({ actor: spawningAgent });
  });
});
