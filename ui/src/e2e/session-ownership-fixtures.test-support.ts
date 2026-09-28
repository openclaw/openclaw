export function sessionsList(owners: [string, string], withAvatars = false) {
  const ada = {
    type: "human" as const,
    id: owners[0],
    identity: { type: "profile" as const, id: owners[0] },
    label: "Ada",
  };
  const bob = {
    type: "human" as const,
    id: owners[1],
    identity: { type: "profile" as const, id: owners[1] },
    label: owners[1] === owners[0] ? "Ada" : "Bob",
  };
  const ownerFacet = owners[1] === owners[0] ? [ada] : [ada, bob];
  return {
    count: 2,
    owners: ownerFacet.map((actor) =>
      withAvatars
        ? Object.assign({}, actor, { avatarUrl: `/api/users/${actor.id}/avatar?v=1` })
        : actor,
    ),
    defaults: { contextTokens: null, model: null, modelProvider: null },
    path: "",
    sessions: [
      {
        key: "agent:main:ada",
        kind: "direct",
        label: "Ada research",
        category: "Research",
        createdActor: ada,
        owner: { actor: ada },
        updatedAt: 2,
      },
      {
        key: "agent:main:bob",
        kind: "direct",
        label: "Bob operations",
        category: "Operations",
        createdActor: bob,
        owner: { actor: bob },
        updatedAt: 1,
      },
    ],
    ts: 1,
  };
}

export function draftSessionsList() {
  const result = sessionsList(["profile-ada", "profile-bob"]);
  for (const session of result.sessions) {
    Object.assign(session, { visibility: "draft", sharingRole: "admin" });
  }
  return result;
}

export function collaborativeSessionsList() {
  const ada = {
    type: "human" as const,
    id: "profile-ada",
    identity: { type: "profile" as const, id: "profile-ada" },
    label: "Ada",
    avatarUrl: "/api/users/profile-ada/avatar?v=1",
  };
  const bob = {
    type: "human" as const,
    id: "profile-bob",
    identity: { type: "profile" as const, id: "profile-bob" },
    label: "Bob",
    avatarUrl: "/api/users/profile-bob/avatar?v=1",
  };
  const carol = { type: "human" as const, id: "profile-carol", label: "Carol" };
  return {
    count: 3,
    owners: [ada, bob, carol],
    defaults: { contextTokens: null, model: null, modelProvider: null },
    path: "",
    sessions: [
      {
        key: "agent:main:collaboration",
        kind: "direct",
        label: "Fix issue #127689",
        createdActor: ada,
        owner: { actor: ada },
        participants: [{ identity: bob.identity, label: bob.label, avatarUrl: bob.avatarUrl }],
        participantCount: 1,
        updatedAt: 3,
      },
      {
        key: "agent:main:release-planning",
        kind: "direct",
        label: "Release planning",
        createdActor: bob,
        owner: { actor: bob },
        participants: [
          { identity: ada.identity, label: ada.label, avatarUrl: ada.avatarUrl },
          { identity: { type: "agent" as const, id: "research" }, label: "Research" },
        ],
        participantCount: 2,
        updatedAt: 2,
      },
      {
        key: "agent:main:single-owner",
        kind: "direct",
        label: "Single-owner baseline",
        createdActor: carol,
        owner: { actor: carol },
        updatedAt: 1,
      },
    ],
    ts: 1,
  };
}
