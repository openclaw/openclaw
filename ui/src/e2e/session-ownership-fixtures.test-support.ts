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
