import { afterEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  buildSessionCreationStamp,
  inheritSessionCreationPolicy,
} from "../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayClient } from "./server-methods/types.js";
import { createSessionListEntryFilter } from "./session-sharing.js";

const getUserProfileDisplay = vi.hoisted(() =>
  vi.fn((profileId: string) => {
    const displayNames: Record<string, string> = {
      "profile-ada": "Ada",
      "profile-bob": "Bob",
      "profile-carol": "Bob",
      "profile-dana": "Bob",
      "profile-erin": "Bob",
      "profile:channel:opaque": "Channel Keeper",
      "shared-id": "Shared",
    };
    const displayName = displayNames[profileId];
    if (!displayName) {
      throw new Error(`unknown profile: ${profileId}`);
    }
    return {
      id: profileId,
      displayName,
      avatarRevision: profileId === "profile-ada" ? "ada-hash-png" : "42",
      hasAvatar: profileId === "profile-ada",
    };
  }),
);

vi.mock("../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profile-list.js")>()),
  getResidentUserProfileDisplay: getUserProfileDisplay,
}));

import { listSessionFixture } from "./session-list.test-support.js";

const profileActor = (id: string) => ({ type: "human", source: "profile", id }) as const;
type EntryFields = Partial<SessionEntry>;
const session = (sessionId: string, updatedAt: number, fields: EntryFields = {}): SessionEntry => ({
  sessionId,
  updatedAt,
  ...fields,
});
const ownedSession = (id: string, time: number, profile: string, fields: EntryFields = {}) =>
  session(id, time, {
    createdActor: profileActor(profile),
    createdVia: "operator",
    ...fields,
  });
const ownerFacet = (id: string, label: string, type: "human" | "agent" = "human") => ({
  type,
  id,
  identity: { type: type === "human" ? "profile" : "agent", id },
  label,
});
const adaOwner = {
  ...ownerFacet("profile-ada", "Ada"),
  avatarUrl: "/api/users/profile-ada/avatar?v=ada-hash-png",
};
const bobOwner = ownerFacet("profile-bob", "Bob");
type ListResult = Awaited<ReturnType<typeof listSessionFixture>>;
const keys = (result: ListResult) => result.sessions.map((row) => row.key);
const findRow = (result: ListResult, suffix: string) =>
  result.sessions.find((row) => row.key.endsWith(suffix));
const actorIdentity = (actor: ListResult["sessions"][number]["createdActor"]) =>
  actor && { type: actor.type, id: actor.id };
const profileParticipant = (id: string) => ({ identity: { type: "profile", id } }) as const;
const researchParticipant = () => ({ identity: { type: "agent", id: "research" } }) as const;
const otherProfiles = ["profile-carol", "profile-dana", "profile-erin"];
const entryFilterFor = (profileId: string) =>
  createSessionListEntryFilter({
    client: {
      connect: { scopes: ["operator.read"] },
      authenticatedUserProfile: { profileId },
    } as GatewayClient,
  });
type ListQuery = Parameters<typeof listSessionFixture>[0];
const queryFor = (storePath: string, store: ListQuery["store"], cfg: ListQuery["cfg"] = {}) => ({
  cfg,
  storePath,
  store,
  opts: { archived: "all" as const },
});
const researchConfig = {
  agents: { entries: { main: {}, research: { identity: { name: "Research" } } } },
};
function useMergedProfiles(displayName: (id: string) => string) {
  getUserProfileDisplay.mockImplementation((id) => ({
    id: id === "former" ? "current" : id,
    displayName: displayName(id),
    hasAvatar: false,
    avatarRevision: "1",
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
  getUserProfileDisplay.mockClear();
});

it.each([true, false])(
  "filters subagent sessions before pagination and people facets when excludeSubagents is %s",
  async (excludeSubagents) => {
    const store: Record<string, SessionEntry> = {
      "agent:main:dashboard:grouped": session("grouped-conversation", 7, {
        spawnedBy: "agent:main:discussion",
        category: "Research",
        createdActor: profileActor("profile-ada"),
      }),
      "agent:main:subagent:recent": session("subagent-recent", 6, {
        category: "Research",
        createdActor: profileActor("profile-bob"),
      }),
      "Subagent:legacy": session("subagent-legacy", 5, {
        createdActor: profileActor("profile-bob"),
      }),
      "agent:main:legacy-child": session("legacy-child", 4, {
        spawnedBy: "agent:main:discussion",
        createdActor: profileActor("profile-bob"),
      }),
      "agent:main:discussion": session("discussion", 3, {
        label: "Subagent design discussion",
        createdActor: profileActor("profile-ada"),
      }),
      "agent:main:fork": session("fork", 2, {
        parentSessionKey: "agent:main:discussion",
        createdActor: profileActor("profile-ada"),
      }),
      "agent:main:older": session("older", 1, { createdActor: profileActor("profile-ada") }),
    };
    const result = await listSessionFixture({
      cfg: { agents: { entries: { main: {} } } },
      storePath: "/tmp/openclaw-session-activity-subagents",
      store,
      opts: { excludeSubagents, includePeople: true, limit: 2 },
    });

    expect(keys(result)).toEqual(
      excludeSubagents
        ? ["agent:main:dashboard:grouped", "agent:main:discussion"]
        : ["agent:main:dashboard:grouped", "agent:main:subagent:recent"],
    );
    expect(result).toMatchObject({
      totalCount: excludeSubagents ? 4 : 7,
      peopleSessionCount: excludeSubagents ? 4 : 7,
      nextOffset: 2,
      hasMore: true,
    });
    expect(result.people?.map((person) => [person.identity.id, person.sessionCount])).toEqual(
      excludeSubagents
        ? [["profile-ada", 4]]
        : [
            ["profile-ada", 4],
            ["profile-bob", 3],
          ],
    );
    expect(result.owners?.map((owner) => owner.id)).toEqual(
      excludeSubagents ? ["profile-ada"] : ["profile-ada", "profile-bob"],
    );
  },
);

it("lets configured agents win id-only owner facet collisions", async () => {
  for (const actorOrder of [
    ["human", "agent"],
    ["agent", "human"],
  ] as const) {
    const store = Object.fromEntries(
      actorOrder.map((type, index) => [
        `agent:main:${index}`,
        {
          createdActor:
            type === "human"
              ? { type, source: "profile", id: "shared-id" }
              : { type, id: "shared-id" },
          createdVia: "operator",
          sessionId: `session-${index}`,
          updatedAt: 2 - index,
        } satisfies SessionEntry,
      ]),
    );
    const result = await listSessionFixture({
      cfg: {
        agents: { entries: { "shared-id": { identity: { name: "Shared agent" } } } },
      } as OpenClawConfig,
      storePath: "/tmp/openclaw-session-owner-order",
      store,
      opts: { archived: "all" },
    });

    expect(result.owners).toEqual([ownerFacet("shared-id", "Shared agent", "agent")]);
  }
});

it("projects only durable profiles and configured agents as effective owners", async () => {
  const cases: [NonNullable<SessionEntry["createdActor"]>, string?, SessionEntry["owner"]?][] = [
    [profileActor("profile-ada"), "profile-ada"],
    [profileActor("profile:channel:opaque"), "profile:channel:opaque"],
    [{ type: "agent", id: "research" }, "research"],
    [{ type: "human", source: "channel", id: "discord:channel:123" }],
    [{ type: "agent", id: "agent:roboclaw:discord:channel:456" }],
    [{ type: "system", id: "system-import" }],
    [profileActor("profile-ada"), undefined, { actor: { type: "human", id: "slack:channel:789" } }],
  ];
  const store = Object.fromEntries(
    cases.map(([createdActor, , owner], index) => [
      `agent:main:owner-${index}`,
      session(`session-owner-${index}`, cases.length - index, {
        createdActor,
        createdVia: "operator",
        owner,
      }),
    ]),
  );
  const result = await listSessionFixture(
    queryFor("/tmp/openclaw-session-owner-candidates", store, researchConfig),
  );

  expect(result.owners).toEqual([
    adaOwner,
    ownerFacet("profile:channel:opaque", "Channel Keeper"),
    ownerFacet("research", "Research", "agent"),
  ]);
  expect(
    result.sessions.map((row) => [
      actorIdentity(row.createdActor),
      actorIdentity(row.owner?.actor),
    ]),
  ).toEqual(
    cases.map(([actor, ownerId]) => [
      { type: actor.type, id: actor.id },
      ownerId ? { type: actor.type, id: ownerId } : undefined,
    ]),
  );
});

it("filters immutable creator and effective owner separately while preserving projections", async () => {
  const store = {
    "agent:main:default-owner": ownedSession("session-default-owner", 2, "profile-ada"),
    "agent:main:assigned-owner": ownedSession("session-assigned-owner", 1, "profile-ada", {
      owner: {
        actor: { type: "human", id: "profile-bob" },
        assignedBy: { type: "human", id: "profile-ada" },
        assignedAt: 10,
      },
    }),
    "agent:main:other-creator": ownedSession("session-other-creator", 0, "profile-bob", {
      owner: { actor: { type: "human", id: "profile-ada" } },
    }),
  } satisfies Record<string, SessionEntry>;
  const query = queryFor("/tmp/openclaw-session-owners", store);
  const result = await listSessionFixture(query);
  const ada = { id: "profile-ada", label: "Ada" };
  const assigned = { createdActor: ada, owner: { actor: { id: "profile-bob", label: "Bob" } } };

  expect(findRow(result, ":default-owner")).toMatchObject({
    createdActor: ada,
    owner: { actor: ada },
  });
  expect(findRow(result, ":assigned-owner")).toMatchObject({
    ...assigned,
    owner: {
      ...assigned.owner,
      assignedBy: ada,
      assignedAt: 10,
    },
  });
  expect(result.owners).toEqual([adaOwner, bobOwner]);
  const creatorFiltered = await listSessionFixture({
    ...query,
    opts: { archived: "all", creatorId: "profile-ada" },
  });
  expect(keys(creatorFiltered)).toEqual(["agent:main:default-owner", "agent:main:assigned-owner"]);
  const ownerFiltered = await listSessionFixture({
    ...query,
    opts: { archived: "all", ownerId: "profile-bob" },
  });
  expect(keys(ownerFiltered)).toEqual(["agent:main:assigned-owner"]);

  const entryFilter = entryFilterFor("profile-ada");
  const actors = [
    { type: "human", source: "profile" },
    { type: "human", source: "channel" },
    { type: "agent" },
  ] as const;
  for (const actor of actors) {
    const rows: Record<string, SessionEntry> = {
      "agent:main:shared": session("shared", 2, {
        createdVia: "cron",
        createdActor: { ...actor, id: "profile-ada" },
      }),
      "agent:main:draft": session("draft", 1, {
        createdVia: "cron",
        createdActor: { ...actor, id: "profile-ada" },
        visibility: "draft",
      }),
      "agent:main:other-creator": store["agent:main:other-creator"],
    };
    const actorQuery = {
      ...query,
      store: rows,
      opts: { creatorId: "profile-ada" },
    };
    expect
      .soft(keys(await listSessionFixture(actorQuery)))
      .toEqual(["agent:main:shared", "agent:main:draft"]);
    const authorized = await listSessionFixture({ ...actorQuery, entryFilter });
    expect
      .soft(keys(authorized))
      .toEqual(
        actor.type === "human" && actor.source === "profile"
          ? ["agent:main:shared", "agent:main:draft"]
          : ["agent:main:shared"],
      );
  }
});

it("deduplicates participants in order, excludes the owner, and filters sessions involving the viewer", async () => {
  const store: Record<string, SessionEntry> = {
    "agent:main:owned": ownedSession("session-owned", 3, "profile-ada", {
      participants: [profileParticipant("profile-bob")],
      participantCount: 1,
    }),
    "agent:main:participating": ownedSession("session-participating", 2, "profile-bob", {
      participants: [
        profileParticipant("profile-bob"),
        researchParticipant(),
        ...[...otherProfiles, "profile-ada"].map(profileParticipant),
        researchParticipant(),
      ],
      participantCount: 7,
    }),
    "agent:main:channel-collision": ownedSession("session-channel-collision", 1, "profile-bob", {
      participants: [
        {
          identity: {
            type: "observation",
            id: "profile-ada",
            pluginId: "discord",
            accountId: null,
            senderKind: "unknown",
          },
        },
      ],
      participantCount: 1,
    }),
    "agent:main:legacy-collision": ownedSession("session-legacy-collision", 1, "profile-bob", {
      participants: [
        { identity: { type: "legacy", id: "profile-ada", actorType: "human", source: null } },
      ],
      participantCount: 1,
    }),
    "agent:main:unrelated": ownedSession("session-unrelated", 1, "profile-bob"),
  };
  const query = queryFor("/tmp/openclaw-session-participants", store, {
    agents: { entries: { research: researchConfig.agents.entries.research } },
  });
  const result = await listSessionFixture({
    ...query,
    involvingActorId: "profile-ada",
  });

  expect(keys(result)).toEqual(["agent:main:owned", "agent:main:participating"]);
  const visibleParticipants = [
    { ...researchParticipant(), label: "Research" },
    ...otherProfiles.map((id) => ({ identity: { type: "profile", id }, label: "Bob" })),
  ];
  expect(result.sessions[1]).toMatchObject({
    participants: visibleParticipants,
    expandedParticipants: [
      ...visibleParticipants,
      { ...profileParticipant("profile-ada"), label: "Ada" },
    ],
    participantCount: 5,
  });

  const unfiltered = await listSessionFixture(query);
  expect(findRow(unfiltered, ":channel-collision")).toMatchObject({
    participants: [{ identity: { type: "observation", id: "profile-ada" } }],
  });
  expect(findRow(unfiltered, ":legacy-collision")).toMatchObject({
    participants: [{ identity: { type: "legacy", id: "profile-ada" } }],
  });
  for (const suffix of [":legacy-collision", ":channel-collision"]) {
    const participant = findRow(unfiltered, suffix)?.participants?.[0];
    expect(participant).not.toHaveProperty("label");
    expect(participant).not.toHaveProperty("avatarUrl");
  }
  const selected = await listSessionFixture({
    ...query,
    opts: { archived: "all", includePeople: true, involvingProfileId: "profile-ada", limit: 1 },
  });
  expect(selected.totalCount).toBe(2);
  expect(
    selected.people?.find((person) => person.identity.id === "profile-ada")?.sessionCount,
  ).toBe(2);
  expect(selected.people?.some((person) => person.identity.id === "research")).toBe(false);
});

it("associates a required spawn creator without inventing profile contributions or promoting unqualified creators", async () => {
  useMergedProfiles(() => "Current");
  const childKey = "agent:main:delegated";
  const child: SessionEntry = {
    ...buildSessionCreationStamp({
      via: "spawn",
      ...inheritSessionCreationPolicy(
        { createdActor: { type: "human", source: "profile", id: "former" }, sandbox: "required" },
        { type: "agent", id: "research" },
      ),
      now: 1,
    }),
    sessionId: "delegated",
    updatedAt: 0,
    participants: [{ identity: { type: "agent", id: "research" } }],
    participantCount: 1,
  };
  const store: Record<string, SessionEntry> = {
    "agent:main:historical": session("historical", 1, {
      participants: ["former", "current"].map(profileParticipant),
    }),
    [childKey]: child,
  };
  // Spawn and sandbox metadata cannot qualify an unverified creator as a profile.
  store["agent:main:unqualified"] = session("unqualified", 2, {
    createdVia: "spawn",
    sandbox: "required",
    createdActor: { type: "human", source: "unknown", id: "current" },
  });
  const query = {
    ...queryFor("/tmp/openclaw-session-profile-alias", store, {
      agents: { entries: { main: {}, research: {} } },
    }),
    opts: { archived: "all" as const, includePeople: true },
  };
  const all = await listSessionFixture(query);
  const creator = {
    type: "human",
    id: "former",
    identity: { type: "profile", id: "current" },
    label: "Current",
  };
  expect(all.sessions.find((row) => row.key === childKey)).toMatchObject({
    createdActor: creator,
    owner: { actor: creator },
    participants: [researchParticipant()],
    participantCount: 1,
  });
  expect(all.owners).toEqual([creator]);
  const unqualified = findRow(all, ":unqualified");
  expect(unqualified?.createdActor).toEqual({
    type: "human",
    id: "current",
    identity: { type: "legacy", actorType: "human", source: null, id: "current" },
  });
  expect(unqualified?.owner).toBeUndefined();
  const involving = await listSessionFixture({ ...query, involvingActorId: "current" });
  expect(keys(involving)).toEqual(["agent:main:historical", childKey]);
  const current = { ...profileParticipant("current"), label: "Current" };
  expect(involving.sessions[0]?.participants).toEqual([current]);
  expect(involving.people).toEqual([{ ...current, sessionCount: 2 }]);
  const ownerFirst = await listSessionFixture({
    ...query,
    opts: { archived: "all", limit: 1 },
    ownerFirstActorId: "current",
  });
  expect(ownerFirst.sessions[0]?.key).toBe(childKey);

  // Reassignment must not erase the creator's Activity association or fabricate their input.
  child.owner = { actor: { type: "agent", id: "main" } };
  const associated = await listSessionFixture({
    ...query,
    opts: { ...query.opts, involvingProfileId: "former" },
  });
  expect(keys(associated)).toEqual(["agent:main:historical", childKey]);
  expect(associated.involvingProfileId).toBe("current");
  expect(associated.sessions[1]?.participants).toEqual([researchParticipant()]);
  expect(child.createdActor).toEqual({ type: "human", source: "profile", id: "former" });
  expect(child.participants).toEqual([researchParticipant()]);
});

it("keeps the canonical selected person visible beyond the people facet limit", async () => {
  useMergedProfiles((id) => id);
  const store: Record<string, SessionEntry> = Object.fromEntries(
    Array.from({ length: 65 }, (_, i) => [
      `agent:main:other-${i}`,
      session(`other-${i}`, 100 + i, { participants: [profileParticipant(`person-${i}`)] }),
    ]),
  );
  store["agent:main:owned"] = session("owned", 1, {
    owner: { actor: { type: "human", id: "former" } },
  });
  const query = {
    ...queryFor("/tmp/openclaw-session-selected-person", store),
    opts: { archived: "all" as const, includePeople: true, involvingProfileId: "former", limit: 1 },
  };
  const result = await listSessionFixture(query);
  expect(result).toMatchObject({
    involvingProfileId: "current",
    totalCount: 1,
    peopleIncomplete: true,
  });
  expect(result.people?.some((person) => person.identity.id === "current")).toBe(true);
});

it("reports the authoritative admission bound even when the visible participant list is smaller", async () => {
  const result = await listSessionFixture({
    cfg: {},
    storePath: "/tmp/openclaw-session-bound",
    store: {
      "agent:main:capped": {
        sessionId: "capped",
        updatedAt: 1,
        participantCount: 32,
        participants: Array.from({ length: 31 }, (_, i) => ({
          identity: {
            type: "remote",
            pluginId: "test",
            domain: "workspace",
            idKind: "user",
            id: String(i),
          },
        })),
      },
    },
    opts: { includePeople: true },
  });
  expect(result.people).toEqual([]);
  expect(result.peopleIncomplete).toBe(true);
});
