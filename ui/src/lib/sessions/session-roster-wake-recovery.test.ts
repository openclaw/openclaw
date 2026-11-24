import { expect, it, vi } from "vitest";
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

it.each(owners)(
  "recovers the mounted $source window once after its wake read fails",
  async (query) => {
    vi.useFakeTimers();
    const read = vi
      .fn()
      .mockReturnValueOnce(held)
      .mockRejectedValueOnce(unavailable)
      .mockReturnValue(restored);
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
    vi.useFakeTimers();
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
    vi.useFakeTimers();
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
  vi.useFakeTimers();
  const read = vi
    .fn()
    .mockReturnValueOnce(held)
    .mockRejectedValueOnce(unavailable)
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
  vi.useFakeTimers();
  const query = owners[1];
  const tail = sessionRow("agent:main:tail");
  const read = vi
    .fn()
    .mockReturnValueOnce(held)
    .mockRejectedValueOnce(unavailable)
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

it("parks both retries while hidden and catches up only the still-mounted window", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const sidebar = vi
    .fn()
    .mockReturnValueOnce(held)
    .mockRejectedValueOnce(unavailable)
    .mockReturnValue(restored);
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
  vi.useFakeTimers();
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
