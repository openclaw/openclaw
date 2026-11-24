import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "./session-capability.test-support.ts";
import type { SessionListSnapshot } from "./session-capability.ts";
import { sessionRow } from "./session-fixtures.test-support.ts";
import { canApplySessionListSnapshot } from "./session-list-query.ts";
import { rosterReadFixture } from "./session-roster-refresh.test-support.ts";

const row = (key: string, extra: Partial<GatewaySessionRow> = {}) =>
  sessionRow(`agent:main:${key}`, { sessionId: `${key}-session`, ...extra });
it.each([
  [200, 60, true],
  [200, 59, false],
  [2, 2, true],
  [2, 1, false],
] as const)(
  "excludes owned ancestors only behind a full prefix (limit=%i, owned=%i)",
  (limit, owned, expected) => {
    const actor = (id: string) =>
      ({ type: "human", id, identity: { type: "profile", id } }) as const;
    const rows = Array.from({ length: limit }, (_, index) =>
      row(`child-${index}`, {
        sessionId: `child-${index}`,
        updatedAt: 1_000 - index,
        owner: { actor: actor(index < owned ? "viewer" : "other") },
        parentSessionKey: "agent:main:main",
      }),
    );
    const parent = row("main", { sessionId: "parent", owner: { actor: actor("viewer") } });
    const canApply = (ancestor: GatewaySessionRow) =>
      canApplySessionListSnapshot(
        { ...sessionsResult(rows, 2_000), hasMore: true, nextOffset: limit },
        {
          reason: "patch",
          session: { ...rows[0], updatedAt: 2_001 },
          ancestorSessions: [ancestor],
        },
        { agentId: "main", limit, ownerFirst: true },
        "updatedAt",
        undefined,
        "viewer",
      );
    expect(canApply(parent)).toBe(expected);
    expect(canApply({ ...parent, updatedAt: 2_002 })).toBe(false);
  },
);

it.each([
  ["unfiltered", "system:maintenance", {}],
  ["excludeSubagents", "subagent:worker", { excludeSubagents: true }],
  ["excludeCron", "cron:scheduled", { excludeCron: true }],
  ["excludeSystem", "system:maintenance", { excludeSystem: true }],
  ["dock-inclusive", "board-agent", { excludeDock: false }],
  ["title-only", "metadata-only", { search: "needle", searchTitlesOnly: true }],
] as const)("keeps list and subscription membership scoped for %s", async (name, key, filter) => {
  const ordinary = row("ordinary", { agentId: "main" });
  const dock = name === "dock-inclusive";
  const excluded = row(key, { isDock: dock });
  const primary = name === "unfiltered";
  let primaryRows = dock ? [ordinary] : [ordinary, excluded];
  const expectedRows = primary ? primaryRows : dock ? [ordinary, excluded] : [ordinary];
  let issued = 0;
  const read = (params?: unknown) => {
    const scoped = Object.entries(filter).every(
      ([field, value]) => asOptionalRecord(params)?.[field] === value,
    );
    return sessionsResult(!primary && scoped ? expectedRows : primaryRows, ++issued);
  };
  const query = { agentId: "main", ...filter };
  const { sessions, watch } = rosterReadFixture(read);
  const updates = vi.fn<(snapshot: SessionListSnapshot) => void>();
  watch(sessions.subscribeList(query, updates));
  const refresh = () => sessions.refresh({ agentId: "main", force: true });
  const tracked = dock ? ordinary : excluded;
  const descriptor = sessions.observeRow({ key: tracked.key, agentId: "main" }, () => {});
  onTestFinished(() => descriptor.dispose());
  await refresh();
  const primaryBefore = sessions.state.result;
  const heldDescriptor = descriptor.row;
  expect(heldDescriptor).toMatchObject(tracked);
  expect(primaryBefore?.sessions).toEqual(primaryRows);
  updates.mockClear();

  const result = await sessions.list(query);
  expect(result?.sessions).toEqual(expectedRows);
  expect(sessions.state.result).toBe(primaryBefore);
  expect(updates).not.toHaveBeenCalled();

  await sessions.refreshList({ ...query, force: true });
  expect(updates.mock.calls.at(-1)?.[0].result?.sessions).toEqual(expectedRows);
  const queryWindow = sessions.listSnapshot(query).result;
  expect(queryWindow?.sessions).toEqual(expectedRows);
  expect(descriptor.isCurrent()).toBe(true);
  expect(descriptor.row).toBe(heldDescriptor);
  expect(sessions.state.result).toBe(primary ? queryWindow : primaryBefore);

  updates.mockClear();
  primaryRows = [...primaryRows, row("later", { agentId: "main" })];
  await refresh();
  expect(sessions.state.result?.sessions).toEqual(primaryRows);
  expect(sessions.listSnapshot(query).result).toBe(primary ? sessions.state.result : queryWindow);
  if (primary) {
    expect(updates.mock.calls.at(-1)?.[0].result).toBe(sessions.state.result);
  } else {
    expect(updates).not.toHaveBeenCalled();
    expect(sessions.listSnapshot(query).result?.sessions).toEqual(expectedRows);
  }
});

it("replaces the retained filtered window when a remote personal pin enters or leaves it", async () => {
  vi.useFakeTimers();
  const query = { source: "sessions-page", agentId: "main", search: "review", limit: 2 } as const;
  const recent = ["newest", "second", "third", "fourth", "oldest"].map((name, i) =>
    row(name, { label: `Review ${name}`, updatedAt: 10 - i }),
  );
  const outside = recent[4]!;
  let pinned = false;
  const windowReads: number[] = [];
  const { sessions, watch, listRows, emitEvent } = rosterReadFixture((params) => {
    if (params.agentId !== query.agentId || params.search !== query.search) {
      return sessionsResult([row("unfiltered-only")]);
    }
    const offset = params.offset ?? 0;
    const limit = params.limit!;
    windowReads.push(limit);
    const ordered = pinned ? [{ ...outside, pinned: true }, ...recent.slice(0, 4)] : recent;
    return {
      ...sessionsResult(ordered.slice(offset, offset + limit)),
      totalCount: 5,
      hasMore: offset + limit < 5,
      nextOffset: offset + limit < 5 ? offset + limit : null,
    };
  }, "viewer-alias");
  const notify = (key: string) =>
    emitEvent({
      type: "event",
      event: "users.prefs.changed",
      payload: { profileId: "viewer", keys: [key] },
    });
  watch(query);
  await sessions.refreshList(query);
  await sessions.refreshList({ ...query, append: true, offset: 2 });
  const initial = recent.slice(0, 4);
  expect(listRows(query)).toEqual(initial);

  notify("ui.theme");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(windowReads).toEqual([2, 2]);
  pinned = true;
  notify("ui.railShortcuts");
  notify("ui.railShortcuts");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(listRows(query)).toEqual([{ ...outside, pinned: true }, ...initial.slice(0, 3)]);
  pinned = false;
  notify("ui.railShortcuts");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(listRows(query)).toEqual(initial);
  expect(windowReads).toEqual([2, 2, 4, 4]);
});

it.each([
  ["sidebar", {}],
  ["sessions-page", { search: "review" }],
] as const)(
  "admits an off-window pin on the %s Gateway deadline without an event",
  async (source, filter) => {
    vi.useFakeTimers();
    const query = { source, agentId: "main", limit: 2, ...filter };
    const saved = row("saved", { pinned: true });
    const active = row("recent");
    const returning = row("old-review", { pinned: true });
    const reads: number[] = [];
    const { sessions, watch, listRows } = rosterReadFixture((params) => {
      if (
        params.agentId !== query.agentId ||
        params.search !== ("search" in filter ? filter.search : undefined)
      ) {
        return sessionsResult([]);
      }
      reads.push(params.limit!);
      const now = 10_000 + Math.floor(performance.now()); // Independent of the client's wall clock.
      return {
        ...sessionsResult(now > 10_100 ? [saved, returning] : [saved, active], now),
        hasMore: true,
        totalCount: 3,
        ...(now <= 10_100 ? { activityExpiresAt: 10_100 } : {}),
      };
    });
    watch(query);
    await sessions.refreshList(query);
    expect(listRows(query)).toEqual([saved, active]);
    await vi.advanceTimersByTimeAsync(100);
    expect(reads).toEqual([2]); // Still valid at the inclusive boundary.
    await vi.advanceTimersByTimeAsync(2);
    expect(listRows(query)).toEqual([saved, returning]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toEqual([2, 2]);
  },
);

it("does not wake an unmounted query or reuse a retired primary deadline after a failed switch", async () => {
  vi.useFakeTimers();
  const { sessions, watch, request } = rosterReadFixture((params) => {
    if (params.agentId === "other") {
      throw new Error("New roster unavailable");
    }
    return { ...sessionsResult([row("held")], 1), hasMore: true, activityExpiresAt: 500 };
  });
  const primary = { agentId: "main" };
  const filtered = { ...primary, search: "review" };
  const stop = watch(filtered);
  await sessions.refreshList(primary);
  await sessions.refreshList(filtered);
  stop();
  await sessions.refreshList({ agentId: "other" });
  expect(sessions.state.error).toContain("New roster unavailable");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(request).toHaveBeenCalledTimes(3);
});
