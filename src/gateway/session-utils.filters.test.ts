import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/schema/sessions-list.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runSynchronousWork } from "../shared/synchronous-work.js";
import {
  requestContext,
  sessionReadHandlers,
} from "./server-methods/sessions-read-cache.test-support.js";
import * as sessionIdentity from "./session-identity-projection.js";
import { filterSessionEntries } from "./session-list-filters.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { prepareSessionRowSelection } from "./session-utils-list.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";

vi.mock("../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profile-list.js")>()),
  getUserProfileDisplay: vi.fn((id: string) => ({
    id: id === "profile-merged-ada" ? "profile-ada" : id,
    displayName: id,
    hasAvatar: false,
    avatarRevision: "1",
  })),
}));

afterEach(() => vi.restoreAllMocks());

const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
const storePath = "/tmp/openclaw-session-inventory-filters";

function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "inventory-session", updatedAt: 1, ...overrides };
}

it("excludes dock conversations before ownership, people counts, and pagination", async () => {
  const store = {
    "agent:main:board-agent": entry({
      updatedAt: 3,
      createdVia: "operator",
      createdSurface: "plugin-dock",
      createdActor: { type: "human", source: "profile", id: "profile-bob" },
    }),
    "agent:main:first": entry({
      updatedAt: 2,
      createdActor: { type: "human", source: "profile", id: "profile-ada" },
    }),
    "agent:main:second": entry({
      createdActor: { type: "human", source: "profile", id: "profile-ada" },
    }),
  };
  const opts = {
    excludeDock: true,
    includePeople: true,
    includeOwnerSessionCounts: true,
    limit: 1,
  };
  const first = await listSessionFixture({ cfg, storePath, store, opts });
  expect(first.sessions.map((row) => row.key)).toEqual(["agent:main:first"]);
  expect(first).toMatchObject({
    totalCount: 2,
    peopleSessionCount: 2,
    nextOffset: 1,
    hasMore: true,
  });
  expect(first.owners?.map((owner) => owner.id)).toEqual(["profile-ada"]);
  expect(first.people?.map((person) => [person.identity.id, person.sessionCount])).toEqual([
    ["profile-ada", 2],
  ]);
  expect(first.ownerSessionCounts).toEqual([{ profileId: "profile-ada", open: 2, running: 0 }]);
  const second = await listSessionFixture({ cfg, storePath, store, opts: { ...opts, offset: 1 } });
  expect(second.sessions.map((row) => row.key)).toEqual(["agent:main:second"]);
  expect(second).toMatchObject({ totalCount: 2, nextOffset: null, hasMore: false });
  const explicit = await listSessionFixture({
    cfg,
    storePath,
    store,
    opts: { excludeDock: false },
  });
  expect(explicit.sessions[0]).toMatchObject({ key: "agent:main:board-agent", isDock: true });
});

it("reuses involvement facts until session replacement or profile publication", () => {
  const identityProjection = sessionIdentity.createSessionIdentityProjection();
  const rowContext = { ...buildSessionListRowMetadataContext({ now: 1 }), identityProjection };
  const profiles = rowContext.userProfileIdentityById;
  const key = "agent:main:involved";
  const state = { profiles: { "profile-merged-ada": { hidden: false, updatedAt: 1 } } };
  const readInvolvement = vi.fn(() => state);
  const original = entry();
  Object.defineProperty(original, "profileInvolvement", { get: readInvolvement, enumerable: true });
  const projection = createSessionRowProjectionFixture({
    cfg,
    storePath,
    store: { [key]: original },
    rowContext,
  });
  onTestFinished(() => projection.dispose());
  const select = (id = "profile-ada") =>
    runSynchronousWork(
      filterSessionEntries({
        ...prepareSessionRowSelection(projection, {}),
        involvingActorId: id,
      }),
    ).entries.map(([sessionKey]) => sessionKey);
  expect(select()).toEqual([key]);
  readInvolvement.mockClear();
  for (let i = 0; i < 3; i++) {
    expect(select()).toEqual([key]);
    expect(select("profile-bob")).toEqual([]);
  }
  expect(readInvolvement).not.toHaveBeenCalled();

  // Profile publications can move an alias without replacing session metadata.
  profiles.set("profile-merged-ada", undefined);
  identityProjection.invalidate();
  expect(select()).toEqual([]);
  expect(select("profile-merged-ada")).toEqual([key]);
  projection.setEntry(key, {
    ...entry(),
    profileInvolvement: {
      key: "inventory-session",
      profiles: {
        "profile-merged-ada": { hidden: true, updatedAt: 2 },
      },
    },
  });
  expect(select("profile-merged-ada")).toEqual([]);
});

it("expires cached child owners without a session or registry publication", () => {
  const now = Date.UTC(2026, 8, 27);
  const key = "agent:main:subagent:child";
  const parent = "agent:main:dashboard:parent";
  const projection = createSessionRowProjectionFixture({
    cfg,
    storePath,
    store: {
      [key]: entry({ updatedAt: now, spawnedBy: parent }),
    },
  });
  onTestFinished(() => projection.dispose());
  const select = (clock: number) =>
    runSynchronousWork(
      filterSessionEntries({
        ...prepareSessionRowSelection(projection, { spawnedBy: parent }, { now: clock }),
      }),
    ).entries.map(([sessionKey]) => sessionKey);
  expect(select(now)).toEqual([key]);
  expect(select(now + 3_600_000)).toEqual([key]);
  expect(select(now + 3_600_001)).toEqual([]);
  expect(select(now)).toEqual([key]);
});

it.each([
  [0, 0],
  [0, 2, 1],
])(
  "rejects non-ascending activity boundaries before reading session rows: %j",
  async (...activityPulseBoundaries) => {
    const respond = vi.fn();
    await sessionReadHandlers["sessions.list"]!({
      req: { type: "req", id: "pulse-boundaries", method: "sessions.list" },
      params: { activityPulseBoundaries },
      context: requestContext(cfg),
      client: null,
      isWebchatConnect: () => false,
      respond,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("activityPulseBoundaries: must be strictly ascending"),
      }),
    );
  },
);

it("aggregates the selected time window after person filtering and before pagination", async () => {
  const since = Date.UTC(2026, 8, 27);
  const now = since + 12 * 3_600_000;
  const activeMinutes = 7 * 24 * 60;
  vi.spyOn(Date, "now").mockReturnValue(now);
  const person = (id: string) => ({ identity: { type: "profile" as const, id } });
  const result = await listSessionFixture({
    cfg,
    storePath,
    store: {
      "agent:main:midnight": entry({
        lastActivityAt: since,
        createdAt: now - activeMinutes * 60_000 - 1,
        participants: [person("profile-ada")],
      }),
      "agent:main:morning": entry({
        lastActivityAt: since + 3_600_000,
        lastInteractionAt: since + 2 * 3_600_000,
        createdAt: since,
        participants: [person("profile-merged-ada"), person("profile-bob")],
      }),
      "agent:main:clock-skew": entry({
        lastActivityAt: since + 25 * 3_600_000,
        createdAt: since + 24 * 3_600_000,
        participants: [person("profile-ada")],
      }),
      "agent:main:three-days-ago": entry({
        lastActivityAt: since - 3 * 86_400_000,
        updatedAt: since + 30 * 3_600_000,
        createdAt: now - activeMinutes * 60_000,
        participants: [person("profile-ada"), person("profile-earlier")],
      }),
      "agent:main:outside-window": entry({
        lastActivityAt: now - activeMinutes * 60_000 - 1,
        participants: [person("profile-ada"), person("profile-excluded")],
      }),
      "agent:main:other-person": entry({
        lastActivityAt: since + 5 * 3_600_000,
        createdAt: since,
        participants: [person("profile-carol")],
      }),
    },
    opts: {
      activityPulseBoundaries: Array.from({ length: 25 }, (_, index) => since + index * 3_600_000),
      activeMinutes,
      includePeople: true,
      involvingProfileId: "profile-ada",
      sortBy: "activity",
      limit: 1,
    },
  });
  expect(result.sessions).toHaveLength(1);
  expect(result.totalCount).toBe(4);
  expect(result.activityPulse).toEqual({
    since,
    until: since + 24 * 3_600_000,
    buckets: [1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    sessions: 4,
    started: 3,
    running: 0,
    people: 3,
  });
});

it("buckets nonuniform intervals half-open while counting every filtered running session", () => {
  const projection = createSessionRowProjectionFixture({
    cfg,
    store: {
      "agent:main:before": entry({ lastActivityAt: 99 }),
      "agent:main:first": entry({ lastActivityAt: 100 }),
      "agent:main:second": entry({ lastActivityAt: 200, createdAt: 0 }),
      "agent:main:last": entry({ lastActivityAt: 499 }),
      "agent:main:after": entry({ lastActivityAt: 500 }),
    },
  });
  onTestFinished(projection.dispose);
  const result = runSynchronousWork(
    filterSessionEntries({
      ...prepareSessionRowSelection(projection, { activityPulseBoundaries: [100, 200, 500] }),
      projectActiveRun: () => ({ active: true }),
    }),
  );
  expect(result.activityPulse).toEqual({
    since: 100,
    until: 500,
    buckets: [1, 2],
    sessions: 5,
    running: 5,
  });
  const recent = runSynchronousWork(
    filterSessionEntries({
      ...prepareSessionRowSelection(
        projection,
        { activityPulseBoundaries: [100, 200, 500], activeMinutes: 1 },
        { now: 500 },
      ),
    }),
  );
  expect(recent.activityPulse?.started).toBe(1);
});

it.each([{ activityPulseBoundaries: undefined }, { activityPulseBoundaries: [0, 100] }])(
  "includes the optional pulse only for requested boundaries: $activityPulseBoundaries",
  async ({ activityPulseBoundaries }) => {
    const result = await listSessionFixture({
      cfg,
      storePath,
      store: {
        "agent:main:one": entry({
          createdAt: 0,
          participants: [{ identity: { type: "profile", id: "profile-ada" } }],
        }),
      },
      opts: { activityPulseBoundaries },
    });
    if (activityPulseBoundaries) {
      expect(result.activityPulse).toEqual({
        since: 0,
        until: 100,
        buckets: [1],
        sessions: 1,
        running: 0,
      });
    } else {
      expect(result).not.toHaveProperty("activityPulse");
    }
  },
);

it("keeps system provenance and named conversations distinct in projected lists", async () => {
  const cases: [key: string, fields: Partial<SessionEntry>, visible: boolean][] = [
    ["agent:main:system", { createdActor: { type: "system" }, label: "Named probe" }, false],
    [
      "agent:main:human",
      { createdVia: "run", createdActor: { type: "human", source: "unknown" } },
      true,
    ],
    ["agent:main:label", { createdVia: "run", label: "Operator label" }, true],
    ["agent:main:display-name", { createdVia: "internal", displayName: "Operator title" }, true],
    ["agent:main:subject", { createdVia: "run", subject: "Conversation subject" }, true],
    [
      "agent:main:whitespace",
      { createdVia: "internal", label: " ", displayName: "\t", subject: "\n" },
      false,
    ],
    ["agent:main:legacy", {}, true],
    ["agent:main:main", {}, true],
    ["agent:main:main:heartbeat", { heartbeatIsolatedBaseSessionKey: "agent:main:main" }, false],
    [
      "agent:main:ops:heartbeat",
      { heartbeatIsolatedBaseSessionKey: "agent:main:ops", label: "Named lane" },
      true,
    ],
    ["agent:main:alerts:heartbeat", { label: "My heartbeat" }, true],
    ["agent:main:cron:nightly", { createdVia: "internal", createdActor: { type: "system" } }, true],
  ];
  const store = Object.fromEntries(
    cases.map(([key, fields], index) => [
      key,
      entry({ sessionId: key, updatedAt: cases.length - index, ...fields }),
    ]),
  );
  for (const excludeSystem of [true, false, undefined]) {
    const result = await listSessionFixture({
      cfg,
      storePath,
      store,
      opts: { excludeSystem },
    });
    const expected = cases.filter((row) => excludeSystem !== true || row[2]).map(([key]) => key);
    expect(result.sessions.map((row) => row.key)).toEqual(expected);
    expect(result.totalCount).toBe(expected.length);
  }
});

it.each([
  { opts: { projectId: "project-one" }, matches: ["selected", "workspace-root"] },
  { opts: { workspaceDir: "/workspace" }, matches: ["workspace-root"] },
  { opts: { workspaceDir: "/workspace/./task" }, matches: [] },
  { opts: { workspaceDir: "/configured" }, matches: [] },
  { opts: { group: "review" }, matches: ["repository-only"] },
  { opts: { group: "" }, matches: ["unassociated"] },
] satisfies { opts: SessionsListParams; matches: string[] }[])(
  "matches only persisted exact associations: $opts",
  async ({ opts, matches }) => {
    const store: Record<string, SessionEntry> = {
      "agent:main:selected": entry({
        sessionId: "selected",
        updatedAt: 4,
        projectId: "project-one",
        spawnedCwd: "/workspace/task",
        spawnedWorkspaceDir: "/workspace",
        category: "Review",
      }),
      "agent:main:workspace-root": entry({
        sessionId: "workspace-root",
        updatedAt: 3,
        projectId: "project-one",
        spawnedWorkspaceDir: "/workspace",
        category: "Review",
      }),
      "agent:main:repository-only": entry({
        sessionId: "repository-only",
        updatedAt: 2,
        repositoryWorkspaceId: "project-one",
        category: "review",
      }),
      "agent:main:unassociated": entry({ sessionId: "unassociated" }),
    };
    const result = await listSessionFixture({
      cfg: { agents: { entries: { main: { workspace: "/configured" } } } },
      storePath,
      store,
      opts,
    });
    expect(result.sessions.map((row) => row.sessionId)).toEqual(matches);
    expect(result.totalCount).toBe(matches.length);
    for (const row of result.sessions) {
      if (row.sessionId === "selected") {
        expect(row).toMatchObject({ projectId: "project-one", workspaceDir: "/workspace/task" });
      } else if (row.sessionId === "workspace-root") {
        expect(row).toMatchObject({ projectId: "project-one", workspaceDir: "/workspace" });
      } else {
        expect(row.projectId).toBeUndefined();
        expect(row.workspaceDir).toBeUndefined();
      }
    }
  },
);

it("does not project extra participants when canonical owners satisfy both involvement filters", async () => {
  const participants = vi.spyOn(sessionIdentity, "projectSessionParticipants");
  const store = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [
      `agent:main:owned-${index}`,
      entry({
        sessionId: `owned-${index}`,
        updatedAt: index + 1,
        createdActor: { type: "human", source: "profile", id: "profile-merged-ada" },
        participants: [{ identity: { type: "profile", id: "profile-bob" } }],
      }),
    ]),
  );
  const query = { cfg, storePath, store, opts: { limit: 1 } };
  const all = await listSessionFixture(query);
  const unfilteredWork = participants.mock.calls.length;
  participants.mockClear();

  const filtered = await listSessionFixture({
    ...query,
    opts: {
      ...query.opts,
      profileRelation: { profileId: "profile-ada", relationship: "involving" },
    },
    involvingActorId: "profile-ada",
  });

  expect(filtered.sessions.map((row) => row.key)).toEqual(all.sessions.map((row) => row.key));
  expect(filtered.owners).toEqual(all.owners);
  expect(filtered.totalCount).toBe(32);
  expect(filtered.sessions[0]?.owner?.actor.identity).toEqual({
    type: "profile",
    id: "profile-ada",
  });
  expect(participants.mock.calls.length).toBeLessThanOrEqual(unfilteredWork);
});

it.each([true, false])("filters canonical pin state before pagination: %s", async (pinned) => {
  const result = await listSessionFixture({
    cfg,
    storePath,
    store: {
      "agent:main:subagent:stale-pin": entry({ updatedAt: 5, pinnedAt: 1 }),
      "agent:main:child": entry({ updatedAt: 4, pinnedAt: 1, parentSessionKey: "agent:main:root" }),
      "agent:main:spawned": entry({ updatedAt: 3, pinnedAt: 1, spawnedBy: "agent:main:root" }),
      "agent:main:root": entry({ updatedAt: 2, pinnedAt: 1 }),
      "agent:main:unpinned": entry(),
    },
    opts: { pinned, limit: 1 },
  });
  expect(result.sessions.map((row) => row.key)).toEqual([
    pinned ? "agent:main:root" : "agent:main:subagent:stale-pin",
  ]);
  expect(result.sessions[0]?.pinned).toBe(pinned);
  expect(result).toMatchObject({ totalCount: pinned ? 1 : 4, hasMore: !pinned });
});

it("finds sparse metadata matches beyond 200 rows before facets and pagination", async () => {
  const store: Record<string, SessionEntry> = Object.fromEntries(
    Array.from({ length: 205 }, (_, index) => [
      `agent:main:unrelated-${index}`,
      entry({
        sessionId: `unrelated-${index}`,
        updatedAt: 1_000 + index,
        createdActor: { type: "human", source: "profile", id: "profile-bob" },
        projectId: "other-project",
        spawnedCwd: "/other-workspace",
        category: "Other",
      }),
    ]),
  );
  for (const index of [0, 1, 2]) {
    store[`agent:main:match-${index}`] = entry({
      sessionId: `match-${index}`,
      updatedAt: 3 - index,
      projectId: "project-one",
      spawnedCwd: "/workspace/task",
      category: "Review",
      pinnedAt: 1,
      createdActor: { type: "human", source: "profile", id: "profile-ada" },
    });
  }
  const opts: SessionsListParams = {
    projectId: "project-one",
    workspaceDir: "/workspace/task",
    group: "Review",
    pinned: true,
    includePeople: true,
    limit: 2,
  };
  const first = await listSessionFixture({ cfg, storePath, store, opts });
  expect(first.sessions.map((row) => row.sessionId)).toEqual(["match-0", "match-1"]);
  expect(first).toMatchObject({
    totalCount: 3,
    peopleSessionCount: 3,
    nextOffset: 2,
    hasMore: true,
  });
  expect(first.owners?.map((owner) => owner.id)).toEqual(["profile-ada"]);
  expect(first.people?.map((person) => [person.identity.id, person.sessionCount])).toEqual([
    ["profile-ada", 3],
  ]);
  const second = await listSessionFixture({ cfg, storePath, store, opts: { ...opts, offset: 2 } });
  expect(second.sessions.map((row) => row.sessionId)).toEqual(["match-2"]);
  expect(second).toMatchObject({ totalCount: 3, nextOffset: null, hasMore: false });
});

it("keeps profile selectors, authenticated involvement, and their owner facets distinct", async () => {
  const ada: SessionEntry["createdActor"] = { type: "human", source: "profile", id: "profile-ada" };
  const bob: SessionEntry["createdActor"] = { type: "human", source: "profile", id: "profile-bob" };
  const store: Record<string, SessionEntry> = {
    "agent:main:agent-owner": entry({
      updatedAt: 8,
      createdActor: { type: "agent", id: "profile-ada" },
      owner: { actor: { type: "agent", id: "profile-ada" } },
      participants: [{ identity: { type: "profile", id: "profile-ada" } }],
    }),
    "agent:main:created-only": entry({ updatedAt: 7, createdActor: ada, owner: { actor: bob } }),
    "agent:main:owned": entry({ updatedAt: 6, createdActor: bob, owner: { actor: ada } }),
    "agent:main:default-owner": entry({ updatedAt: 5, createdActor: ada }),
    "agent:main:participating": entry({
      updatedAt: 4,
      createdActor: bob,
      participants: [
        ...Array.from({ length: 5 }, (_, index) => ({
          identity: { type: "profile" as const, id: `profile-other-${index}` },
        })),
        { identity: { type: "profile", id: "profile-ada" } },
      ],
    }),
    "agent:main:legacy-collision": entry({
      updatedAt: 3,
      createdActor: bob,
      participants: [
        { identity: { type: "legacy", id: "profile-ada", actorType: "human", source: null } },
      ],
    }),
    "agent:main:agent-collision": entry({
      updatedAt: 2,
      createdActor: bob,
      participants: [{ identity: { type: "agent", id: "profile-ada" } }],
    }),
    "agent:main:unrelated": entry({
      createdActor: { type: "human", source: "profile", id: "profile-carol" },
    }),
  };
  const query = { cfg: { agents: { entries: { main: {}, "profile-ada": {} } } }, storePath, store };
  const all = await listSessionFixture({ ...query, opts: {} });
  const allOwners = ["agent:profile-ada", "human:profile-bob", "human:profile-carol"];
  const involvingOwners = allOwners.slice(0, 2);
  const involvedKeys = ["agent-owner", "owned", "default-owner", "participating"];
  const involving: SessionsListParams = {
    profileRelation: { profileId: "profile-ada", relationship: "involving" },
  };
  const cases: {
    name: string;
    opts: SessionsListParams;
    involvingActorId?: string;
    keys: string[];
    owners: string[];
  }[] = [
    {
      name: "owned",
      opts: { profileRelation: { profileId: "profile-ada", relationship: "owned" } },
      keys: ["owned", "default-owner"],
      owners: ["human:profile-ada"],
    },
    {
      name: "created",
      opts: { profileRelation: { profileId: "profile-ada", relationship: "created" } },
      keys: ["created-only", "default-owner"],
      owners: ["human:profile-ada", "human:profile-bob"],
    },
    {
      name: "involving",
      opts: { ...involving, includePeople: true },
      keys: involvedKeys,
      owners: involvingOwners,
    },
    {
      name: "associated",
      opts: { involvingProfileId: "profile-ada" },
      keys: ["agent-owner", "created-only", "owned", "default-owner", "participating"],
      owners: allOwners,
    },
    {
      name: "involvingMe",
      opts: {},
      involvingActorId: "profile-ada",
      keys: involvedKeys,
      owners: allOwners,
    },
    {
      name: "authenticated intersection",
      opts: involving,
      involvingActorId: "profile-bob",
      keys: ["participating"],
      owners: involvingOwners,
    },
  ];
  for (const { name, opts, involvingActorId, keys, owners } of cases) {
    const result = await listSessionFixture({ ...query, opts, involvingActorId });
    expect(
      result.sessions.map((row) => row.key),
      name,
    ).toEqual(keys.map((key) => `agent:main:${key}`));
    expect(result.owners?.map((owner) => `${owner.type}:${owner.id}`).toSorted(), name).toEqual(
      owners,
    );
    if (name === "involvingMe") {
      expect(result.owners).toEqual(all.owners);
    }
    if (opts.includePeople) {
      expect(result.peopleSessionCount).toBe(4);
      const participating = result.sessions.find((row) => row.key === "agent:main:participating");
      expect(
        participating?.participants?.some((person) => person.identity.id === "profile-ada"),
      ).toBe(false);
      expect(
        participating?.expandedParticipants?.some((person) => person.identity.id === "profile-ada"),
      ).toBe(true);
    }
  }
});
