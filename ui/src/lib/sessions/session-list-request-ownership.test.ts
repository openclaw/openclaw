// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createSubscriptionHydrationHarness,
  sessionsResult,
} from "./session-capability.test-support.ts";
import { listRequest, rosterFixture } from "./session-roster-refresh.test-support.ts";
import type { SessionListScope, SessionListSnapshot } from "./session-types.ts";

const query = {
  agentId: "main",
  rowMode: "sidebar",
  source: "sidebar",
  includeDerivedTitles: true,
  includeLastMessage: true,
  limit: 50,
} as const satisfies SessionListScope;
const row = { key: "agent:main:example", sessionId: "example", kind: "direct" } as const;

it("retains an explicit query result until its last subscriber leaves", async () => {
  const result = sessionsResult([row]);
  const request = vi.fn().mockResolvedValue(result);
  const { sessions } = rosterFixture(request);
  const scope = { ...query, ownerId: "viewer" };
  await sessions.refreshList(scope);
  expect(sessions.listSnapshot(scope).result).toEqual(result);
  const unsubscribe = sessions.subscribeList(scope, () => {});
  expect(sessions.listSnapshot(scope).result).toEqual(result);
  expect(request).toHaveBeenCalledOnce();
  unsubscribe();
  expect(sessions.listSnapshot(scope).result).toBeNull();
});

it.each([
  { name: "primary first", observedFirst: false, scope: {}, reads: 1 },
  { name: "observed first", observedFirst: true, scope: {}, reads: 1 },
  { name: "another source", observedFirst: false, scope: { source: "chat-pane" }, reads: 1 },
  { name: "another limit", observedFirst: false, scope: { limit: 25 }, reads: 2 },
  { name: "another filter", observedFirst: false, scope: { ownerId: "viewer" }, reads: 2 },
  { name: "another row shape", observedFirst: false, scope: { rowMode: "compact" }, reads: 2 },
  {
    name: "another enrichment",
    observedFirst: false,
    scope: { includeLastMessage: false },
    reads: 2,
  },
  { name: "another page size", observedFirst: false, scope: { pageSize: 20 }, reads: 2 },
] satisfies Array<{
  name: string;
  observedFirst: boolean;
  scope: SessionListScope;
  reads: number;
}>)(
  "shares only the admitted primary/observed query: $name",
  async ({ observedFirst, scope, reads }) => {
    const pending = createDeferred<SessionsListResult>();
    const result = sessionsResult([row]);
    const request = vi.fn().mockReturnValue(pending.promise);
    const { sessions, watch, resolveOnCleanup, settle } = rosterFixture(request);
    resolveOnCleanup([pending, result]);
    const snapshots: SessionListSnapshot[] = [];
    const observed = sessions.observeList({ ...query, ...scope }, (snapshot) =>
      snapshots.push(snapshot),
    );
    watch(() => observed.dispose());
    const startPrimary = () => sessions.refresh({ ...query, force: true });
    const first = observedFirst ? observed.refresh() : startPrimary();
    const second = observedFirst ? startPrimary() : observed.refresh();
    settle(() => Promise.all([first, second]));
    pending.resolve(result);
    await Promise.all([first, second]);
    expect(request).toHaveBeenCalledTimes(reads);
    expect(sessions.state).toMatchObject({ agentId: "main", result, loading: false, error: null });
    expect(snapshots.at(-1)).toMatchObject({
      result,
      loading: false,
      error: null,
      readSucceeded: true,
    });
  },
);

it("settles the primary attempt before an observed trailing read and keeps its error local", async () => {
  const first = createDeferred<SessionsListResult>();
  const trailing = createDeferred<SessionsListResult>();
  const result = sessionsResult([row], 1);
  const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValue(trailing.promise);
  const { sessions, watch, resolveOnCleanup, settle } = rosterFixture(request);
  resolveOnCleanup([first, result], [trailing, result]);
  let refreshAgain = true;
  let reentrant: Promise<void> | undefined;
  const observed = sessions.observeList(query, (snapshot) => {
    if (snapshot.result && !snapshot.loading && refreshAgain) {
      refreshAgain = false;
      reentrant = observed.refresh();
      void reentrant.catch(() => {});
    }
  });
  watch(() => observed.dispose());
  const primary = sessions.refresh({ ...query, force: true });
  const membershipSettled = vi.fn();
  const membership = observed.refresh().then(membershipSettled);
  void membership.catch(() => {});
  settle(() => Promise.allSettled([primary, membership, reentrant]));
  first.resolve(result);
  await primary;
  expect(request).toHaveBeenCalledTimes(2);
  expect(membershipSettled).not.toHaveBeenCalled();
  expect(sessions.state).toMatchObject({ result, loading: false, error: null });
  trailing.reject(new Error("Observed membership unavailable"));
  await expect(membership).rejects.toThrow("Observed membership unavailable");
  await expect(reentrant).rejects.toThrow("Observed membership unavailable");
  expect(sessions.canonicalListError).toBeNull();
  expect(sessions.state.result).toEqual(result);
});

it("keeps a primary read available through unsubscribe and resubscribe", async () => {
  const pending = createDeferred<SessionsListResult>();
  const result = sessionsResult([row]);
  const request = vi.fn().mockReturnValue(pending.promise);
  const { sessions, watch, resolveOnCleanup, settle } = rosterFixture(request);
  resolveOnCleanup([pending, result]);
  const retired = sessions.observeList(query, () => {});
  const primary = sessions.refresh({ ...query, force: true });
  retired.dispose();
  const delivered = vi.fn();
  const replacement = sessions.observeList(query, delivered);
  watch(() => replacement.dispose());
  const membership = replacement.refresh();
  settle(() => Promise.all([primary, membership]));
  expect(request).toHaveBeenCalledOnce();
  pending.resolve(result);
  await Promise.all([primary, membership]);
  expect(sessions.state.result).toEqual(result);
  expect(delivered).toHaveBeenLastCalledWith(expect.objectContaining({ result, loading: false }));
});

it("retires slow primary publication without retiring its observed query", async () => {
  vi.useFakeTimers();
  const writer = createDeferred<SessionsListResult>();
  const mainResult = sessionsResult([{ ...row, key: "agent:main:main" }]);
  const writerResult = sessionsResult([{ ...row, key: "agent:writer:main", sessionId: "writer" }]);
  const reads: Array<string | undefined> = [];
  const request = listRequest<{ agentId?: string }>((params) => {
    reads.push(params?.agentId);
    return params?.agentId === "writer" ? writer.promise : mainResult;
  });
  const { sessions, selection, connect } = createSubscriptionHydrationHarness(request);
  let observed: ReturnType<typeof sessions.observeList> | undefined;
  let membership: Promise<void> | undefined;
  try {
    connect();
    await vi.advanceTimersByTimeAsync(0);
    selection.set("writer");
    const delivered = vi.fn();
    observed = sessions.observeList({ ...query, agentId: "writer", limit: undefined }, delivered);
    membership = observed.refresh();
    expect(reads).toEqual(["main", "writer"]);
    selection.set("main");
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.state.agentId).toBe("main");
    writer.resolve(writerResult);
    await membership;
    expect(reads).toEqual(["main", "writer", "main"]);
    expect(sessions.state).toMatchObject({ agentId: "main", result: mainResult });
    expect(delivered).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentId: "writer", result: writerResult, loading: false }),
    );
  } finally {
    writer.resolve(writerResult);
    await membership;
    observed?.dispose();
    sessions.dispose();
    selection.dispose();
    vi.useRealTimers();
  }
});

it.each(["primary", "observed"] as const)(
  "does not satisfy a mutation with the older %s read",
  async (firstOwner) => {
    vi.useFakeTimers();
    const before = createDeferred<SessionsListResult>();
    const fresh = createDeferred<SessionsListResult>();
    const accepted = createDeferred();
    const created = { ...row, key: "agent:main:created", sessionId: "created", updatedAt: 2 };
    const original = { ...row, permissionMode: "guarded" as const, updatedAt: 1 };
    const initial = sessionsResult([original], 1);
    const updated = sessionsResult([created, original], 2);
    let hold = false;
    let committed = false;
    let reads = 0;
    const client = createTestGatewayClient(async (method) => {
      if (method === "sessions.create" || method === "sessions.patch") {
        committed = true;
        accepted.resolve();
        return method === "sessions.create"
          ? { key: created.key, entry: created }
          : {
              ok: true,
              key: row.key,
              entry: { ...original, permissionMode: "workspace", updatedAt: 2 },
            };
      }
      expect(method).toBe("sessions.list");
      reads++;
      return hold ? (committed ? fresh.promise : before.promise) : initial;
    });
    const { sessions, watch, resolveOnCleanup, settle } = rosterFixture(
      client.request.bind(client),
    );
    resolveOnCleanup([before, initial], [fresh, updated]);
    const delivered = vi.fn();
    const observed = sessions.observeList(query, delivered);
    watch(() => observed.dispose());
    await sessions.refresh({ ...query, force: true });
    await observed.refresh();
    hold = true;
    const pending =
      firstOwner === "primary" ? sessions.refresh({ ...query, force: true }) : observed.refresh();
    void pending.catch(() => {});
    const settled = vi.fn();
    const mutation = (
      firstOwner === "primary"
        ? sessions.createResult({ agentId: "main" })
        : sessions.patch(
            row.key,
            { permissionMode: "workspace" },
            { agentId: "main", expectedSessionId: row.sessionId },
          )
    ).then(settled);
    settle(() => Promise.allSettled([pending, mutation]));
    await accepted.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(4);
    before.resolve(initial);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    if (firstOwner === "primary") {
      fresh.resolve(updated);
      await mutation;
      await pending;
      expect(delivered.mock.lastCall?.[0].result?.sessions).toEqual([created, original]);
    } else {
      fresh.reject(new Error("Fresh reconciliation unavailable"));
      await mutation;
      await Promise.allSettled([pending]);
      expect(settled).toHaveBeenCalledWith(
        expect.objectContaining({ listRefreshError: "Fresh reconciliation unavailable" }),
      );
    }
  },
);
