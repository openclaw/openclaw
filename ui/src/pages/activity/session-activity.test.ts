// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { sessionActivityTimestamp } from "../../../../src/shared/session-activity-timestamp.js";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { activityPersonFromPath } from "../../app-route-paths.ts";
import { createSessionRowProvenance } from "../../lib/sessions/session-row-provenance.ts";
import { useSessionActivityControllerFixture } from "./session-activity-controller.test-support.ts";
import {
  parseSessionActivityFilters,
  canonicalSessionActivityLocation,
  projectSessionActivity,
  reconcileSessionActivityRead,
  sessionActivityLocation,
  sessionActivityOwner,
} from "./session-activity.ts";

const { active, listing, setup } = useSessionActivityControllerFixture();
const allFilters = { personId: null, time: "all" as const, query: "" };
const eventSnapshot = (session: GatewaySessionRow, ancestorSessions: GatewaySessionRow[] = []) => ({
  agentId: active.agentId,
  session,
  ancestorSessions,
});
const makeRow = (name: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  ...active,
  key: `agent:work:${name}`,
  sessionId: `${name}-session`,
  ...fields,
});
const clockRow = (key: string, lastActivityAt: number) =>
  makeRow(key, { sessionId: key, lastActivityAt, snapshotAt: lastActivityAt });
const at = (session: GatewaySessionRow, timestamp: number) => ({
  ...session,
  updatedAt: timestamp,
  snapshotAt: timestamp,
});
const ancestorRef = (parent: GatewaySessionRow, revision: string, snapshotAt: number) => ({
  key: parent.key,
  sessionId: parent.sessionId,
  revision,
  snapshotAt,
});
async function loaded(sessions: GatewaySessionRow[]) {
  vi.useFakeTimers();
  const fixture = setup();
  fixture.request.mockResolvedValue(listing(sessions));
  await fixture.controller.load(fixture.client, allFilters);
  return fixture;
}

it("orders refreshed membership by the activity timestamps actually displayed", () => {
  const provenance = createSessionRowProvenance();
  const older = clockRow("a", 10);
  const current = { ...older, lastActivityAt: 30, snapshotAt: 30 };
  const other = clockRow("b", 20);
  provenance.observeReadRow(current, 1);
  const read = reconcileSessionActivityRead(
    listing([other, older]),
    listing([current, other]),
    provenance,
    2,
  );
  expect(read.result.sessions.map((row) => [row.key, row.lastActivityAt])).toEqual([
    [current.key, 30],
    [other.key, 20],
  ]);
});

const people: NonNullable<SessionsListResult["people"]> = [
  { identity: { type: "profile", id: "alice" }, label: "Alice", sessionCount: 12 },
  { identity: { type: "profile", id: "bob" }, label: "Bob", sessionCount: 3 },
];
function result(sessions: GatewaySessionRow[]): SessionsListResult {
  return {
    ...listing(sessions),
    ts: 1,
    totalCount: 12,
    peopleSessionCount: 15,
    people,
  };
}

describe("session activity projection", () => {
  it.each(["main", "codex"])("does not invent an avatar for ownerless %s sessions", (agentId) => {
    expect(
      sessionActivityOwner({ key: `agent:${agentId}:main`, kind: "direct", agentId }, null),
    ).toEqual({ id: agentId, name: agentId, avatarUrl: undefined, watchedSessions: [] });
  });

  it("uses the advertised owner's avatar instead of the creator's avatar", () => {
    const agents: AgentsListResult = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main", identity: { avatarUrl: "/avatar/main?roster=1" } }],
    };
    const row: GatewaySessionRow = {
      key: "agent:main:work",
      kind: "direct",
      agentId: "main",
      createdActor: { type: "agent", id: "main", avatarUrl: "/avatar/main?v=1" },
      owner: { actor: { type: "agent", id: "codex", label: "Codex" } },
    };
    expect(sessionActivityOwner(row, agents).avatarUrl).toBeUndefined();
    row.owner!.actor.avatarUrl = "/avatar/codex?v=2";
    expect(sessionActivityOwner(row, agents).avatarUrl).toBe("/avatar/codex?v=2");
    delete row.owner;
    expect(sessionActivityOwner(row, agents).avatarUrl).toBe("/avatar/main?v=1");
  });

  it("refreshes decorative names while retaining exact references, longer prefixes, filters and anchors", () => {
    const personId = "12345678-abcd-4123-8123-123456789abc";
    const legacy = {
      pathname: "/ui/activity",
      search: `?person=${personId}&time=30d&q=release`,
      hash: "#sessions",
    };
    expect(canonicalSessionActivityLocation(legacy, personId, "Ada Lovelace", "/ui")).toEqual({
      pathname: "/ui/activity/ada-lovelace-12345678abcd41238123123456789abc",
      search: "?time=30d&q=release",
      hash: "#sessions",
    });
    for (const reference of [
      "12345678",
      "12345678abcd4123",
      personId,
      personId.replaceAll("-", ""),
    ]) {
      const location = { ...legacy, pathname: `/ui/activity/${reference}`, search: "?q=none" };
      expect(canonicalSessionActivityLocation(location, personId, "Ada", "/ui")?.pathname).toBe(
        `/ui/activity/ada-${reference.replaceAll("-", "")}`,
      );
    }
    const empty = { pathname: "/ui/activity/ada-12345678abcd", search: "?q=none", hash: "" };
    expect(canonicalSessionActivityLocation(empty, "12345678abcd", undefined, "/ui")).toBeNull();
    expect(
      canonicalSessionActivityLocation(legacy, "abcdef12-1234-4123-8123-123456789abc", "Ada", "/ui")
        ?.pathname,
    ).toBe("/ui/activity/ada-abcdef12123441238123123456789abc");
  });

  it("groups the server page without treating its preview or session clock as personal history", () => {
    const now = new Date(2026, 7, 17, 12).getTime();
    const yesterday = now - 26 * 60 * 60_000;
    const historyRow = (
      name: string,
      updatedAt: number,
      lastActivityAt: number,
    ): GatewaySessionRow => ({
      key: `agent:main:${name}`,
      kind: "direct",
      updatedAt,
      lastActivityAt,
    });
    const rows: GatewaySessionRow[] = [
      {
        ...historyRow("first", now + 60_000, yesterday),
        lastInteractionAt: now,
        participants: [{ identity: { type: "agent", id: "bob" } }],
      },
      historyRow("second", yesterday, now - 60_000),
      historyRow("older", now, yesterday),
    ];
    Object.freeze(rows);
    const activity = projectSessionActivity(result(rows));
    expect(activity.people.map(({ id, count }) => ({ id, count }))).toEqual([
      { id: "alice", count: 12 },
      { id: "bob", count: 3 },
    ]);
    expect(activity.people.every((person) => !("lastActiveAt" in person))).toBe(true);
    expect(activity.days.map((day) => day.sessions.map((row) => row.key))).toEqual([
      ["agent:main:first", "agent:main:second"],
      ["agent:main:older"],
    ]);
    expect(activity).toMatchObject({ matchedCount: 12, timeCount: 15 });
    expect(activity.sessions).toBe(rows);
    expect(activity.sessions.map(sessionActivityTimestamp)).toEqual([
      now,
      now - 60_000,
      now - 26 * 60 * 60_000,
    ]);
  });

  it.each([
    { lastActivityAt: 0, lastInteractionAt: Number.NaN, updatedAt: 120, createdAt: 100 },
    { lastActivityAt: Number.POSITIVE_INFINITY, updatedAt: null, createdAt: 120 },
  ])("uses known clocks for Activity ages when a stored timestamp is invalid: %j", (clocks) => {
    expect(sessionActivityTimestamp(clocks)).toBe(120);
  });

  it("does not infer people from unqualified owner or participant IDs", () => {
    const page = result([
      {
        key: "agent:main:channel",
        kind: "direct",
        createdActor: { type: "human", id: "alice" },
        participants: [
          { identity: { type: "legacy", actorType: "human", source: "channel", id: "bob" } },
        ],
      },
    ]);
    page.people = [];
    expect(projectSessionActivity(page).people).toEqual([]);
    expect(projectSessionActivity(undefined).sessions).toEqual([]);
  });

  it("round-trips person paths and query filters under a mounted base path", () => {
    const filters = { personId: "profile/a", query: "release notes", time: "30d" as const };
    const { pathname, search } = sessionActivityLocation(filters, "/ui");
    expect(pathname).toBe("/ui/activity/profile%2Fa");
    expect(search).toBe("?time=30d&q=release+notes");
    expect(parseSessionActivityFilters(search, activityPersonFromPath(pathname, "/ui"))).toEqual(
      filters,
    );
    expect(sessionActivityLocation({ ...filters, personId: null }, "/ui").pathname).toBe(
      "/ui/activity",
    );
  });
});

it.each(["ancestor-omitted", "ancestor-cleared"])(
  "retains Activity recap receipts and ordering until a backwards activity clock requires admission (%s)",
  async (summary) => {
    const first = makeRow("release", {
      lastActivityAt: 200,
      parentSessionKey: "agent:work:second",
    });
    const second = makeRow("second", {
      lastActivityAt: 100,
      childSessions: [first.key],
      activitySummary: { state: "current" as const, text: "The cached recap." },
    });
    const { request, controller } = await loaded([first, second]);
    const { activitySummary, ...snapshot } = second;
    const event = (lastActivityAt: number, updatedAt: number) => ({
      ...eventSnapshot(
        {
          ...first,
          updatedAt,
          activitySummary: { state: "current", text: "The child's new recap." },
        },
        [
          {
            ...snapshot,
            lastActivityAt,
            updatedAt,
            ...(summary === "ancestor-cleared" ? { activitySummary: null } : {}),
          },
        ],
      ),
      reason: "patch",
    });
    controller.invalidate(event(300, 300));
    expect(controller.result?.sessions.map((row) => row.key)).toEqual([second.key, first.key]);
    expect(controller.result?.sessions[0]?.activitySummary).toEqual(
      summary === "ancestor-cleared" ? undefined : activitySummary,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(1);
    controller.invalidate(event(50, 400));
    expect(controller.result?.sessions[0]?.lastActivityAt).toBe(300);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(2);
  },
);

it("applies excluded child events to held History ancestors without refetching", async () => {
  const parent = makeRow("parent", {
    label: "Old parent",
    childSessions: ["agent:work:subagent:child"],
    snapshotAt: 100,
  });
  const child = makeRow("subagent:child", {
    sessionId: active.sessionId,
    parentSessionKey: parent.key,
    snapshotAt: 100,
  });
  const { request, controller } = await loaded([parent]);
  controller.invalidate(
    eventSnapshot(at(child, 300), [
      {
        ...at(parent, 300),
        label: "Updated parent",
        ancestorRevision: "parent-revision",
      },
    ]),
  );
  expect(controller.result?.sessions.map((row) => [row.key, row.label])).toEqual([
    [parent.key, "Updated parent"],
  ]);
  const reference = (snapshotAt: number) => ({
    ...eventSnapshot(at(child, snapshotAt)),
    ancestorSessionRefs: [ancestorRef(parent, "parent-revision", snapshotAt)],
  });
  controller.invalidate(reference(400));
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.result?.sessions.find((row) => row.key === parent.key)?.label).toBe(
    "Updated parent",
  );
  controller.invalidate(reference(500));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(controller.result?.sessions.find((row) => row.key === parent.key)?.label).toBe(
    "Updated parent",
  );
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(["excluded-chain", "unheld", "missing", "incomplete", "uncertified-reference"])(
  "requires History authority only for relevant incomplete child coverage (%s)",
  async (coverage) => {
    const childKey = "agent:work:subagent:child";
    const excluded = coverage === "excluded-chain";
    const parent = makeRow("parent", {
      key: excluded ? "agent:work:subagent:parent" : "agent:work:parent",
      childSessions: [childKey],
      snapshotAt: 100,
    });
    const rows = excluded || coverage === "unheld" ? [] : [parent];
    const { request, controller } = await loaded(rows);
    const session = at(makeRow("child", { key: childKey, spawnedBy: parent.key }), 200);
    const ancestorSessions = excluded || coverage === "unheld" ? [at(parent, 200)] : [];
    const ancestorSessionRefs = [ancestorRef(parent, "unseen-parent-revision", 200)];
    controller.invalidate({
      ...eventSnapshot(session),
      ...(coverage === "incomplete" ? { ancestorSessions: undefined } : { ancestorSessions }),
      ...(coverage === "uncertified-reference" ? { ancestorSessionRefs } : {}),
    });
    expect(controller.result?.sessions).toEqual(rows);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(excluded ? 1 : 2);
  },
);
