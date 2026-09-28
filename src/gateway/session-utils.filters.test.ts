import { Value } from "typebox/value";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  SessionsListParamsSchema,
  type SessionsListParams,
} from "../../packages/gateway-protocol/src/schema/sessions-list.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runSynchronousWork } from "../shared/synchronous-work.js";
import type { GatewayClient } from "./server-methods/types.js";
import * as sessionIdentity from "./session-identity-projection.js";
import { filterSessionEntries } from "./session-list-filters.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { createSessionListEntryFilter } from "./session-sharing.js";
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

it("accepts the metadata query contract and rejects mistyped selectors", () => {
  expect(
    Value.Check(SessionsListParamsSchema, {
      projectId: "project-one",
      workspaceDir: "/workspace/task",
      group: "",
      pinned: false,
      activityPulseSince: 0,
      activityPulseUntil: 86_400_000,
      profileRelation: { profileId: "profile-ada", relationship: "involving" },
    }),
  ).toBe(true);
  for (const invalid of [
    { projectId: "" },
    { workspaceDir: "" },
    { group: false },
    { pinned: "false" },
    { activityPulseSince: -1 },
    { activityPulseSince: "0" },
    { activityPulseUntil: -1 },
    { activityPulseUntil: "0" },
    { profileRelation: { profileId: "", relationship: "involving" } },
  ]) {
    expect(Value.Check(SessionsListParamsSchema, invalid), JSON.stringify(invalid)).toBe(false);
  }
});

it("aggregates activity after person filtering and before pagination using the activity clock", async () => {
  const since = Date.UTC(2026, 8, 27);
  const person = (id: string) => ({ identity: { type: "profile" as const, id } });
  const result = await listSessionFixture({
    cfg,
    storePath,
    store: {
      "agent:main:midnight": entry({
        lastActivityAt: since,
        createdAt: since - 1,
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
      "agent:main:yesterday": entry({
        lastActivityAt: since - 1,
        updatedAt: since + 30 * 3_600_000,
        participants: [person("profile-ada"), person("profile-yesterday")],
      }),
      "agent:main:other-person": entry({
        lastActivityAt: since + 5 * 3_600_000,
        createdAt: since,
        participants: [person("profile-carol")],
      }),
    },
    opts: {
      activityPulseSince: since,
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
    hours: [1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    sessions: 2,
    started: 1,
    running: 0,
    people: 2,
  });
});

it.each([23, 25])("bounds the activity pulse to a %s-hour civil day", (hours) => {
  const since = Date.UTC(2026, 8, 27);
  const until = since + hours * 3_600_000;
  const projection = createSessionRowProjectionFixture({
    cfg,
    store: {
      "agent:main:last-hour": entry({ lastActivityAt: until - 1, createdAt: since }),
      "agent:main:tomorrow": entry({ lastActivityAt: until, createdAt: until }),
    },
  });
  onTestFinished(projection.dispose);
  const result = runSynchronousWork(
    filterSessionEntries({
      ...prepareSessionRowSelection(projection, {
        activityPulseSince: since,
        activityPulseUntil: until,
      }),
      projectActiveRun: () => ({ active: true }),
    }),
  );
  expect(result.activityPulse).toEqual({
    since,
    until,
    hours: [...Array.from({ length: hours - 1 }, () => 0), 1],
    sessions: 1,
    started: 1,
    running: 2,
  });
});

it.each([
  { label: "missing", until: undefined },
  { label: "not after since", until: Date.UTC(2026, 8, 27) },
  { label: "longer than a civil day", until: Date.UTC(2026, 8, 27) + 26 * 3_600_000 },
  { label: "absurd", until: Number.MAX_SAFE_INTEGER },
])("falls back to a 24-hour window when the requested end is $label", ({ until }) => {
  const since = Date.UTC(2026, 8, 27);
  const projection = createSessionRowProjectionFixture({
    cfg,
    store: { "agent:main:late": entry({ lastActivityAt: since + 24 * 3_600_000 - 1 }) },
  });
  onTestFinished(projection.dispose);
  const result = runSynchronousWork(
    filterSessionEntries(
      prepareSessionRowSelection(projection, {
        activityPulseSince: since,
        ...(until === undefined ? {} : { activityPulseUntil: until }),
      }),
    ),
  );
  expect(result.activityPulse).toMatchObject({ until: since + 24 * 3_600_000, sessions: 1 });
  expect(result.activityPulse?.hours).toHaveLength(24);
});

it("counts every live session as running now and only today's sessions in the buckets", () => {
  const since = 100;
  const projection = createSessionRowProjectionFixture({
    cfg: { agents: { entries: { worker: {} } } },
    store: {
      "agent:worker:live": entry({ sessionId: "running", lastActivityAt: since }),
      "agent:worker:old": entry({ sessionId: "running", lastActivityAt: since - 1 }),
      "agent:worker:idle": entry({ sessionId: "idle", lastActivityAt: since + 1 }),
    },
  });
  onTestFinished(projection.dispose);
  const result = runSynchronousWork(
    filterSessionEntries({
      ...prepareSessionRowSelection(projection, { activityPulseSince: since }),
      projectActiveRun: (key, row, agentId) => ({
        active:
          key.startsWith("agent:worker:") && row.sessionId === "running" && agentId === "worker",
      }),
    }),
  );
  expect(result.activityPulse).toMatchObject({ sessions: 2, running: 2 });
});

it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY])(
  "omits the activity pulse for an absent or invalid start: %s",
  async (activityPulseSince) => {
    const result = await listSessionFixture({
      cfg,
      storePath,
      store: { "agent:main:one": entry() },
      opts: { activityPulseSince },
    });
    expect(result).not.toHaveProperty("activityPulse");
  },
);

it("accepts epoch zero and omits pulse people unless requested", async () => {
  const result = await listSessionFixture({
    cfg,
    storePath,
    store: {
      "agent:main:one": entry({
        createdAt: 0,
        participants: [{ identity: { type: "profile", id: "profile-ada" } }],
      }),
    },
    opts: { activityPulseSince: 0 },
  });
  expect(result.activityPulse).toMatchObject({ since: 0, sessions: 1, started: 1, running: 0 });
  expect(result.activityPulse).not.toHaveProperty("people");
});

it("keeps system provenance and named conversations distinct in projected lists", async () => {
  const cases: { key: string; fields: Partial<SessionEntry>; visible: boolean }[] = [
    {
      key: "agent:main:system",
      fields: { createdActor: { type: "system" }, label: "Named probe" },
      visible: false,
    },
    {
      key: "agent:main:human",
      fields: { createdVia: "run", createdActor: { type: "human", source: "unknown" } },
      visible: true,
    },
    {
      key: "agent:main:label",
      fields: { createdVia: "run", label: "Operator label" },
      visible: true,
    },
    {
      key: "agent:main:display-name",
      fields: { createdVia: "internal", displayName: "Operator title" },
      visible: true,
    },
    {
      key: "agent:main:subject",
      fields: { createdVia: "run", subject: "Conversation subject" },
      visible: true,
    },
    {
      key: "agent:main:whitespace",
      fields: { createdVia: "internal", label: " ", displayName: "\t", subject: "\n" },
      visible: false,
    },
    { key: "agent:main:legacy", fields: {}, visible: true },
    {
      key: "agent:main:cron:nightly",
      fields: { createdVia: "internal", createdActor: { type: "system" } },
      visible: true,
    },
  ];
  const store = Object.fromEntries(
    cases.map(({ key, fields }, index) => [
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
    const expected = cases
      .filter(({ visible }) => excludeSystem !== true || visible)
      .map(({ key }) => key);
    expect(result.sessions.map((row) => row.key)).toEqual(expected);
    expect(result.totalCount).toBe(expected.length);
  }
});

it.each([
  { opts: { projectId: "project-one" }, matches: ["selected", "workspace-root"] },
  { opts: { workspaceDir: "/workspace/task" }, matches: ["selected"] },
  { opts: { workspaceDir: "/workspace" }, matches: ["workspace-root"] },
  { opts: { workspaceDir: "/workspace/./task" }, matches: [] },
  { opts: { workspaceDir: "/configured" }, matches: [] },
  { opts: { group: "Review" }, matches: ["selected", "workspace-root"] },
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

it.each(["owned", "created"] as const)(
  "keeps %s profile relationships distinct from an agent with the same raw id",
  async (relationship) => {
    const result = await listSessionFixture({
      cfg: { agents: { entries: { main: {}, "profile-ada": {} } } },
      storePath,
      store: {
        "agent:main:human": entry({
          sessionId: "human",
          updatedAt: 2,
          createdActor: { type: "human", source: "profile", id: "profile-ada" },
        }),
        "agent:main:agent": entry({
          sessionId: "agent",
          createdActor: { type: "agent", id: "profile-ada" },
          owner: { actor: { type: "agent", id: "profile-ada" } },
          participants: [{ identity: { type: "profile", id: "profile-ada" } }],
        }),
      },
      opts: { profileRelation: { profileId: "profile-ada", relationship } },
    });
    expect(result.sessions.map((row) => row.sessionId)).toEqual(["human"]);
  },
);

it("preserves visible owner facets for the authenticated involvingMe filter", async () => {
  const store: Record<string, SessionEntry> = {
    "agent:main:ada": entry({
      sessionId: "ada",
      createdActor: { type: "human", source: "profile", id: "profile-ada" },
    }),
    "agent:main:bob": entry({
      sessionId: "bob",
      createdActor: { type: "human", source: "profile", id: "profile-bob" },
    }),
  };
  const query = { cfg, storePath, store, opts: {} };
  const all = await listSessionFixture(query);
  const involvingMe = await listSessionFixture({ ...query, involvingActorId: "profile-ada" });
  expect(involvingMe.sessions.map((row) => row.sessionId)).toEqual(["ada"]);
  expect(involvingMe.owners).toEqual(all.owners);
  expect(involvingMe.owners?.map((owner) => owner.id).toSorted()).toEqual([
    "profile-ada",
    "profile-bob",
  ]);
  const explicitRelation = await listSessionFixture({
    ...query,
    opts: { profileRelation: { profileId: "profile-ada", relationship: "involving" } },
  });
  expect(explicitRelation.owners?.map((owner) => owner.id)).toEqual(["profile-ada"]);
});

it.each(["viewer", "relation", "both"] as const)(
  "does not project extra participants when canonical owners satisfy the %s filter",
  async (filter) => {
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
        ...(filter !== "viewer"
          ? { profileRelation: { profileId: "profile-ada", relationship: "involving" as const } }
          : {}),
      },
      ...(filter !== "relation" ? { involvingActorId: "profile-ada" } : {}),
    });

    expect(filtered.sessions.map((row) => row.key)).toEqual(all.sessions.map((row) => row.key));
    expect(filtered.owners).toEqual(all.owners);
    expect(filtered.totalCount).toBe(32);
    expect(filtered.sessions[0]?.owner?.actor.identity).toEqual({
      type: "profile",
      id: "profile-ada",
    });
    expect(participants.mock.calls.length).toBeLessThanOrEqual(unfilteredWork);
  },
);

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

it("distinguishes profile involvement from creation and uses participants beyond the display summary", async () => {
  const ada: SessionEntry["createdActor"] = { type: "human", source: "profile", id: "profile-ada" };
  const bob: SessionEntry["createdActor"] = { type: "human", source: "profile", id: "profile-bob" };
  const store: Record<string, SessionEntry> = {
    "agent:main:created-only": entry({
      updatedAt: 7,
      createdActor: ada,
      owner: { actor: bob },
    }),
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
    "agent:main:unrelated": entry({ createdActor: bob }),
  };
  const involved = await listSessionFixture({
    cfg,
    storePath,
    store,
    opts: {
      profileRelation: { profileId: "profile-ada", relationship: "involving" },
      includePeople: true,
    },
  });
  expect(involved.sessions.map((row) => row.key)).toEqual([
    "agent:main:owned",
    "agent:main:default-owner",
    "agent:main:participating",
  ]);
  expect(involved.peopleSessionCount).toBe(3);
  expect(
    involved.sessions[2]?.participants?.some((person) => person.identity.id === "profile-ada"),
  ).toBe(false);
  expect(
    involved.sessions[2]?.expandedParticipants?.some(
      (person) => person.identity.id === "profile-ada",
    ),
  ).toBe(true);

  const associated = await listSessionFixture({
    cfg,
    storePath,
    store,
    opts: { involvingProfileId: "profile-ada" },
  });
  expect(associated.sessions.map((row) => row.key)).toEqual([
    "agent:main:created-only",
    "agent:main:owned",
    "agent:main:default-owner",
    "agent:main:participating",
  ]);

  // The caller-supplied profile selector cannot replace the authenticated involvingMe constraint.
  const intersection = await listSessionFixture({
    cfg,
    storePath,
    store,
    opts: { profileRelation: { profileId: "profile-ada", relationship: "involving" } },
    involvingActorId: "profile-bob",
  });
  expect(intersection.sessions.map((row) => row.key)).toEqual(["agent:main:participating"]);
});

it.each([
  { projectId: "project-one" },
  { workspaceDir: "/workspace/task" },
  { group: "Review" },
  { pinned: true },
  { profileRelation: { profileId: "profile-ada", relationship: "involving" } },
] satisfies SessionsListParams[])(
  "never expands visibility from metadata associations: %s",
  async (opts) => {
    const associated = entry({
      projectId: "project-one",
      spawnedCwd: "/workspace/task",
      category: "Review",
      pinnedAt: 1,
      createdActor: { type: "human", source: "profile", id: "profile-bob" },
      owner: { actor: { type: "human", id: "profile-ada" } },
      participants: [{ identity: { type: "profile", id: "profile-ada" } }],
    });
    const store: Record<string, SessionEntry> = {
      "agent:main:hidden": {
        ...associated,
        sessionId: "hidden",
        updatedAt: 2,
        visibility: "draft",
      },
      "agent:main:shared": { ...associated, sessionId: "shared", visibility: "shared" },
    };
    const viewer = {
      connect: { scopes: ["operator.read"] },
      authenticatedUserProfile: { profileId: "profile-ada" },
    } as GatewayClient;
    const result = await listSessionFixture({
      cfg,
      storePath,
      store,
      opts: { ...opts, includePeople: true, limit: 1 },
      entryFilter: createSessionListEntryFilter({ client: viewer }),
    });
    expect(result.sessions.map((row) => row.key)).toEqual(["agent:main:shared"]);
    expect(result).toMatchObject({
      totalCount: 1,
      peopleSessionCount: 1,
      nextOffset: null,
      hasMore: false,
    });
    expect(result.people?.every((person) => person.sessionCount === 1)).toBe(true);
  },
);
