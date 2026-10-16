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

const adaId = "profile-ada";
const bobId = "profile-bob";
const mergedAdaId = "profile-merged-ada";
const now = Date.UTC(2026, 8, 27);
const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
const storePath = "/tmp/openclaw-session-inventory-filters";
const activityOpts = { includePeople: true, sortBy: "activity" as const, limit: 1 };

const baseEntry: SessionEntry = { sessionId: "inventory-session", updatedAt: 1 };
const entry = (overrides: Partial<SessionEntry> = {}) => ({ ...baseEntry, ...overrides });
const actor = (id: string) => ({ type: "human" as const, source: "profile" as const, id });
type Actor = NonNullable<SessionEntry["createdActor"]>;
const owned = (createdActor: Actor, owner: Actor) => ({ createdActor, owner: { actor: owner } });
const people = (...ids: string[]) =>
  ids.map((id) => ({ identity: { type: "profile" as const, id } }));
const sessionKey = (name: string) => `agent:main:${name}`;
function rows(fieldsByName: Record<string, Partial<SessionEntry>>) {
  return Object.fromEntries(
    Object.entries(fieldsByName).map(([name, fields], index, entries) => [
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
function filteredKeys(params: Parameters<typeof filterSessionEntries>[0]) {
  return runSynchronousWork(filterSessionEntries(params)).entries.map(([key]) => key);
}

it.each([true, false])("pages owner-first rows with full-roster facets (ordered=%s)", (ordered) => {
  const store = rows(
    Object.fromEntries(
      [1, 4, 3, 5, 2].map((updatedAt) => [
        `page-${updatedAt}`,
        {
          updatedAt,
          createdActor: actor(updatedAt === 4 || updatedAt === 2 ? adaId : bobId),
        },
      ]),
    ),
  );
  const projection = projectionFixture({ store });
  for (const [offset, keys, ownerCount, nextOffset] of [
    [0, [4, 2, 5], 2, 2],
    [2, [3, 2], 0, 4],
    [4, [1], 0, null],
    [7, [], 0, null],
  ] as const) {
    const opts = { limit: 2, offset, includePeople: true };
    const prepared = prepareSessionRowSelection(projection, opts, { ordered });
    const selected = runSynchronousWork(
      selectSessionEntries({ ...prepared, entriesSorted: ordered, ownerFirstActorId: adaId }),
    );
    expect({
      ...selected,
      entries: selected.entries.map(([key]) => key),
      owners: selected.ownerFacet.map(({ id }) => id),
      people: selected.people?.map(({ identity, sessionCount }) => [identity.id, sessionCount]),
    }).toMatchObject({
      entries: keys.map((id) => `agent:main:page-${id}`),
      totalCount: 5,
      peopleSessionCount: 5,
      ownerCount,
      nextOffset,
      hasMore: nextOffset !== null,
      owners: [adaId, bobId],
      people: [
        [bobId, 3],
        [adaId, 2],
      ],
    });
  }
});

it("reports the age boundary of people outside the selected profile and returned page", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const store = rows({
    selected: entry({ lastActivityAt: now, createdActor: actor(adaId) }),
    "other-person": entry({ lastActivityAt: now - 3_600_000 + 100, createdActor: actor(bobId) }),
    "excluded-dock": entry({ lastActivityAt: now - 3_600_000 + 10, createdSurface: "plugin-dock" }),
    "already-expired": entry({ lastActivityAt: now - 3_600_001 }),
  });
  const opts = { ...activityOpts, activeMinutes: 60, excludeDock: true };
  const read = (query: SessionsListParams = opts) => list(store, query);
  const first = await read();
  expect(first.sessions.map((row) => row.key)).toEqual(["agent:main:selected"]);
  expect(first.activityExpiresAt).toBe(now + 100);
  const selected = { ...opts, involvingProfileId: adaId };
  const person = await read(selected);
  expect(person.activityExpiresAt).toBe(now + 100);
  expect(person.people?.map(({ identity }) => identity.id).toSorted()).toEqual([adaId, bobId]);
  clock.mockReturnValue(now + 100);
  expect((await read(selected)).activityExpiresAt).toBe(now + 100);
  clock.mockReturnValue(now + 101);
  const expired = await read(selected);
  expect(expired.activityExpiresAt).toBe(now + 3_600_000);
  expect(expired.people?.map(({ identity }) => identity.id)).toEqual([adaId]);
  clock.mockReturnValue(now + 3_600_001);
  expect((await read(selected)).activityExpiresAt).toBeUndefined();
  expect((await read({ ...opts, activeMinutes: undefined })).activityExpiresAt).toBeUndefined();
});

it("reuses involvement facts until session replacement or profile publication", () => {
  const identityProjection = sessionIdentity.createSessionIdentityProjection();
  const rowContext = { ...buildSessionListRowMetadataContext({ now: 1 }), identityProjection };
  const profiles = rowContext.userProfileIdentityById;
  const key = "agent:main:involved";
  const state = { profiles: { [mergedAdaId]: { hidden: false, updatedAt: 1 } } };
  const readInvolvement = vi.fn(() => state);
  const original = entry();
  Object.defineProperty(original, "profileInvolvement", { get: readInvolvement, enumerable: true });
  const projection = projectionFixture({ store: { [key]: original }, rowContext });
  const select = (id = adaId) =>
    filteredKeys({
      ...prepareSessionRowSelection(projection, {}, { ordered: true }),
      involvingActorId: id,
    });
  expect(select()).toEqual([key]);
  readInvolvement.mockClear();
  for (let i = 0; i < 3; i++) {
    expect(select()).toEqual([key]);
    expect(select(bobId)).toEqual([]);
  }
  expect(readInvolvement).not.toHaveBeenCalled();

  profiles.set(mergedAdaId, undefined);
  identityProjection.invalidate();
  expect(select()).toEqual([]);
  expect(select(mergedAdaId)).toEqual([key]);
  projection.setEntry(key, {
    ...entry(),
    profileInvolvement: {
      key: "inventory-session",
      profiles: { [mergedAdaId]: { hidden: true, updatedAt: 2 } },
    },
  });
  expect(select(mergedAdaId)).toEqual([]);
});

it("expires cached child owners without a session or registry publication", () => {
  const key = "agent:main:subagent:child";
  const parent = "agent:main:dashboard:parent";
  const projection = projectionFixture({
    store: { [key]: entry({ updatedAt: now, spawnedBy: parent }) },
  });
  const select = (clock: number) =>
    filteredKeys(prepareSessionRowSelection(projection, { spawnedBy: parent }, { now: clock }));
  expect(select(now)).toEqual([key]);
  expect(select(now + 3_600_000)).toEqual([key]);
  expect(select(now + 3_600_001)).toEqual([]);
  expect(select(now)).toEqual([key]);
});

it.each([
  [0, 0],
  [0, 2, 1],
])("rejects non-ascending activity boundaries: %j", async (...activityPulseBoundaries) => {
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
});

it("aggregates the selected time window after person filtering and before pagination", async () => {
  const since = now;
  const activeNow = since + 12 * 3_600_000;
  const activeMinutes = 7 * 24 * 60;
  vi.spyOn(Date, "now").mockReturnValue(activeNow);
  const activity = (
    lastActivityAt: number,
    createdAt: number | undefined,
    ids: string[],
    overrides: Partial<SessionEntry> = {},
  ) => entry({ lastActivityAt, createdAt, participants: people(...ids), ...overrides });
  const ada = [adaId];
  const cutoff = activeNow - activeMinutes * 60_000;
  const hour = 3_600_000;
  const result = await list(
    rows({
      midnight: activity(since, cutoff - 1, ada),
      morning: activity(since + hour, since, [mergedAdaId, bobId], {
        lastInteractionAt: since + 2 * hour,
      }),
      "clock-skew": activity(since + 25 * hour, since + 24 * hour, ada),
      "three-days-ago": activity(since - 3 * 86_400_000, cutoff, [...ada, "profile-earlier"], {
        updatedAt: since + 30 * hour,
      }),
      "outside-window": activity(cutoff - 1, undefined, [...ada, "profile-excluded"]),
      "other-person": activity(since + 5 * hour, since, ["profile-carol"]),
    }),
    {
      ...activityOpts,
      activityPulseBoundaries: Array.from({ length: 25 }, (_, index) => since + index * 3_600_000),
      activeMinutes,
      involvingProfileId: adaId,
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
    const associations: Record<string, (string | undefined)[]> = {
      selected: ["project-one", "/workspace/task"],
      "workspace-root": ["project-one", "/workspace"],
    };
    expect(result.sessions.map((row) => [row.sessionId, row.projectId, row.workspaceDir])).toEqual(
      matches.map((name) => [name, ...(associations[name] ?? [undefined, undefined])]),
    );
    expect(result.totalCount).toBe(matches.length);
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
  const ada = actor(adaId);
  const bob = actor(bobId);
  const agent = { type: "agent" as const, id: adaId };
  const store = rows({
    "agent-owner": { ...owned(agent, agent), participants: people(adaId) },
    "created-only": owned(ada, bob),
    owned: owned(bob, ada),
    "default-owner": { createdActor: ada },
    participating: {
      createdActor: bob,
      participants: people(...Array.from({ length: 5 }, (_, i) => `profile-other-${i}`), adaId),
    },
    "legacy-collision": {
      createdActor: bob,
      participants: [{ identity: { type: "legacy", id: adaId, actorType: "human", source: null } }],
    },
    "agent-collision": { createdActor: bob, participants: [{ identity: agent }] },
    unrelated: { createdActor: actor("profile-carol") },
  });
  const query = { cfg: { agents: { entries: { main: {}, [adaId]: {} } } }, storePath, store };
  const all = await listSessionFixture({ ...query, opts: {} });
  const allOwners = ["agent:profile-ada", "human:profile-bob", "human:profile-carol"];
  const involvingOwners = allOwners.slice(0, 2);
  const involvedKeys = ["agent-owner", "owned", "default-owner", "participating"];
  const associatedKeys = ["agent-owner", "created-only", "owned", "default-owner", "participating"];
  const createdOwners = ["human:profile-ada", "human:profile-bob"];
  const relation = (relationship: "owned" | "created" | "involving"): SessionsListParams => ({
    profileRelation: { profileId: adaId, relationship },
  });
  const involving = relation("involving");
  const cases: [string, SessionsListParams, string[], string[], string?][] = [
    ["owned", relation("owned"), ["owned", "default-owner"], ["human:profile-ada"]],
    ["created", relation("created"), ["created-only", "default-owner"], createdOwners],
    ["involving", { ...involving, includePeople: true }, involvedKeys, involvingOwners],
    ["associated", { involvingProfileId: adaId }, associatedKeys, allOwners],
    ["involvingMe", {}, involvedKeys, allOwners, adaId],
    ["authenticated intersection", involving, ["participating"], involvingOwners, bobId],
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
        [participating?.participants, participating?.expandedParticipants].map((members) =>
          members?.some(({ identity }) => identity.id === adaId),
        ),
      ).toEqual([false, true]);
    }
  }
});
