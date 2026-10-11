// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { sessionActivityTimestamp } from "../../../../src/shared/session-activity-timestamp.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { activityPersonFromPath } from "../../app-route-paths.ts";
import { useSessionActivityControllerFixture } from "./session-activity-controller.test-support.ts";
import {
  parseSessionActivityFilters,
  canonicalSessionActivityLocation,
  projectSessionActivity,
  sessionActivityLocation,
} from "./session-activity.ts";

const { active, listing, setup } = useSessionActivityControllerFixture();

const people: NonNullable<SessionsListResult["people"]> = [
  { identity: { type: "profile", id: "alice" }, label: "Alice", sessionCount: 12 },
  { identity: { type: "profile", id: "bob" }, label: "Bob", sessionCount: 3 },
];
function result(sessions: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: sessions.length,
    totalCount: 12,
    peopleSessionCount: 15,
    people,
    defaults: { model: null, modelProvider: null, contextTokens: null },
    sessions,
  };
}

describe("session activity projection", () => {
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
    const rows: GatewaySessionRow[] = [
      {
        key: "agent:main:first",
        kind: "direct",
        updatedAt: now + 60_000,
        lastActivityAt: now - 26 * 60 * 60_000,
        lastInteractionAt: now,
        participants: [{ identity: { type: "agent", id: "bob" } }],
      },
      {
        key: "agent:main:second",
        kind: "direct",
        updatedAt: now - 26 * 60 * 60_000,
        lastActivityAt: now - 60_000,
      },
      {
        key: "agent:main:older",
        kind: "direct",
        updatedAt: now,
        lastActivityAt: now - 26 * 60 * 60_000,
      },
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
    expect(activity.matchedCount).toBe(12);
    expect(activity.timeCount).toBe(15);
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
    { lastActivityAt: 0, updatedAt: 0, createdAt: 120 },
    { lastActivityAt: 120, lastInteractionAt: Number.NaN, updatedAt: 200 },
    { lastActivityAt: -1, lastInteractionAt: 120, updatedAt: 200 },
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

it.each(["primary", "ancestor-omitted", "ancestor-cleared"])(
  "retains Activity recap receipts and ordering until a backwards activity clock requires admission (%s)",
  async (summary) => {
    vi.useFakeTimers();
    const { client, request, controller } = setup();
    const first = {
      ...active,
      lastActivityAt: 200,
      ...(summary === "primary" ? {} : { parentSessionKey: "agent:work:second" }),
    };
    const second = {
      ...active,
      key: "agent:work:second",
      sessionId: "second-session",
      lastActivityAt: 100,
      ...(summary === "primary" ? {} : { childSessions: [first.key] }),
      activitySummary: { state: "current" as const, text: "The cached recap." },
    };
    request.mockResolvedValue(listing([first, second]));
    await controller.load(client, { personId: null, time: "all", query: "" });
    const { activitySummary, ...snapshot } = second;
    const event = (lastActivityAt: number, updatedAt: number) => {
      const changed = {
        ...snapshot,
        lastActivityAt,
        updatedAt,
        ...(summary === "ancestor-cleared" ? { activitySummary: null } : {}),
      };
      return {
        agentId: active.agentId,
        reason: "patch",
        session:
          summary === "primary"
            ? changed
            : {
                ...first,
                updatedAt,
                activitySummary: { state: "current", text: "The child's new recap." },
              },
        ancestorSessions: summary === "primary" ? [] : [changed],
      };
    };
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
  vi.useFakeTimers();
  const { client, request, controller } = setup();
  const parent = {
    ...active,
    key: "agent:work:parent",
    sessionId: "parent-session",
    label: "Old parent",
    childSessions: ["agent:work:subagent:child"],
    snapshotAt: 100,
  };
  const child = {
    ...active,
    key: "agent:work:subagent:child",
    parentSessionKey: parent.key,
    snapshotAt: 100,
  };
  const initial = listing([parent]);
  request.mockResolvedValue(initial);
  const query = { personId: null, time: "all" as const, query: "" };
  await controller.load(client, query);
  controller.invalidate({
    agentId: active.agentId,
    session: { ...child, updatedAt: 300, snapshotAt: 300 },
    ancestorSessions: [
      {
        ...parent,
        label: "Updated parent",
        updatedAt: 300,
        snapshotAt: 300,
        ancestorRevision: "parent-revision",
      },
    ],
  });
  expect(controller.result?.sessions.map((row) => [row.key, row.label])).toEqual([
    [parent.key, "Updated parent"],
  ]);
  const reference = (snapshotAt: number) => ({
    agentId: active.agentId,
    session: { ...child, updatedAt: snapshotAt, snapshotAt },
    ancestorSessions: [],
    ancestorSessionRefs: [
      {
        key: parent.key,
        sessionId: parent.sessionId,
        revision: "parent-revision",
        snapshotAt,
      },
    ],
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

it.each([
  "excluded",
  "excluded-chain",
  "unheld",
  "missing",
  "scoped-out-parent",
  "incomplete",
  "uncertified-reference",
])(
  "requires History authority only for relevant incomplete child coverage (%s)",
  async (coverage) => {
    vi.useFakeTimers();
    const { client, request, controller } = setup();
    const childKey = "agent:work:subagent:child";
    const excluded =
      coverage === "excluded" || coverage === "excluded-chain" || coverage === "scoped-out-parent";
    const parent = {
      ...active,
      key: coverage === "excluded-chain" ? "agent:work:subagent:parent" : "agent:work:parent",
      sessionId: "parent-session",
      childSessions: [childKey],
      snapshotAt: 100,
    };
    const rows = excluded || coverage === "unheld" ? [] : [parent];
    request.mockResolvedValue(listing(rows));
    await controller.load(client, { personId: null, time: "all", query: "" });
    controller.invalidate({
      agentId: active.agentId,
      session: {
        ...active,
        key: childKey,
        sessionId: "child-session",
        updatedAt: 200,
        snapshotAt: 200,
        ...(coverage === "excluded" ? {} : { spawnedBy: parent.key }),
      },
      ...(coverage === "incomplete"
        ? {}
        : {
            ancestorSessions:
              coverage === "unheld" || coverage === "excluded-chain"
                ? [{ ...parent, updatedAt: 200, snapshotAt: 200 }]
                : [],
            ...(coverage === "uncertified-reference"
              ? {
                  ancestorSessionRefs: [
                    {
                      key: parent.key,
                      sessionId: parent.sessionId,
                      revision: "unseen-parent-revision",
                      snapshotAt: 200,
                    },
                  ],
                }
              : {}),
          }),
    });
    expect(controller.result?.sessions).toEqual(rows);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(excluded ? 1 : 2);
  },
);
