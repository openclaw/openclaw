// @vitest-environment node
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createGatewayConnectionLifecycle } from "../gateway-connection-lifecycle.ts";
import { sessionChangedEvent, sessionsResult } from "./session-capability.test-support.ts";
import type { SessionCapability } from "./session-capability.ts";
import type { ObservedSessionList } from "./session-list-query.ts";
import { createSessionRosterObservations } from "./session-roster-observations.ts";
import { rosterReadFixture } from "./session-roster-refresh.test-support.ts";

const makeRow = (id: string, label: string) =>
  ({ key: `agent:main:${id}`, sessionId: id, kind: "direct", label, updatedAt: 1 }) as const;
type Row = ReturnType<typeof makeRow>;
const makeQuery = (limit: number) => ({ agentId: "main", search: "Shared", limit });
const changed = (row: Row, reason: string, label: string, updatedAt = 1) => ({
  type: "event" as const,
  event: "sessions.changed",
  payload: {
    sessionKey: row.key,
    agentId: "main",
    sessionId: row.sessionId,
    reason,
    label,
    updatedAt,
  },
});
function makeHarness(result: (params?: unknown) => SessionsListResult, ownerId?: string) {
  vi.useFakeTimers();
  const harness = rosterReadFixture(result, ownerId);
  const subscribe = (...args: Parameters<SessionCapability["subscribeList"]>) =>
    harness.watch(harness.sessions.subscribeList(...args));
  return { ...harness, subscribe };
}

it("converges overlapping views before listeners run without refetching", async () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    ...makeRow(`shared-${index}`, `Shared ${index}`),
    lastMessagePreview: "Before",
  }));
  const queries = Array.from({ length: 8 }, (_, index) => makeQuery(10 + index));
  const newest = queries.at(-1)!;
  let fresh = false;
  let observe = false;
  const { sessions, emitEvent, request, subscribe, watch } = makeHarness((params) =>
    sessionsResult(
      rows.map((row, index) => ({
        ...row,
        lastMessagePreview:
          fresh && index === 1 && asNullableRecord(params)?.limit === newest.limit
            ? "After"
            : "Before",
      })),
      1,
    ),
  );
  const target = rows[0]!;
  const observed = vi.fn();
  let descriptor: ReturnType<SessionCapability["observeRow"]> | null = null;
  const heldResults = () => [
    sessions.state.result,
    ...queries.map((query) => sessions.listSnapshot(query).result),
  ];
  const findTarget = (result: SessionsListResult | null | undefined) =>
    result?.sessions.find((row) => row.key === target.key);
  const previews = () => heldResults().map((result) => result?.sessions[1]?.lastMessagePreview);
  const deliveredPreviews: ReturnType<typeof previews>[] = [];
  queries.forEach((query, index) =>
    subscribe(query, () => {
      if (observe && index === 0) {
        deliveredPreviews.push(previews());
      }
    }),
  );
  const eventDelivered = vi.fn(() => ({
    descriptor: descriptor?.row,
    rows: heldResults().map(findTarget),
  }));
  await sessions.refresh({ agentId: "main", force: true });
  for (const query of queries) {
    await sessions.refreshList({ ...query, force: true });
  }
  emitEvent(changed(target, "patch", target.label));
  fresh = true;
  await sessions.refreshList({ ...newest, force: true });
  expect([previews()[1], previews().at(-1)]).toEqual(["Before", "After"]);
  descriptor = sessions.observeRow({ key: target.key, agentId: "main" }, observed, {
    onEvent: eventDelivered,
  });
  watch(() => descriptor?.dispose());
  observed.mockClear();
  observe = true;
  const event = changed(target, "update", "Shared updated", 2);
  emitEvent(event);
  const expected = expect.objectContaining({ label: "Shared updated", updatedAt: 2 });
  for (const result of heldResults()) {
    expect(result?.sessions).toHaveLength(rows.length);
  }
  expect(eventDelivered).toHaveBeenCalledExactlyOnceWith(
    event,
    expect.objectContaining({ applied: true, admittedRow: expected, row: expected }),
  );
  expect(eventDelivered).toHaveReturnedWith({
    descriptor: expected,
    rows: Array.from({ length: queries.length + 1 }, () => expected),
  });
  expect(deliveredPreviews).toEqual([Array(queries.length + 1).fill("After")]);
  expect(observed).toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(queries.length + 2);
});

const ownerId = "profile-ada";
const ownerRow = (name: string, updatedAt: number, id = ownerId) => ({
  key: `agent:main:${name}`,
  kind: "direct" as const,
  updatedAt,
  createdActor: { type: "human" as const, id },
});

it.each([false, true])(
  "retains owner and shared pages throughout refresh (fails: %s)",
  async (fails) => {
    vi.useFakeTimers();
    const ownerTail = ownerRow("owner-tail", 1);
    const ownerHead = ownerRow("owner-head", 3);
    const sharedRows = [
      ownerHead,
      ...Array.from({ length: 119 }, (_, index) =>
        ownerRow(`shared-${index}`, 119 - index, "profile-bob"),
      ),
    ];
    let failRefresh = false;
    const { sessions, emitEvent, request } = rosterReadFixture(
      (params?: { limit?: number; offset?: number; ownerFirst?: boolean }) => {
        if (failRefresh) {
          throw new Error("session roster unavailable");
        }
        const offset = params?.offset ?? 0;
        const shared = sharedRows.slice(offset, offset + (params?.limit ?? 50));
        return sessionsResult(
          params?.ownerFirst
            ? [ownerHead, ownerTail, ...shared.filter((row) => row !== ownerHead)]
            : shared,
          2,
        );
      },
      ownerId,
    );

    await sessions.refresh({ agentId: "main", limit: 60, force: true });
    await sessions.refresh({ agentId: "main", limit: 60, offset: 60, append: true, force: true });
    expect(sessions.state.result?.sessions).toHaveLength(121);
    const publishedKeySets: string[][] = [];
    const stop = sessions.subscribe((next) => {
      if (next.result) {
        publishedKeySets.push(next.result.sessions.map((row) => row.key));
      }
    });
    failRefresh = fails;

    emitEvent(sessionChangedEvent(sharedRows[1]!.key));
    await vi.advanceTimersByTimeAsync(5_000);
    stop();

    expect(request).toHaveBeenCalledTimes(3);
    expect(sessions.state.result?.sessions).toHaveLength(121);
    expect(sessions.state.result?.sessions.map((row) => row.key)).toContain(ownerTail.key);
    expect(publishedKeySets.length).toBeGreaterThan(0);
    for (const keys of publishedKeySets) {
      expect(keys).toContain(sharedRows[1]!.key);
    }
    if (fails) {
      expect(sessions.state.error).not.toBeNull();
      expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual(publishedKeySets[0]);
    }
  },
);

function observationFixture(readResult: () => SessionsListResult | null = () => null) {
  const connection = createGatewayConnectionLifecycle({
    phase: "connected",
    client: createTestGatewayClient(async () => ({})),
  });
  onTestFinished(() => connection.dispose());
  const lists = new Map<string, ObservedSessionList>();
  const observations = createSessionRosterObservations(
    {
      connection,
      observerError: () => null,
      readState: () => ({ result: readResult(), agentId: "main" }),
      decorate: (value) => value,
    },
    lists,
  );
  return {
    observations,
    list: (name: string, rows: GatewaySessionRow[], agentId = "main") =>
      lists.set(name, {
        scope: { agentId },
        connectionEpoch: connection.epoch,
        snapshot: { result: sessionsResult(rows), agentId, loading: false, error: null },
        listeners: new Set(),
      }),
    stage: (row: GatewaySessionRow, revision: number) =>
      observations.stageObservedRows([row], connection.capture(), "main", revision)(),
    register: (key: string, isValid: (sessionId: string) => boolean = () => true) =>
      observations.registerRow({ key, agentId: "main" }, () => {}, {
        isValid,
        decorate: (value) => value,
      }),
  };
}

it.each(["main", "global"])(
  "projects %s receipts without mixing owners or session incarnations",
  (key) => {
    let primary: SessionsListResult | null = null;
    const { list, observations, stage, register } = observationFixture(() => primary);
    const row: GatewaySessionRow = {
      key,
      sessionId: " selected ",
      kind: "direct",
      label: "Primary",
      snapshotAt: 100,
    };
    const descriptor = {
      ...row,
      key: key === "main" ? "agent:main:main" : key,
      snapshotAt: 150,
      providerReview: undefined,
    };
    const registered = register(key, (sessionId) => sessionId === row.sessionId);
    stage(descriptor, 2);
    stage({ ...descriptor, sessionId: "rejected", snapshotAt: 160 }, 3);
    expect(registered.isCurrent()).toBe(true);
    expect(registered.current()).toEqual(descriptor);
    observations.observeReadRow(row, 1, "main");
    primary = sessionsResult([row]);
    const fresh = {
      ...row,
      key: descriptor.key,
      label: "Newer list",
      snapshotAt: 200,
      providerReview: { id: "pause", runId: "run", canContinue: false },
    };
    observations.observeReadRow(fresh, 4, "main");
    list("fresh", [fresh]);
    const otherOwner = {
      ...fresh,
      key: key === "main" ? "agent:other:main" : key,
      agentId: "other",
      label: "Other owner",
    };
    list("other-owner", [otherOwner], "other");
    list("other-incarnation", [{ ...fresh, sessionId: "selected", label: "Other ID" }]);
    expect(observations.projectRows([row])[0]).toEqual({ ...fresh, key });
    expect(observations.currentRow(row, "main")).toEqual({ ...fresh, key });
    expect(observations.currentRow({ ...row, sessionId: "missing" }, "main")).toBeUndefined();
    expect(observations.projectRows([row, { ...row, sessionId: " " }])[1]?.label).toBe("Primary");
    primary = null;
    expect(observations.currentRow(row, "main")).toEqual(fresh);
  },
);
