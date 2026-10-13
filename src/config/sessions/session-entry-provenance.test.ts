import { expect, it } from "vitest";
import {
  resolveDelegatedSessionCreator,
  inheritSpawnSessionOwner,
  inheritSessionCreationPolicy,
  sessionSandboxActor,
  preserveCreationStamp,
  sessionPersonalProfileId,
  type SessionActor,
  type SessionCreatedActor,
  type SessionSandboxProvenance,
} from "./session-entry-provenance.js";

type Source = Parameters<typeof sessionPersonalProfileId>[0];
const creator: SessionCreatedActor = { type: "human", source: "profile", id: "profile-creator" };
const human = (id?: string, label?: string): SessionActor => ({ type: "human", id, label });
const spawningAgent: SessionActor = { type: "agent", id: "roboclaw" };

it("resolves personal profiles from assigned humans or authenticated creators only", () => {
  const cases: Array<[Source, string | undefined]> = [
    [
      { owner: { actor: human("profile-owner", "profile-other") }, createdActor: creator },
      "profile-owner",
    ],
    [{ createdActor: creator }, "profile-creator"],
    [
      { owner: { actor: { type: "agent", id: "profile-not-a-human" } }, createdActor: creator },
      "profile-creator",
    ],
    [
      {
        createdActor: {
          type: "human",
          source: "channel",
          id: "profile-creator",
          label: "profile-owner",
        },
      },
      undefined,
    ],
    [{ owner: { actor: human(undefined, "profile-owner") }, createdActor: creator }, undefined],
    [{ createdActor: { type: "human", source: "profile", label: "profile-creator" } }, undefined],
    [undefined, undefined],
    [{}, undefined],
    [
      {
        owner: { actor: { type: "agent", id: "profile-owner" } },
        createdActor: { type: "system", id: "profile-creator" },
      },
      undefined,
    ],
  ];
  for (const [source, expected] of cases) {
    expect(sessionPersonalProfileId(source), JSON.stringify(source)).toBe(expected);
  }
});

it("inherits only the requesting human's current owner, including canonical profile aliases", () => {
  const cases: Array<{
    source: Source;
    requester: string | undefined;
    actor: SessionActor;
    now?: number;
    resolve?: (profileId: string) => string | undefined;
  }> = [
    { source: { createdActor: creator }, requester: creator.id, actor: human(creator.id), now: 42 },
    {
      source: { owner: { actor: human("profile-owner") }, createdActor: creator },
      requester: "profile-owner",
      actor: human("profile-owner"),
      now: 42,
    },
    { source: { createdActor: creator }, requester: "profile-other", actor: spawningAgent },
    { source: { createdActor: creator }, requester: undefined, actor: spawningAgent },
    {
      source: { owner: { actor: human("profile-before-merge") }, createdActor: creator },
      requester: "profile-after-merge",
      actor: human("profile-after-merge"),
      now: 42,
      resolve: (id) => (id === "profile-before-merge" ? "profile-after-merge" : id),
    },
    {
      source: { owner: { actor: { type: "agent", id: "another-agent" } }, createdActor: creator },
      requester: creator.id,
      actor: spawningAgent,
    },
    {
      source: { createdActor: { type: "human", source: "channel", id: "discord-user" } },
      requester: "discord-user",
      actor: spawningAgent,
    },
  ];
  for (const { source, requester, actor, now, resolve } of cases) {
    expect(inheritSpawnSessionOwner(source, spawningAgent, requester, now, resolve)).toEqual({
      actor,
      assignedBy: spawningAgent,
      assignedAt: now ?? expect.any(Number),
    });
  }
});

it("keeps required isolation separate from explicit and actorless creation attribution", () => {
  const actor = { type: "human", source: "profile", id: "alice" } as const;
  const requester = { type: "human", source: "profile", id: "bob" } as const;
  const cases: Array<SessionSandboxProvenance | undefined> = [undefined, {}, { actor }];
  for (const sandboxProvenance of cases) {
    const source = { createdActor: actor, sandbox: "required" as const, sandboxProvenance };
    const isolation = sandboxProvenance === undefined ? actor : sandboxProvenance.actor;
    const next = inheritSessionCreationPolicy(source, requester);
    expect(next).toMatchObject({
      actor: requester,
      sandbox: "required",
      sandboxProvenance: { actor: isolation },
    });
    expect(inheritSessionCreationPolicy(source).actor).toEqual(actor);
    expect(
      sessionSandboxActor({ createdActor: requester, sandboxProvenance: next.sandboxProvenance }),
    ).toEqual(isolation);
    expect(
      preserveCreationStamp({ sandboxProvenance: { actor: requester } }, source).sandboxProvenance,
    ).toEqual(sandboxProvenance);
  }
});

it("gates only new delegated attribution, retaining each entry point's legacy creator", () => {
  const fallback = { type: "agent", id: "main" } as const;
  const other = { type: "human", source: "profile", id: "other" } as const;
  for (const legacyActor of [undefined, fallback, creator]) {
    for (const createdVia of ["operator", "spawn", "cron", "talk"] as const) {
      const source = { createdVia, createdActor: creator };
      for (const enabled of [false, true, false]) {
        const select = (requesterProfileId?: string) =>
          resolveDelegatedSessionCreator({
            enabled,
            source,
            fallback,
            legacyActor,
            requesterProfileId,
          });
        expect(select(other.id)).toEqual(enabled ? other : legacyActor);
        expect(select()).toEqual(
          enabled ? (createdVia === "operator" ? fallback : creator) : legacyActor,
        );
        expect(source.createdActor).toEqual(creator);
      }
    }
  }
});
