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
import { prepareSessionRowSelection, selectSessionEntries } from "./session-utils-list.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";

vi.mock("../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profile-list.js")>()),
  getResidentUserProfileDisplay: vi.fn((id: string) => ({
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
const actor = (id: string) => ({ type: "human" as const, source: "profile" as const, id });
const people = (...ids: string[]) =>
  ids.map((id) => ({ identity: { type: "profile" as const, id } }));
const sessionKey = (name: string) => `agent:main:${name}`;
function rows(fieldsByName: Record<string, Partial<SessionEntry>>) {
  const entries = Object.entries(fieldsByName);
  return Object.fromEntries(
    entries.map(([name, fields], index) => [
      sessionKey(name),
      entry({ sessionId: name, updatedAt: entries.length - index, ...fields }),
    ]),
  );
}
function list(store: Record<string, SessionEntry>, opts: SessionsListParams = {}, config = cfg) {
  return listSessionFixture({ cfg: config, storePath, store, opts });
}
function projectionFixture(
  params: Omit<Parameters<typeof createSessionRowProjectionFixture>[0], "cfg" | "storePath">,
) {
  const projection = createSessionRowProjectionFixture({ cfg, storePath, ...params });
  onTestFinished(() => projection.dispose());
  return projection;
}

it.each([true, false])(
  "keeps full-roster facets and owner rows while paging ordered=%s",
  (ordered) => {
    const store = Object.fromEntries(
      [1, 4, 3, 5, 2].map((updatedAt) => [
        `agent:main:page-${updatedAt}`,
        entry({
          sessionId: `page-${updatedAt}`,
          updatedAt,
          createdActor: actor(updatedAt === 4 || updatedAt === 2 ? "profile-ada" : "profile-bob"),
        }),
      ]),
    );
    const projection = projectionFixture({ store });
    for (const [offset, keys, ownerCount, nextOffset] of [
      [0, [4, 2, 5], 2, 2],
      [2, [3, 2], 0, 4],
      [4, [1], 0, null],
      [7, [], 0, null],
    ] as const) {
      const selected = runSynchronousWork(
        selectSessionEntries({
          ...prepareSessionRowSelection(
            projection,
            { limit: 2, offset, includePeople: true },
            { ordered },
          ),
          entriesSorted: ordered,
          ownerFirstActorId: "profile-ada",
        }),
      );
      expect(selected.entries.map(([key]) => key)).toEqual(
        keys.map((id) => `agent:main:page-${id}`),
      );
      expect(selected).toMatchObject({
        totalCount: 5,
        peopleSessionCount: 5,
        ownerCount,
        nextOffset,
        hasMore: nextOffset !== null,
      });
      expect(selected.ownerFacet.map(({ id }) => id)).toEqual(["profile-ada", "profile-bob"]);
      expect(
        selected.people?.map(({ identity, sessionCount }) => [identity.id, sessionCount]),
      ).toEqual([
        ["profile-bob", 3],
        ["profile-ada", 2],
      ]);
    }
  },
);

it("reports the age boundary of people outside the selected profile and returned page", async () => {
  const now = Date.UTC(2026, 8, 27);
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const store = {
    "agent:main:selected": entry({
      lastActivityAt: now,
      createdActor: actor("profile-ada"),
    }),
    "agent:main:other-person": entry({
      lastActivityAt: now - 3_600_000 + 100,
      createdActor: actor("profile-bob"),
    }),
    "agent:main:excluded-dock": entry({
      lastActivityAt: now - 3_600_000 + 10,
      createdSurface: "plugin-dock",
    }),
    "agent:main:already-expired": entry({ lastActivityAt: now - 3_600_001 }),
  };
  const opts: SessionsListParams = {
    activeMinutes: 60,
    sortBy: "activity",
    excludeDock: true,
    includePeople: true,
    limit: 1,
  };
  const read = (query = opts) => list(store, query);
  const first = await read();
  expect(first.sessions.map((row) => row.key)).toEqual(["agent:main:selected"]);
  expect(first.activityExpiresAt).toBe(now + 100);
  const selected = { ...opts, involvingProfileId: "profile-ada" };
  const person = await read(selected);
  expect(person.activityExpiresAt).toBe(now + 100);
  expect(person.people?.map(({ identity }) => identity.id).toSorted()).toEqual([
    "profile-ada",
    "profile-bob",
  ]);
  clock.mockReturnValue(now + 100);
  expect((await read(selected)).activityExpiresAt).toBe(now + 100);
  clock.mockReturnValue(now + 101);
  const expired = await read(selected);
  expect(expired.activityExpiresAt).toBe(now + 3_600_000);
  expect(expired.people?.map(({ identity }) => identity.id)).toEqual(["profile-ada"]);
  clock.mockReturnValue(now + 3_600_001);
  expect((await read(selected)).activityExpiresAt).toBeUndefined();
  expect((await read({ ...opts, activeMinutes: undefined })).activityExpiresAt).toBeUndefined();
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
  const projection = projectionFixture({ store: { [key]: original }, rowContext });
  const select = (id = "profile-ada") =>
    runSynchronousWork(
      filterSessionEntries({
        ...prepareSessionRowSelection(projection, {}, { ordered: true }),
        involvingActorId: id,
      }),
    ).entries.map(([selectedKey]) => selectedKey);
  expect(select()).toEqual([key]);
  readInvolvement.mockClear();
  for (let i = 0; i < 3; i++) {
    expect(select()).toEqual([key]);
    expect(select("profile-bob")).toEqual([]);
  }
  expect(readInvolvement).not.toHaveBeenCalled();

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
  const projection = projectionFixture({
    store: { [key]: entry({ updatedAt: now, spawnedBy: parent }) },
  });
  const select = (clock: number) =>
    runSynchronousWork(
      filterSessionEntries({
        ...prepareSessionRowSelection(projection, { spawnedBy: parent }, { now: clock }),
      }),
    ).entries.map(([selectedKey]) => selectedKey);
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
  const activity = (
    lastActivityAt: number,
    createdAt: number | undefined,
    ids: string[],
    overrides: Partial<SessionEntry> = {},
  ) => entry({ lastActivityAt, createdAt, participants: people(...ids), ...overrides });
  const ada = ["profile-ada"];
  const cutoff = now - activeMinutes * 60_000;
  const hour = 3_600_000;
  const result = await list(
    {
      "agent:main:midnight": activity(since, cutoff - 1, ada),
      "agent:main:morning": activity(since + hour, since, ["profile-merged-ada", "profile-bob"], {
        lastInteractionAt: since + 2 * hour,
      }),
      "agent:main:clock-skew": activity(since + 25 * hour, since + 24 * hour, ada),
      "agent:main:three-days-ago": activity(
        since - 3 * 86_400_000,
        cutoff,
        [...ada, "profile-earlier"],
        { updatedAt: since + 30 * hour },
      ),
      "agent:main:outside-window": activity(cutoff - 1, undefined, [...ada, "profile-excluded"]),
      "agent:main:other-person": activity(since + 5 * hour, since, ["profile-carol"]),
    },
    {
      activityPulseBoundaries: Array.from({ length: 25 }, (_, index) => since + index * 3_600_000),
      activeMinutes,
      includePeople: true,
      involvingProfileId: "profile-ada",
      sortBy: "activity",
      limit: 1,
    },
  );
  expect(result).toMatchObject({ sessions: [expect.any(Object)], totalCount: 4 });
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

it("keeps system provenance and named conversations distinct in projected lists", async () => {
  const cases: [key: string, fields: Partial<SessionEntry>, visible: boolean][] = [
    ["system", { createdActor: { type: "system" }, label: "Named probe" }, false],
    ["human", { createdVia: "run", createdActor: { type: "human", source: "unknown" } }, true],
    ["label", { createdVia: "run", label: "Operator label" }, true],
    ["display-name", { createdVia: "internal", displayName: "Operator title" }, true],
    ["subject", { createdVia: "run", subject: "Conversation subject" }, true],
    ["whitespace", { createdVia: "internal", label: " ", displayName: "\t", subject: "\n" }, false],
    ["legacy", {}, true],
    ["main", {}, true],
    ["main:heartbeat", { heartbeatIsolatedBaseSessionKey: sessionKey("main") }, false],
    [
      "ops:heartbeat",
      { heartbeatIsolatedBaseSessionKey: sessionKey("ops"), label: "Named lane" },
      true,
    ],
    ["alerts:heartbeat", { label: "My heartbeat" }, true],
    ["cron:nightly", { createdVia: "internal", createdActor: { type: "system" } }, true],
  ];
  const store = rows(Object.fromEntries(cases.map(([name, fields]) => [name, fields])));
  for (const excludeSystem of [true, false, undefined]) {
    const result = await list(store, { excludeSystem });
    const expected = cases
      .filter((row) => excludeSystem !== true || row[2])
      .map(([name]) => sessionKey(name));
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
    const associated = {
      projectId: "project-one",
      spawnedWorkspaceDir: "/workspace",
      category: "Review",
    };
    const store = rows({
      selected: { ...associated, spawnedCwd: "/workspace/task" },
      "workspace-root": associated,
      "repository-only": { repositoryWorkspaceId: "project-one", category: "review" },
      unassociated: {},
    });
    const result = await list(store, opts, {
      agents: { entries: { main: { workspace: "/configured" } } },
    });
    expect(result.sessions.map((row) => row.sessionId)).toEqual(matches);
    expect(result.totalCount).toBe(matches.length);
    for (const row of result.sessions) {
      if (row.sessionId === "selected") {
        expect(row).toMatchObject({ projectId: "project-one", workspaceDir: "/workspace/task" });
      } else if (row.sessionId === "workspace-root") {
        expect(row).toMatchObject({ projectId: "project-one", workspaceDir: "/workspace" });
      } else {
        expect([row.projectId, row.workspaceDir]).toEqual([undefined, undefined]);
      }
    }
  },
);

it.each([true, false])("filters canonical pin state before pagination: %s", async (pinned) => {
  const result = await list(
    rows({
      "subagent:stale-pin": { pinnedAt: 1 },
      child: { pinnedAt: 1, parentSessionKey: sessionKey("root") },
      spawned: { pinnedAt: 1, spawnedBy: sessionKey("root") },
      root: { pinnedAt: 1 },
      unpinned: {},
    }),
    { pinned, limit: 1 },
  );
  expect(result.sessions.map((row) => row.key)).toEqual([
    pinned ? "agent:main:root" : "agent:main:subagent:stale-pin",
  ]);
  expect(result.sessions[0]?.pinned).toBe(pinned);
  expect(result).toMatchObject({ totalCount: pinned ? 1 : 4, hasMore: !pinned });
});

it("keeps profile selectors, authenticated involvement, and their owner facets distinct", async () => {
  const ada = actor("profile-ada");
  const bob = actor("profile-bob");
  const agent = { type: "agent" as const, id: "profile-ada" };
  const store = rows({
    "agent-owner": {
      createdActor: agent,
      owner: { actor: agent },
      participants: people("profile-ada"),
    },
    "created-only": { createdActor: ada, owner: { actor: bob } },
    owned: { createdActor: bob, owner: { actor: ada } },
    "default-owner": { createdActor: ada },
    participating: {
      createdActor: bob,
      participants: people(
        ...Array.from({ length: 5 }, (_, i) => `profile-other-${i}`),
        "profile-ada",
      ),
    },
    "legacy-collision": {
      createdActor: bob,
      participants: [
        { identity: { type: "legacy", id: "profile-ada", actorType: "human", source: null } },
      ],
    },
    "agent-collision": { createdActor: bob, participants: [{ identity: agent }] },
    unrelated: { createdActor: actor("profile-carol") },
  });
  const query = { cfg: { agents: { entries: { main: {}, "profile-ada": {} } } }, storePath, store };
  const all = await listSessionFixture({ ...query, opts: {} });
  const allOwners = ["agent:profile-ada", "human:profile-bob", "human:profile-carol"];
  const involvingOwners = allOwners.slice(0, 2);
  const involvedKeys = ["agent-owner", "owned", "default-owner", "participating"];
  const involving: SessionsListParams = {
    profileRelation: { profileId: "profile-ada", relationship: "involving" },
  };
  const relation = (relationship: "owned" | "created"): SessionsListParams => ({
    profileRelation: { profileId: "profile-ada", relationship },
  });
  const cases: [string, SessionsListParams, string[], string[], string?][] = [
    ["owned", relation("owned"), ["owned", "default-owner"], ["human:profile-ada"]],
    [
      "created",
      relation("created"),
      ["created-only", "default-owner"],
      ["human:profile-ada", "human:profile-bob"],
    ],
    ["involving", { ...involving, includePeople: true }, involvedKeys, involvingOwners],
    [
      "associated",
      { involvingProfileId: "profile-ada" },
      ["agent-owner", "created-only", "owned", "default-owner", "participating"],
      allOwners,
    ],
    ["involvingMe", {}, involvedKeys, allOwners, "profile-ada"],
    ["authenticated intersection", involving, ["participating"], involvingOwners, "profile-bob"],
  ];
  for (const [name, opts, keys, owners, involvingActorId] of cases) {
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
