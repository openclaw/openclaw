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
const session = (
  sessionId: string,
  updatedAt: number,
  fields: Partial<SessionEntry> = {},
): SessionEntry => ({
  sessionId,
  updatedAt,
  ...fields,
});
const ownedSession = (
  sessionId: string,
  updatedAt: number,
  profileId: string,
  fields: Partial<SessionEntry> = {},
) =>
  session(sessionId, updatedAt, {
    createdActor: profileActor(profileId),
    createdVia: "operator",
    ...fields,
  });
const ownerFacet = (
  id: string,
  label: string,
  type: "human" | "agent" = "human",
  avatarUrl?: string,
) => ({
  type,
  id,
  identity: { type: type === "human" ? "profile" : "agent", id },
  label,
  ...(avatarUrl ? { avatarUrl } : {}),
});
const adaOwner = ownerFacet(
  "profile-ada",
  "Ada",
  "human",
  "/api/users/profile-ada/avatar?v=ada-hash-png",
);
const bobOwner = ownerFacet("profile-bob", "Bob");

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

    expect(result.sessions.map((row) => row.key)).toEqual(
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
  const actorOrders = [
    ["human", "agent"],
    ["agent", "human"],
  ] as const;
  for (const actorOrder of actorOrders) {
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
  const result = await listSessionFixture({
    cfg: {
      agents: {
        entries: {
          main: {},
          research: { identity: { name: "Research" } },
        },
      },
    } as OpenClawConfig,
    storePath: "/tmp/openclaw-session-owner-candidates",
    store,
    opts: { archived: "all" },
  });

  expect(result.owners).toEqual([
    adaOwner,
    ownerFacet("profile:channel:opaque", "Channel Keeper"),
    ownerFacet("research", "Research", "agent"),
  ]);
  expect(
    result.sessions.map((row) => ({
      key: row.key,
      createdActor: row.createdActor && {
        type: row.createdActor.type,
        id: row.createdActor.id,
      },
      owner: row.owner && {
        type: row.owner.actor.type,
        id: row.owner.actor.id,
      },
    })),
  ).toEqual(
    cases.map(([createdActor, ownerId], index) => ({
      key: `agent:main:owner-${index}`,
      createdActor: { type: createdActor.type, id: createdActor.id },
      owner: ownerId ? { type: createdActor.type, id: ownerId } : undefined,
    })),
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
  const query = {
    cfg: {} as OpenClawConfig,
    storePath: "/tmp/openclaw-session-owners",
    store,
    opts: { archived: "all" as const },
  };
  const result = await listSessionFixture(query);
  const ada = { id: "profile-ada", label: "Ada" };
  const assigned = { createdActor: ada, owner: { actor: { id: "profile-bob", label: "Bob" } } };

  expect(result.sessions.find((row) => row.key.endsWith(":default-owner"))).toMatchObject({
    createdActor: ada,
    owner: { actor: ada },
  });
  expect(result.sessions.find((row) => row.key.endsWith(":assigned-owner"))).toMatchObject({
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
  expect(creatorFiltered.sessions.map((row) => row.key)).toEqual([
    "agent:main:default-owner",
    "agent:main:assigned-owner",
  ]);
  expect(creatorFiltered.sessions.find((row) => row.key.endsWith(":assigned-owner"))).toMatchObject(
    assigned,
  );
  const ownerFiltered = await listSessionFixture({
    ...query,
    opts: { archived: "all", ownerId: "profile-bob" },
  });
  expect(ownerFiltered.sessions.map((row) => row.key)).toEqual(["agent:main:assigned-owner"]);
  expect(ownerFiltered.sessions[0]).toMatchObject(assigned);

  const viewer = {
    connect: { scopes: ["operator.read"] },
    authenticatedUserProfile: { profileId: "profile-ada" },
  } as GatewayClient;
  const entryFilter = createSessionListEntryFilter({ client: viewer });
  const actors = [
    { type: "human", source: "profile" },
    { type: "human", source: "channel" },
    { type: "human", source: "unknown" },
    { type: "agent" },
    { type: "system" },
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
      .soft((await listSessionFixture(actorQuery)).sessions.map((row) => row.key))
      .toEqual(["agent:main:shared", "agent:main:draft"]);
    const authorized = await listSessionFixture({ ...actorQuery, entryFilter });
    expect
      .soft(authorized.sessions.map((row) => row.key))
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
      participants: [{ identity: { type: "profile", id: "profile-bob" } }],
      participantCount: 1,
    }),
    "agent:main:participating": ownedSession("session-participating", 2, "profile-bob", {
      participants: [
        { identity: { type: "profile", id: "profile-bob" } },
        { identity: { type: "agent", id: "research" } },
        { identity: { type: "profile", id: "profile-carol" } },
        { identity: { type: "profile", id: "profile-dana" } },
        { identity: { type: "profile", id: "profile-erin" } },
        { identity: { type: "profile", id: "profile-ada" } },
        { identity: { type: "agent", id: "research" } },
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
  const cfg: OpenClawConfig = {
    agents: { entries: { research: { identity: { name: "Research" } } } },
  };
  const query = {
    cfg,
    storePath: "/tmp/openclaw-session-participants",
    store,
    opts: { archived: "all" as const },
  };
  const result = await listSessionFixture({
    ...query,
    involvingActorId: "profile-ada",
  });

  expect(result.sessions.map((row) => row.key)).toEqual([
    "agent:main:owned",
    "agent:main:participating",
  ]);
  const visibleParticipants = [
    { identity: { type: "agent", id: "research" }, label: "Research" },
    { identity: { type: "profile", id: "profile-carol" }, label: "Bob" },
    { identity: { type: "profile", id: "profile-dana" }, label: "Bob" },
    { identity: { type: "profile", id: "profile-erin" }, label: "Bob" },
  ];
  expect(result.sessions[1]).toMatchObject({
    participants: visibleParticipants,
    expandedParticipants: [
      ...visibleParticipants,
      { identity: { type: "profile", id: "profile-ada" }, label: "Ada" },
    ],
    participantCount: 5,
  });

  const unfiltered = await listSessionFixture(query);
  expect(unfiltered.sessions.find((row) => row.key.endsWith(":channel-collision"))).toMatchObject({
    participants: [{ identity: { type: "observation", id: "profile-ada" } }],
  });
  expect(unfiltered.sessions.find((row) => row.key.endsWith(":legacy-collision"))).toMatchObject({
    participants: [{ identity: { type: "legacy", id: "profile-ada" } }],
  });
  for (const suffix of [":legacy-collision", ":channel-collision"]) {
    const participant = unfiltered.sessions.find((row) => row.key.endsWith(suffix))
      ?.participants?.[0];
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

it.each(["spawn"] as const)(
  "associates a required %s creator without inventing profile contributions or promoting unqualified creators",
  async (via) => {
    getUserProfileDisplay.mockImplementation((id) => ({
      id: id === "former" ? "current" : id,
      displayName: "Current",
      hasAvatar: false,
      avatarRevision: "1",
    }));
    const childKey = "agent:main:delegated";
    const child: SessionEntry = {
      ...buildSessionCreationStamp({
        via,
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
      "agent:main:historical": {
        sessionId: "historical",
        updatedAt: 1,
        participants: [
          { identity: { type: "profile", id: "former" } },
          { identity: { type: "profile", id: "current" } },
        ],
      },
      [childKey]: child,
    };
    const unqualified = [
      ["channel", undefined],
      ["channel", "required"],
      ["spawn", undefined],
      ["talk", undefined],
      ["cron", undefined],
      ["plugin", "required"],
      ["internal", "required"],
      [undefined, "required"],
    ] as const;
    for (const [index, [createdVia, sandbox]] of unqualified.entries()) {
      store[`agent:main:unqualified-${index}`] = {
        sessionId: `unqualified-${index}`,
        updatedAt: 2,
        createdVia,
        sandbox,
        createdActor: { type: "human", source: "unknown", id: "current" },
      };
    }
    const query = {
      cfg: { agents: { entries: { main: {}, research: {} } } },
      storePath: "/tmp/openclaw-session-profile-alias",
      store,
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
      participants: [{ identity: { type: "agent", id: "research" } }],
      participantCount: 1,
    });
    expect(all.owners).toEqual([creator]);
    for (const row of all.sessions.filter((candidate) => candidate.key.includes(":unqualified-"))) {
      expect(row.createdActor).toEqual({
        type: "human",
        id: "current",
        identity: { type: "legacy", actorType: "human", source: null, id: "current" },
      });
      expect(row.owner).toBeUndefined();
    }
    const involving = await listSessionFixture({ ...query, involvingActorId: "current" });
    expect(involving.sessions.map((row) => row.key)).toEqual(["agent:main:historical", childKey]);
    expect(involving.sessions[0]?.participants).toEqual([
      { identity: { type: "profile", id: "current" }, label: "Current" },
    ]);
    expect(involving.people).toEqual([
      { identity: { type: "profile", id: "current" }, label: "Current", sessionCount: 2 },
    ]);
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
    expect(associated.sessions.map((row) => row.key)).toEqual(["agent:main:historical", childKey]);
    expect(associated.involvingProfileId).toBe("current");
    expect(associated.sessions[1]?.participants).toEqual([
      { identity: { type: "agent", id: "research" } },
    ]);
    expect(child.createdActor).toEqual({ type: "human", source: "profile", id: "former" });
    expect(child.participants).toEqual([{ identity: { type: "agent", id: "research" } }]);
  },
);

it("returns a canonical selected person and orders merged owners without borrowing remote identities", async () => {
  getUserProfileDisplay.mockImplementation((id) => ({
    id: id === "former" ? "current" : id,
    displayName: id,
    hasAvatar: false,
    avatarRevision: "1",
  }));
  const store: Record<string, SessionEntry> = Object.fromEntries(
    Array.from({ length: 65 }, (_, i) => [
      `agent:main:other-${i}`,
      {
        sessionId: `other-${i}`,
        updatedAt: 100 + i,
        participants: [{ identity: { type: "profile", id: `person-${i}` } }],
      },
    ]),
  );
  store["agent:main:owned"] = {
    sessionId: "owned",
    updatedAt: 1,
    owner: { actor: { type: "human", id: "former" } },
  };
  const query = {
    cfg: {},
    storePath: "/tmp/openclaw-session-selected-person",
    store,
    opts: { archived: "all" as const, includePeople: true, involvingProfileId: "former", limit: 1 },
  };
  const result = await listSessionFixture(query);
  expect(result).toMatchObject({
    involvingProfileId: "current",
    totalCount: 1,
    peopleIncomplete: true,
  });
  expect(result.people?.some((person) => person.identity.id === "current")).toBe(true);
  const ordered = await listSessionFixture({
    ...query,
    opts: { archived: "all", limit: 1 },
    ownerFirstActorId: "current",
  });
  expect(ordered.sessions[0]?.key).toBe("agent:main:owned");
  const involved = await listSessionFixture({
    ...query,
    opts: { archived: "all" },
    involvingActorId: "current",
  });
  expect(involved.sessions.map((row) => row.key)).toEqual(["agent:main:owned"]);
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

it("preserves list output across visibility, scope, owner, and search filters", async () => {
  const now = 1_000_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  getUserProfileDisplay.mockImplementation((profileId: string) => ({
    id: profileId,
    displayName:
      profileId === "profile-ada" ? "Ada" : profileId === "profile-bob" ? "Bob" : "Carol",
    avatarRevision: String(now),
    hasAvatar: false,
  }));
  const cfg = {
    agents: {
      entries: { main: {}, work: {} },
    },
  } as OpenClawConfig;
  const store: Record<string, SessionEntry> = {
    global: ownedSession("session-global", now - 1, "profile-bob", {
      subject: "needle global",
    }),
    unknown: session("session-unknown", now - 2, {
      createdActor: { type: "system", id: "system-import" },
      subject: "needle unknown",
    }),
    "agent:main:shared": ownedSession("session-main-shared", now - 3, "profile-ada", {
      boardFace: "chat",
      label: "focus",
      lastInteractionAt: now - 5,
      subject: "needle main",
      visibility: "shared",
    }),
    "agent:main:draft": ownedSession("session-main-draft", now - 4, "profile-ada", {
      subject: "needle hidden draft",
      visibility: "draft",
    }),
    "agent:work:shared": ownedSession("session-work-shared", now - 5, "profile-bob", {
      subject: "needle work",
      visibility: "shared",
    }),
    "agent:main:archived": ownedSession("session-main-archived", now - 7, "profile-bob", {
      archivedAt: now - 10,
      subject: "needle archived",
      visibility: "shared",
    }),
    "agent:main:sessions": {} as SessionEntry,
  };
  const viewer = {
    authenticatedUserId: "profile-viewer",
    authenticatedUserProfile: {
      displayName: "Viewer",
      hasAvatar: false,
      profileId: "profile-viewer",
      updatedAt: now,
    },
    connect: {
      client: {
        id: "openclaw-control-ui",
        mode: "webchat",
        platform: "test",
        version: "test",
      },
      maxProtocol: 1,
      minProtocol: 1,
      role: "operator",
      scopes: ["operator.read"],
    },
  } as GatewayClient;
  const entryFilter = createSessionListEntryFilter({ client: viewer });

  const project = async (opts: Parameters<typeof listSessionFixture>[0]["opts"]) => {
    const result = await listSessionFixture({
      cfg,
      fixtureAgentId: "main",
      ...(entryFilter ? { entryFilter } : {}),
      opts,
      store,
      storePath: "/tmp/openclaw-session-filter-parity",
    });
    return {
      count: result.count,
      owners: result.owners,
      hasMore: result.hasMore,
      keys: result.sessions.map((row) => row.key),
      nextOffset: result.nextOffset,
      totalCount: result.totalCount,
    };
  };

  // These exact projections were captured from the pre-refactor chained-filter implementation.
  const options = {
    archived: "all",
    includeGlobal: true,
    includeUnknown: true,
    search: "needle",
  } as const;
  const expected = {
    owners: [ownerFacet("profile-ada", "Ada"), bobOwner],
    hasMore: false,
  };
  const assertProjection = async (
    opts: Parameters<typeof project>[0],
    count: number,
    keys: string[],
  ) =>
    expect(JSON.stringify(await project(opts))).toBe(
      JSON.stringify({
        count,
        ...expected,
        keys,
        nextOffset: null,
        totalCount: count,
      }),
    );
  await assertProjection(options, 5, [
    "global",
    "unknown",
    "agent:main:shared",
    "agent:work:shared",
    "agent:main:archived",
  ]);
  await assertProjection({ ...options, agentId: "main", ownerId: "profile-bob" }, 2, [
    "global",
    "agent:main:archived",
  ]);
});
