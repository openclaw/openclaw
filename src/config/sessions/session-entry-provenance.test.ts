import { describe, expect, it } from "vitest";
import {
  attributeDelegatedSessionCreator,
  inheritSessionCreationPolicy,
  inheritSessionGitContributorProfileIds,
  preserveCreationStamp,
  resolveSessionCreatorActor,
  sessionCreatorProfileId,
  sessionIsolationProfileId,
  isMainGitContributorScope,
  inheritSpawnSessionOwner,
  sessionPersonalProfileId,
  type SessionActor,
  type SessionCreatedActor,
} from "./session-entry-provenance.js";

type Source = Parameters<typeof sessionPersonalProfileId>[0];
const creator: SessionCreatedActor = { type: "human", source: "profile", id: "profile-creator" };
const human = (id?: string, label?: string): SessionActor => ({ type: "human", id, label });
const spawningAgent: SessionCreatedActor = { type: "agent", id: "roboclaw" };
const owned = (actor: SessionActor, createdActor: SessionCreatedActor = creator): Source => ({
  owner: { actor },
  createdActor,
});
const created = (actor: SessionCreatedActor): Source => ({ createdActor: actor });
const channelCreator: SessionCreatedActor = {
  ...creator,
  source: "channel",
  label: "profile-owner",
};

it("resolves personal profiles from assigned humans or authenticated creators only", () => {
  const cases: Array<[Source, string | undefined]> = [
    [owned(human("profile-owner", "profile-other")), "profile-owner"],
    [{ createdActor: creator }, "profile-creator"],
    [owned({ type: "agent", id: "profile-not-a-human" }), "profile-creator"],
    [created(channelCreator), undefined],
    [owned(human(undefined, "profile-owner")), undefined],
    [created({ type: "human", source: "profile", label: "profile-creator" }), undefined],
    [undefined, undefined],
    [{}, undefined],
    [
      owned({ type: "agent", id: "profile-owner" }, { type: "system", id: "profile-creator" }),
      undefined,
    ],
  ];
  for (const [source, expected] of cases) {
    expect(sessionPersonalProfileId(source), JSON.stringify(source)).toBe(expected);
  }
});

it("defaults visible work to its verified requester without replacing another human's ownership", () => {
  type Resolve = Parameters<typeof inheritSpawnSessionOwner>[4];
  const cases: Array<[Source, string | undefined, SessionActor, number?, Resolve?]> = [
    [created(creator), creator.id, human(creator.id), 42],
    [owned(human("profile-owner")), "profile-owner", human("profile-owner"), 42],
    [created(creator), "profile-other", spawningAgent],
    [created(creator), undefined, spawningAgent],
    [
      owned(human("profile-before-merge")),
      "profile-after-merge",
      human("profile-after-merge"),
      42,
      (id) => (id === "profile-before-merge" ? "profile-after-merge" : id),
    ],
    [owned({ type: "agent", id: "another-agent" }), creator.id, human(creator.id)],
    [
      created({ type: "human", source: "channel", id: "channel-sender" }),
      creator.id,
      human(creator.id),
    ],
    [owned(human(undefined)), creator.id, spawningAgent],
    [created({ type: "human", source: "channel", id: "discord-user" }), undefined, spawningAgent],
  ];
  for (const [source, requester, actor, now, resolve] of cases) {
    expect(inheritSpawnSessionOwner(source, spawningAgent, requester, now, resolve)).toEqual({
      actor,
      assignedBy: spawningAgent,
      assignedAt: now ?? expect.any(Number),
    });
  }
});

const parent = {
  inheritedGitContributorProfileIds: ["prior-inherited"],
  participants: ["unrelated-a", "unrelated-b"].map((id) => ({
    identity: { type: "profile" as const, id },
    contributionCount: 1,
    firstPromptedAt: 1,
    lastPromptedAt: 1,
  })),
};

it("uses the verified request, not a multiplexed main roster, for delegation", () => {
  const source = {
    agentId: "work",
    config: { session: { mainKey: "home" } },
    sessionKey: "agent:work:home",
  };
  const inherit = (requesterProfileId?: string) =>
    inheritSessionGitContributorProfileIds(parent, { ...source, requesterProfileId });
  expect(inherit("requester-c")).toEqual(["requester-c"]);
  expect(inheritSessionGitContributorProfileIds(parent, source)).toBeUndefined();
  expect(inherit("requester-d")).toEqual(["requester-d"]);
  expect(isMainGitContributorScope({ ...source, sessionKey: "agent:other:home" })).toBe(false);
  expect(
    isMainGitContributorScope({
      agentId: "work",
      config: { session: { scope: "global" } },
      sessionKey: "global",
    }),
  ).toBe(true);
});

it("preserves authorized collaborative task and nested-delegation credit", () => {
  const source = { agentId: "work", config: {}, sessionKey: "agent:work:dashboard:task" };
  const inherited = inheritSessionGitContributorProfileIds(parent, source);
  expect(inherited).toEqual(["prior-inherited", "unrelated-a", "unrelated-b"]);
  expect(
    inheritSessionGitContributorProfileIds(
      { inheritedGitContributorProfileIds: inherited },
      { ...source, sessionKey: "agent:work:subagent:child" },
    ),
  ).toEqual(inherited);
  expect(
    inheritSessionGitContributorProfileIds({ ...parent, incognito: true }, source),
  ).toBeUndefined();
});

describe("delegated human creators", () => {
  const actor: SessionCreatedActor = { type: "human", source: "profile", id: "isolation-owner" };

  it("keeps the legacy isolation actor while projecting the captured human creator", () => {
    const attributed = attributeDelegatedSessionCreator(actor, "requester");
    expect(attributed).toEqual({
      ...actor,
      delegatedBy: { type: "human", source: "profile", id: "requester" },
    });
    expect(resolveSessionCreatorActor(attributed)).toEqual({
      type: "human",
      source: "profile",
      id: "requester",
    });
    expect(sessionCreatorProfileId(attributed)).toBe("requester");
    expect(sessionIsolationProfileId(attributed)).toBe("isolation-owner");
    expect(actor).not.toHaveProperty("delegatedBy");
  });

  it("requires a captured human, not an assignee or execution agent", () => {
    expect(attributeDelegatedSessionCreator(spawningAgent, "requester")).toEqual({
      ...spawningAgent,
      delegatedBy: { type: "human", source: "profile", id: "requester" },
    });
    expect(attributeDelegatedSessionCreator(spawningAgent)).toEqual(spawningAgent);
    expect(attributeDelegatedSessionCreator(undefined, "requester")).toBeUndefined();
  });

  it("does not rewrite stored attribution when assignment or proposed creator changes", () => {
    const attributed = attributeDelegatedSessionCreator(actor, "requester");
    const stored = {
      createdActor: attributed,
      createdVia: "spawn" as const,
      createdAt: 1,
      sandbox: "required" as const,
    };
    expect(preserveCreationStamp({ ...stored, createdActor: creator }, stored)).toEqual(stored);
    expect(inheritSessionCreationPolicy(stored, spawningAgent)).toEqual({
      actor: attributed,
      sandbox: "required",
    });
    expect(sessionPersonalProfileId({ createdActor: attributed })).toBe("requester");
    expect(
      sessionPersonalProfileId({ createdActor: attributed, owner: { actor: human("assignee") } }),
    ).toBe("assignee");
  });
});
