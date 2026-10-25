/** @vitest-environment node */
import type { EventFrame, SessionRowFull } from "@openclaw/gateway-client/browser";
import { SESSION_ROW_DELTA_MAX_ENTRIES } from "@openclaw/gateway-protocol/session-row-deltas";
import { beforeEach, expect, it, vi } from "vitest";
import { GatewayChatEvents } from "./gateway-chat-events.ts";

function full(row: Record<string, unknown> & { key: string; agentId?: string }): SessionRowFull {
  return { key: row.key, agentId: row.agentId, version: 1, full: row };
}

function event(payload: Record<string, unknown>, name = "sessions.changed"): EventFrame {
  return { type: "event", event: name, payload };
}

function delta(set: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return { key: "child", base: 1, version: 2, set, remove: [], ...overrides };
}

function parentRow(sessionId?: string) {
  return {
    key: "parent",
    agentId: "work",
    ancestorRevision: "parent-revision",
    snapshotAt: 100,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

function parentReference(sessionId?: string) {
  return {
    key: "parent",
    agentId: "work",
    revision: "parent-revision",
    snapshotAt: 200,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

const reconnect = vi.fn();
const listener = vi.fn<(event: EventFrame) => void>();
let events: GatewayChatEvents;
beforeEach(() => {
  reconnect.mockReset();
  listener.mockReset();
  events = new GatewayChatEvents(reconnect);
});

function send(payload: Record<string, unknown>, name?: string) {
  events.dispatch(event(payload, name), listener);
  return listener.mock.lastCall?.[0];
}
function check(payload: Record<string, unknown>, expected: Record<string, unknown>, name?: string) {
  listener.mockClear();
  expect(send(payload, name)).toEqual(event(expected, name));
}
function checkRow(
  session: Record<string, unknown>,
  expected: Record<string, unknown>,
  name?: string,
) {
  check({ session }, { session: expected }, name);
}
function reject(payload: Record<string, unknown>) {
  listener.mockClear();
  send(payload);
  expect(listener).not.toHaveBeenCalled();
}

it("decodes once for every listener while preserving complete legacy payloads", () => {
  const parent = { key: "parent", agentId: "work", ancestorRevision: "r1", runtimeMs: 10 };
  const initial = {
    key: "child",
    agentId: "work",
    title: "Before",
    runtimeMs: 10,
    runtimeSampledAt: 100,
    summary: { value: "old", removed: true },
    optional: "remove me",
  };
  send({ session: full(initial), ancestorSessions: [full(parent)] });
  const changed = {
    title: null,
    runtimeMs: 20,
    runtimeSampledAt: 200,
    summary: { value: "new" },
    empty: [],
    zero: 0,
    disabled: false,
  };
  const patch = event({
    key: "child",
    sessionFieldRefs: [4],
    session: delta(structuredClone(changed), { agentId: "work", remove: ["optional"] }),
    ancestorSessions: [delta({ runtimeMs: 20 }, { key: "parent", agentId: "work" })],
    ancestorSessionRefs: [{ key: "root", revision: "known" }],
  });
  const second = vi.fn();
  events.dispatch(patch, listener);
  events.dispatch(patch, second);
  expect(listener.mock.lastCall?.[0]).toBe(second.mock.lastCall?.[0]);
  expect(second).toHaveBeenCalledExactlyOnceWith(
    event({
      key: "child",
      runtimeMs: 20,
      session: {
        key: "child",
        agentId: "work",
        ...changed,
      },
      ancestorSessions: [{ ...parent, runtimeMs: 20 }],
      ancestorSessionRefs: [{ key: "root", revision: "known" }],
    }),
  );
  expect(initial.optional).toBe("remove me");
  expect(reconnect).not.toHaveBeenCalled();
});

it("restores only referenced fields and rejects invalid references before committing rows", () => {
  const row = { key: "child", label: null, pinned: false, summary: { text: "Synthetic" } };
  check(
    { session: full(row), sessionFieldRefs: [1, 2, 3] },
    { session: row, label: null, pinned: false, summary: row.summary },
  );
  for (const sessionFieldRefs of [[-1], [4], [1.5], ["label"], null]) {
    reject({ session: delta({ label: "Changed" }), sessionFieldRefs });
  }
  checkRow(delta(), row);
});

it.each(["parent-session", undefined])(
  "expands certified ancestor references with session ID %s without changing the raw delta baseline",
  (sessionId) => {
    const parent = { ...parentRow(sessionId), label: "Original" };
    send({ ancestorSessions: [full(parent)] });
    check(
      {
        session: full({ key: "child", label: "Child" }),
        sessionFieldRefs: [1],
        ancestorSessions: [],
        ancestorSessionRefs: [parentReference(sessionId)],
      },
      {
        session: { key: "child", label: "Child" },
        label: "Child",
        ancestorSessions: [{ ...parent, snapshotAt: 200 }],
      },
    );
    check(
      {
        ancestorSessions: [
          delta({ label: "Updated" }, { key: parent.key, agentId: parent.agentId }),
        ],
      },
      { ancestorSessions: [{ ...parent, label: "Updated" }] },
    );
    expect(reconnect).not.toHaveBeenCalled();
  },
);

it("preserves unresolved ancestor references without touching the wire row LRU", () => {
  const parent = parentRow("parent-session");
  const reference = parentReference("parent-session");
  const unresolved = [
    { ...reference, key: "other-parent" },
    { ...reference, agentId: "other-agent" },
    { ...reference, sessionId: "other-generation" },
    { ...reference, sessionId: undefined },
    { ...reference, revision: "other-revision" },
  ];
  send({
    ancestorSessions: [
      full(parent),
      ...Array.from({ length: SESSION_ROW_DELTA_MAX_ENTRIES - 1 }, (_, index) =>
        full({ key: `row-${index}` }),
      ),
    ],
  });
  check(
    { ancestorSessions: [], ancestorSessionRefs: [...unresolved, reference] },
    {
      ancestorSessions: [{ ...parent, snapshotAt: 200 }],
      ancestorSessionRefs: unresolved,
    },
  );
  send({ session: full({ key: "new-row" }) });
  const unavailable = { ancestorSessions: [], ancestorSessionRefs: [reference] };
  check(unavailable, unavailable);
  events.clear();
  check(unavailable, unavailable);
  expect(reconnect).not.toHaveBeenCalled();
});

it("discards a divergent frame atomically and asks to reconnect once across listeners", () => {
  send({ session: full({ key: "child", runtimeMs: 10 }) });
  const broken = event({
    session: delta({ runtimeMs: 20 }),
    ancestorSessions: [delta({}, { key: "unheld" })],
  });
  listener.mockClear();
  events.dispatch(broken, listener);
  events.dispatch(broken, listener);
  expect(listener).not.toHaveBeenCalled();
  expect(reconnect).toHaveBeenCalledExactlyOnceWith("session row baseline missing");
  // A rejected ancestor must not commit the leaf's version or contents.
  checkRow(delta({ title: "After" }), { key: "child", runtimeMs: 10, title: "After" });
});

it.each([
  delta({}, { base: 7, version: 8 }),
  delta({ key: "other" }),
  delta({ agentId: "other" }),
  delta({}, { remove: ["key"] }),
  delta({ title: "x" }, { remove: ["title"] }),
  delta({}, { version: Number.MAX_SAFE_INTEGER + 1 }),
  { key: "child", version: 2, full: { key: "other" } },
  { key: "child", version: 2, full: null },
])("rejects malformed or divergent row wrappers: %j", (session) => {
  send({ session: full({ key: "child" }) });
  reject({ session });
  expect(reconnect).toHaveBeenCalledExactlyOnceWith("session row baseline missing");
});

it("mirrors count LRU touches, including eviction during a multi-row frame", () => {
  send({
    ancestorSessions: Array.from({ length: SESSION_ROW_DELTA_MAX_ENTRIES }, (_, index) =>
      full({ key: `row-${index}` }),
    ),
  });
  send({
    session: delta({ title: "touched" }, { key: "row-0" }),
    ancestorSessions: [full({ key: "new" })],
  });
  checkRow(delta({}, { key: "row-0", base: 2, version: 3 }), {
    key: "row-0",
    title: "touched",
  });
  reject({ session: delta({}, { key: "row-1" }) });
  expect(reconnect).toHaveBeenCalledOnce();
});

it("delivers unretained full rows, discards their earlier baseline and accepts a later full", () => {
  send({ session: full({ key: "large", title: "Before" }) });
  checkRow(
    { ...full({ key: "large", title: "Large" }), version: 2, retain: false },
    { key: "large", title: "Large" },
  );
  reject({ session: delta({}, { key: "large", base: 2, version: 3 }) });
  send({ session: { ...full({ key: "large", title: "Small" }), version: 4 } });
  checkRow(delta({ title: "After" }, { key: "large", base: 4, version: 5 }), {
    key: "large",
    title: "After",
  });
});

it("clears the entire row store when the transport resets", () => {
  send({ session: full({ key: "one" }), ancestorSessions: [full({ key: "two" })] });
  events.clear();
  reject({ session: delta({}, { key: "two" }) });
  expect(reconnect).toHaveBeenCalledOnce();
});

it("preserves legacy rows and isolates the same key for different agents", () => {
  const legacy = event({ session: { key: "plain", title: "Legacy" } }, "session.message");
  events.dispatch(legacy, listener);
  expect(listener).toHaveBeenCalledExactlyOnceWith(legacy);
  send({ session: full({ key: "global", agentId: "one", title: "One" }) });
  send({ session: full({ key: "global", agentId: "two", title: "Two" }) });
  checkRow(
    delta({}, { key: "global", agentId: "one" }),
    { key: "global", agentId: "one", title: "One" },
    "session.message",
  );
});
