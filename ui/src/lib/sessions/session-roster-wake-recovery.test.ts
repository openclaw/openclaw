import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { sessionsResult } from "./session-capability.test-support.ts";
import { sessionRow } from "./session-fixtures.test-support.ts";
import { advance, rosterReadFixture } from "./session-roster-refresh.test-support.ts";

const saved = sessionRow("agent:main:saved", { pinned: true });
const recent = sessionRow("agent:main:recent");
const returning = sessionRow("agent:main:returning", { pinned: true });
const held = {
  ...sessionsResult([saved, recent], 10_000),
  totalCount: 3,
  hasMore: true,
  activityExpiresAt: 10_100,
};
const restored = { ...sessionsResult([saved, returning], 10_102), totalCount: 3, hasMore: true };
const owners = [
  { source: "sidebar", agentId: "main", limit: 2 },
  { source: "sessions-page", agentId: "main", limit: 2, search: "review" },
] as const;
const unavailable = new GatewayRequestError({
  code: "UNAVAILABLE",
  message: "Window busy",
  retryable: true,
  retryAfterMs: 7_000,
});

beforeEach(() => vi.useFakeTimers());

const failingWake = () => vi.fn().mockReturnValueOnce(held).mockRejectedValueOnce(unavailable);

it("restores a loaded saved pin at its remotely shortened snooze deadline", async () => {
  vi.setSystemTime(0);
  let snoozedUntil = 3_600_000;
  const row = () => ({ ...saved, snoozedUntil, pinned: Date.now() >= snoozedUntil });
  const { sessions, watch, listRows, emitEvent } = rosterReadFixture(
    () => ({
      ...sessionsResult([row()], Date.now()),
      activityExpiresAt: Date.now() < snoozedUntil ? snoozedUntil - 1 : undefined,
    }),
    "viewer",
  );
  const query = owners[0];
  watch(query);
  await sessions.refreshList(query);
  snoozedUntil = 120_000;
  emitEvent({
    type: "event",
    event: "sessions.changed",
    payload: { reason: "patch", session: row(), ancestorSessions: [] },
  });
  await advance(119_999);
  expect(listRows(query)?.[0]).toMatchObject({ snoozedUntil, pinned: false });
  await advance(2);
  expect(listRows(query)?.[0]?.pinned).toBe(true);
});

it.each(owners)(
  "recovers the mounted $source window once after its wake read fails",
  async (query) => {
    const read = failingWake().mockReturnValue(restored);
    const { sessions, watch, listRows } = rosterReadFixture(read);
    watch(query);
    watch(query); // A second consumer of the same window is not a second retry owner.
    await sessions.refreshList(query);
    await advance(102);
    expect(read).toHaveBeenCalledTimes(2);
    expect(listRows(query)).toEqual([saved, recent]);
    expect(sessions.listSnapshot(query).error).toContain("Window busy");
    await advance(6_999);
    expect(read).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(listRows(query)).toEqual([saved, returning]);
    expect(sessions.listSnapshot(query).error).toBeNull();
    await advance(120_000);
    expect(read).toHaveBeenCalledTimes(3);
  },
);

it.each([
  [unavailable, 3],
  [new GatewayRequestError({ code: "UNAVAILABLE", message: "No retry", retryable: false }), 2],
  [new GatewayRequestError({ code: "FORBIDDEN", message: "Not permitted", retryable: true }), 2],
] as const)(
  "stops automatic reads for a persistent $message error but accepts an explicit recovery",
  async (error, expectedReads) => {
    const read = vi.fn().mockReturnValueOnce(held).mockRejectedValue(error);
    const { sessions, watch, listRows } = rosterReadFixture(read);
    const query = owners[1];
    watch(query);
    await sessions.refreshList(query);
    await advance(120_000);
    expect(read).toHaveBeenCalledTimes(expectedReads);
    expect(listRows(query)).toEqual([saved, recent]);
    expect(sessions.listSnapshot(query).error).toContain(error.message);
    read.mockReturnValue(restored);
    await sessions.refreshList({ ...query, force: true });
    expect(listRows(query)).toEqual([saved, returning]);
  },
);

it.each(owners)(
  "retains only the outstanding cutoff across overlapping $source reads",
  async (query) => {
    const same = createDeferred<SessionsListResult>();
    const newer = createDeferred<SessionsListResult>();
    const secondCutoff = { ...held, ts: 10_102, activityExpiresAt: 19_000 };
    const read = vi
      .fn()
      .mockReturnValueOnce(held)
      .mockReturnValueOnce(same.promise)
      .mockReturnValueOnce(secondCutoff)
      .mockReturnValueOnce(newer.promise)
      .mockReturnValue(restored);
    const { sessions, watch, resolveOnCleanup, listRows } = rosterReadFixture(read);
    watch(query);
    resolveOnCleanup([same, held], [newer, restored]);
    const replace = () => sessions.refreshList({ ...query, force: true });
    await replace();
    const beforeExpiry = replace();
    await advance(102);
    expect(read).toHaveBeenCalledTimes(2);
    same.resolve(held); // Sampled before the cutoff, delivered after: still needs a wake.
    await beforeExpiry;
    await advance(5_000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(sessions.listSnapshot(query).result?.activityExpiresAt).toBe(19_000);
    const next = replace();
    await advance(10_000);
    expect(read).toHaveBeenCalledTimes(4);
    newer.resolve({ ...held, ts: 19_103, activityExpiresAt: 29_003 });
    await next;
    await advance(6_000); // Its new receipt supersedes the old, now-due cutoff.
    expect(read).toHaveBeenCalledTimes(4);
    await advance(4_000);
    expect(listRows(query)).toEqual([saved, returning]);
    await advance(120_000);
    expect(read).toHaveBeenCalledTimes(5);
  },
);

it.each(owners)("absorbs a queued $source wake retry on explicit replacement", async (query) => {
  const read = failingWake()
    .mockReturnValueOnce({ ...held, ts: 10_103, activityExpiresAt: 30_103 })
    .mockReturnValue(restored);
  const { sessions, watch, listRows } = rosterReadFixture(read);
  watch(query);
  await sessions.refreshList(query);
  await advance(102);
  await sessions.refreshList({ ...query, force: true });
  await advance(15_000);
  expect(read).toHaveBeenCalledTimes(3);
  expect(listRows(query)).toEqual([saved, recent]);
  await advance(5_002);
  expect(listRows(query)).toEqual([saved, returning]);
  expect(read).toHaveBeenCalledTimes(4);
});

it("does not let a successful append consume a pending full-window retry", async () => {
  const query = owners[1];
  const tail = sessionRow("agent:main:tail");
  const read = failingWake()
    .mockReturnValueOnce({ ...sessionsResult([tail], 10_103), hasMore: false, offset: 2 })
    .mockReturnValue({ ...sessionsResult([saved, returning, recent], 17_102), hasMore: true });
  const { sessions, watch, listRows } = rosterReadFixture(read);
  watch(query);
  await sessions.refreshList(query);
  await advance(102);
  await sessions.refreshList({ ...query, append: true, offset: 2 });
  expect(listRows(query)).toEqual([saved, recent, tail]);
  await advance(7_000);
  expect(listRows(query)).toEqual([saved, returning, recent]);
  expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 3 }));
  await advance(120_000);
  expect(read).toHaveBeenCalledTimes(4);
});

it.each([
  { query: owners[0], activityExpiresAt: undefined },
  { query: owners[1], activityExpiresAt: 20_000 },
])(
  "repairs the held $query.source prefix when Load More crosses its cutoff",
  async ({ query, activityExpiresAt }) => {
    const tail = sessionRow("agent:main:tail");
    const read = vi
      .fn()
      .mockReturnValueOnce({ ...held, totalCount: 4 })
      // The saved pin moved into the prefix, so offset 2 repeats the last held row.
      .mockReturnValueOnce({
        ...sessionsResult([recent, tail], 10_102),
        offset: 2,
        activityExpiresAt,
      })
      .mockReturnValue({ ...sessionsResult([saved, returning, recent], 10_103), totalCount: 4 });
    const { sessions, watch, listRows } = rosterReadFixture(read);
    watch(query);
    await sessions.refreshList(query);
    // Gateway time already crossed the cutoff, but the browser timer hasn't run.
    await sessions.refreshList({ ...query, offset: 2, append: true });
    expect(listRows(query)).toEqual([saved, recent, tail]);
    await advance(102);
    expect(listRows(query)).toEqual([saved, returning, recent]);
    await advance(120_000);
    expect(read.mock.calls.map(([params]) => [params.offset, params.limit])).toEqual([
      [undefined, 2],
      [2, 2],
      [undefined, 3],
    ]);
  },
);

it.each([
  { delivery: 10, wake: 61 },
  { delivery: 90, wake: 101 },
])(
  "honors the first due cutoff when an earlier tail receipt arrives at $delivery ms",
  async ({ delivery, wake }) => {
    const query = owners[1];
    const append = createDeferred<SessionsListResult>();
    const tail = {
      ...sessionsResult([sessionRow(returning.key)], 10_001),
      offset: 2,
      activityExpiresAt: 10_051,
    };
    const repaired = [saved, returning, recent];
    const read = vi
      .fn()
      .mockReturnValueOnce(held)
      .mockReturnValueOnce(append.promise)
      .mockReturnValue(sessionsResult(repaired, 10_103));
    const { sessions, watch, resolveOnCleanup, listRows } = rosterReadFixture(read);
    watch(query);
    resolveOnCleanup([append, tail]);
    await sessions.refreshList(query);
    const more = sessions.refreshList({ ...query, offset: 2, append: true });
    await advance(delivery);
    append.resolve(tail);
    await more;
    await advance(wake - delivery - 1);
    expect(read).toHaveBeenCalledTimes(2);
    await advance(2);
    expect(listRows(query)).toEqual(repaired);
    await advance(120_000);
    expect(read).toHaveBeenCalledTimes(3);
  },
);

it("parks both retries while hidden and catches up only the still-mounted window", async () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const sidebar = failingWake().mockReturnValue(restored);
  const table = vi.fn().mockReturnValueOnce(held).mockRejectedValue(unavailable);
  const { sessions, watch, listRows, settle } = rosterReadFixture((params) =>
    params.search ? table() : sidebar(),
  );
  settle(() => visibility.mockRestore());
  watch(owners[0]);
  const stop = watch(owners[1]);
  await Promise.all(owners.map((query) => sessions.refreshList(query)));
  await advance(102);
  expect([sidebar.mock.calls.length, table.mock.calls.length]).toEqual([2, 2]);
  visibility.mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  await advance(60_000);
  expect([sidebar.mock.calls.length, table.mock.calls.length]).toEqual([2, 2]);
  stop();
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await advance();
  expect(listRows(owners[0])).toEqual([saved, returning]);
  expect(listRows(owners[1])).toBeUndefined();
  await advance(120_000);
  expect([sidebar.mock.calls.length, table.mock.calls.length]).toEqual([3, 2]);
});

it("does not replay a late rejected wake against the newly selected primary roster", async () => {
  const slow = createDeferred<SessionsListResult>();
  const sidebar = vi.fn().mockReturnValueOnce(held).mockReturnValue(slow.promise);
  const otherRows = [sessionRow("agent:other:active")];
  const other = vi.fn(() => sessionsResult(otherRows, 10_103));
  const { sessions, watch, resolveOnCleanup } = rosterReadFixture((params) =>
    params.agentId === "other" ? other() : sidebar(),
  );
  resolveOnCleanup([slow, held]);
  watch(owners[0]);
  await sessions.refreshList(owners[0]);
  await advance(102);
  const switched = sessions.refreshList({ ...owners[0], agentId: "other", force: true });
  slow.reject(unavailable);
  await switched;
  await advance(120_000);
  expect(sessions.state).toMatchObject({
    agentId: "other",
    result: { sessions: otherRows },
    error: null,
  });
  expect([sidebar.mock.calls.length, other.mock.calls.length]).toEqual([2, 1]);
});

it.each(["primary", "observed"] as const)(
  "recovers the late-joining %s owner after the first owner retires",
  async (survivor) => {
    const query = { ...owners[0], rowMode: "sidebar", includeDerivedTitles: true } as const;
    const shared = createDeferred<SessionsListResult>();
    const read = vi
      .fn()
      .mockReturnValueOnce(shared.promise)
      .mockRejectedValueOnce(unavailable)
      .mockReturnValue(restored);
    const other = sessionsResult([sessionRow("agent:other:main")]);
    const { sessions, watch, resolveOnCleanup, settle } = rosterReadFixture((params) =>
      params.agentId === "other" ? other : read(),
    );
    resolveOnCleanup([shared, held]);
    const delivered = vi.fn();
    const observer = sessions.observeList(query, delivered);
    watch(() => observer.dispose());
    const primary = () => sessions.refresh({ ...query, force: true });
    const first = survivor === "primary" ? observer.refresh() : primary();
    const second = survivor === "primary" ? primary() : observer.refresh();
    settle(() => Promise.allSettled([first, second]));
    shared.resolve(held);
    await Promise.all([first, second]);
    expect(read).toHaveBeenCalledOnce();
    if (survivor === "primary") {
      observer.dispose();
      delivered.mockClear();
    } else {
      await sessions.refresh({ ...query, agentId: "other", force: true });
    }
    const snapshot = () => (survivor === "primary" ? sessions.state : delivered.mock.lastCall?.[0]);
    await advance(102);
    expect(snapshot()).toMatchObject({ result: { sessions: held.sessions }, error: "Window busy" });
    await advance(7_000);
    expect(snapshot()).toMatchObject({ result: { sessions: restored.sessions }, error: null });
    await advance(120_000);
    expect(read).toHaveBeenCalledTimes(3);
    if (survivor === "primary") {
      expect(delivered).not.toHaveBeenCalled();
    } else {
      expect(sessions.state).toMatchObject({ agentId: "other", result: other, error: null });
    }
  },
);

it("does not lose the primary wake to an observed transport sampled before the cutoff", async () => {
  const query = { ...owners[0], rowMode: "sidebar", includeDerivedTitles: true } as const;
  const older = createDeferred<SessionsListResult>();
  const read = vi
    .fn()
    .mockReturnValueOnce(held)
    .mockReturnValueOnce(older.promise)
    .mockReturnValue(restored);
  const { sessions, watch, resolveOnCleanup } = rosterReadFixture(read);
  resolveOnCleanup([older, held]);
  await sessions.refresh(query);
  await advance(50);
  const observer = sessions.observeList(query, () => {});
  watch(() => observer.dispose());
  const membership = observer.refresh();
  await advance(52);
  older.resolve(held);
  await membership;
  observer.dispose(); // Its own wake cannot rescue a lost primary wake.
  await advance(5_001);
  expect(sessions.state.result?.sessions).toEqual(restored.sessions);
  await advance(120_000);
  expect(read).toHaveBeenCalledTimes(3);
});

it.each([
  { tailTs: 10_097, repeatTorn: false },
  { tailTs: 10_102, repeatTorn: false },
  { tailTs: 10_102, repeatTorn: true },
])(
  "repairs a batched prefix at its earliest actual cutoff (tail $tailTs, repeated $repeatTorn)",
  async ({ tailTs, repeatTorn }) => {
    const query = { ...owners[1], limit: 4, pageSize: 2 };
    const tail = sessionRow("agent:main:tail");
    const fourth = sessionRow("agent:main:fourth");
    const ordered = [saved, returning, recent, tail];
    const pages: number[][] = [];
    let batch = 0;
    const { sessions, watch, listRows } = rosterReadFixture(({ offset = 0, limit }) => {
      pages.push([offset, limit!]);
      if (offset === 0) {
        batch++;
      }
      const old = batch === 1 || (repeatTorn && batch === 2);
      const ts = old ? (offset === 0 ? held.ts : tailTs) : 10_103;
      const rows = ts <= held.activityExpiresAt ? [saved, recent, tail, fourth] : ordered;
      return {
        ...sessionsResult(rows.slice(offset, offset + limit!), ts),
        ...(old ? { activityExpiresAt: offset === 0 ? held.activityExpiresAt : 20_000 } : {}),
        hasMore: offset === 0,
        nextOffset: offset === 0 ? 2 : null,
        offset,
      };
    });
    watch(query);
    await sessions.refreshList(query);
    const pair = [
      [0, 2],
      [2, 2],
    ];
    expect(pages).toEqual(pair);
    if (tailTs < held.activityExpiresAt) {
      await advance(held.activityExpiresAt - tailTs);
      expect(pages).toEqual(pair); // Inclusive, sampled on the Gateway rather than the renderer.
    }
    await advance(2);
    expect(pages).toEqual([...pair, ...pair]);
    await advance(120_000);
    expect(pages).toEqual([...pair, ...pair]);
    if (repeatTorn) {
      await sessions.refreshList({ ...query, force: true }); // A new explicit read is still admitted.
    }
    expect(listRows(query)).toEqual(ordered);
  },
);

it("retries the signed-in primary's owner-first prefix after Load More", async () => {
  const tail = sessionRow("agent:main:tail");
  const repaired = sessionsResult([saved, returning, recent, tail], 17_103);
  const read = vi
    .fn()
    .mockReturnValueOnce(held)
    .mockReturnValueOnce({ ...sessionsResult([recent, tail], 10_050), offset: 2 })
    .mockRejectedValueOnce(unavailable)
    .mockReturnValue(repaired);
  const { sessions } = rosterReadFixture(read, "viewer");
  await sessions.refresh(owners[0]);
  await sessions.refresh({ ...owners[0], append: true, offset: 2 });
  await advance(102);
  expect(sessions.state.error).toContain("Window busy");
  await advance(7_000);
  expect(sessions.state).toMatchObject({ result: repaired, error: null });
  await advance(120_000);
  expect(
    read.mock.calls.map(([params]) => [
      params.offset ?? 0,
      params.limit,
      Boolean(params.ownerFirst),
    ]),
  ).toEqual([
    [0, 2, true],
    [2, 2, false],
    [0, 4, true],
    [0, 4, true],
  ]);
});

it("wakes the sidebar's own primary agent and retries one failed wake read", async () => {
  const read = vi.fn((_agentId?: string) => sessionsResult([saved, recent], 10_000));
  const { sessions } = rosterReadFixture((params) => read(params.agentId));
  await sessions.refresh(owners[0]);
  await sessions.refresh({ ...owners[0], agentId: "other", force: true });
  const wakeReads = () => read.mock.calls.slice(2).map(([agentId]) => agentId);
  // A later read for another agent owns the primary window; wake the requested agent.
  sessions.wakeList(owners[0]);
  await advance();
  expect(wakeReads()).toEqual(["main"]);
  read.mockImplementationOnce(() => {
    throw unavailable;
  });
  sessions.wakeList(owners[0]);
  await advance();
  expect(wakeReads()).toEqual(["main", "main"]);
  await advance(6_999);
  expect(wakeReads()).toEqual(["main", "main"]);
  await advance(1);
  expect(wakeReads()).toEqual(["main", "main", "main"]);
  expect(sessions.state).toMatchObject({ agentId: "main", error: null });
  await advance(120_000);
  expect(wakeReads()).toHaveLength(3);
});
