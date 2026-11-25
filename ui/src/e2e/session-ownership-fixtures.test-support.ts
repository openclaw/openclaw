export function sessionPerson(id: string, label: string, withAvatar = false) {
  return {
    type: "human" as const,
    id,
    identity: { type: "profile" as const, id },
    label,
    ...(withAvatar ? { avatarUrl: `/api/users/${id}/avatar?v=1` } : {}),
  };
}

export function ownerRoster<T, Actor>(sessions: T[], owners: Actor[]) {
  return {
    count: sessions.length,
    owners,
    defaults: { contextTokens: null, model: null, modelProvider: null },
    path: "",
    sessions,
    ts: 1,
  };
}

export function sessionsList(
  owners: [string, string] = ["profile-ada", "profile-bob"],
  withAvatars = false,
  { categories = true, actorAvatars = false } = {},
) {
  const ada = sessionPerson(owners[0], "Ada", actorAvatars);
  const bob = sessionPerson(owners[1], owners[1] === owners[0] ? "Ada" : "Bob", actorAvatars);
  const ownerFacet = owners[1] === owners[0] ? [ada] : [ada, bob];
  return ownerRoster(
    [ada, bob].map((actor, index) =>
      Object.assign(
        {
          key: `agent:main:${index === 0 ? "ada" : "bob"}`,
          kind: "direct",
          label: index === 0 ? "Ada research" : "Bob operations",
          createdActor: actor,
          owner: { actor },
          updatedAt: 2 - index,
        },
        categories ? { category: index === 0 ? "Research" : "Operations" } : {},
      ),
    ),
    ownerFacet.map((actor) => sessionPerson(actor.id, actor.label, withAvatars)),
  );
}
