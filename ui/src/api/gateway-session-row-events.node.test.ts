/** @vitest-environment node */
import type { EventFrame, SessionRowFull } from "@openclaw/gateway-client/browser";
import { SESSION_ROW_DELTA_MAX_ENTRIES } from "@openclaw/gateway-protocol/session-row-deltas";
import { describe, expect, it, vi } from "vitest";
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

function harness() {
  const reconnect = vi.fn();
  const listener = vi.fn<(event: EventFrame) => void>();
  const events = new GatewayChatEvents(reconnect);
  return {
    reconnect,
    listener,
    events,
    send(payload: Record<string, unknown>, name?: string) {
      events.dispatch(event(payload, name), listener);
      return listener.mock.lastCall?.[0];
    },
  };
}

describe("session row event ingress", () => {
  it("decodes once for every listener while preserving complete legacy payloads", () => {
    const h = harness();
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
    h.send({ session: full(initial), ancestorSessions: [full(parent)] });
    const patch = event({
      key: "child",
      sessionFieldRefs: [4],
      session: delta(
        {
          title: null,
          runtimeMs: 20,
          runtimeSampledAt: 200,
          summary: { value: "new" },
          empty: [],
          zero: 0,
          disabled: false,
        },
        { agentId: "work", remove: ["optional"] },
      ),
      ancestorSessions: [delta({ runtimeMs: 20 }, { key: "parent", agentId: "work" })],
      ancestorSessionRefs: [{ key: "root", revision: "known" }],
    });
    const second = vi.fn();
    h.events.dispatch(patch, h.listener);
    h.events.dispatch(patch, second);
    expect(h.listener.mock.lastCall?.[0]).toBe(second.mock.lastCall?.[0]);
    expect(second).toHaveBeenCalledExactlyOnceWith(
      event({
        key: "child",
        runtimeMs: 20,
        session: {
          key: "child",
          agentId: "work",
          title: null,
          runtimeMs: 20,
          runtimeSampledAt: 200,
          summary: { value: "new" },
          empty: [],
          zero: 0,
          disabled: false,
        },
        ancestorSessions: [{ ...parent, runtimeMs: 20 }],
        ancestorSessionRefs: [{ key: "root", revision: "known" }],
      }),
    );
    expect(initial.optional).toBe("remove me");
    expect(h.reconnect).not.toHaveBeenCalled();
  });

  it("restores only referenced fields and rejects invalid references before committing rows", () => {
    const h = harness();
    const row = { key: "child", label: null, pinned: false, summary: { text: "Synthetic" } };
    expect(h.send({ session: full(row), sessionFieldRefs: [1, 2, 3] })).toEqual(
      event({ session: row, label: null, pinned: false, summary: row.summary }),
    );
    for (const sessionFieldRefs of [[-1], [4], [1.5], ["label"], null]) {
      h.listener.mockClear();
      h.send({
        session: delta({ label: "Changed" }),
        sessionFieldRefs,
      });
      expect(h.listener).not.toHaveBeenCalled();
    }
    expect(h.send({ session: delta() })).toEqual(event({ session: row }));
  });

  it.each(["parent-session", undefined])(
    "expands certified ancestor references with session ID %s without changing the raw delta baseline",
    (sessionId) => {
      const h = harness();
      const parent = {
        key: "parent",
        agentId: "work",
        ...(sessionId === undefined ? {} : { sessionId }),
        ancestorRevision: "parent-revision",
        snapshotAt: 100,
        label: "Original",
      };
      h.send({ ancestorSessions: [full(parent)] });
      expect(
        h.send({
          session: full({ key: "child", label: "Child" }),
          sessionFieldRefs: [1],
          ancestorSessions: [],
          ancestorSessionRefs: [
            {
              key: parent.key,
              agentId: parent.agentId,
              ...(sessionId === undefined ? {} : { sessionId }),
              revision: parent.ancestorRevision,
              snapshotAt: 200,
            },
          ],
        }),
      ).toEqual(
        event({
          session: { key: "child", label: "Child" },
          label: "Child",
          ancestorSessions: [{ ...parent, snapshotAt: 200 }],
        }),
      );
      expect(
        h.send({
          ancestorSessions: [
            delta({ label: "Updated" }, { key: parent.key, agentId: parent.agentId }),
          ],
        }),
      ).toEqual(event({ ancestorSessions: [{ ...parent, label: "Updated" }] }));
      expect(h.reconnect).not.toHaveBeenCalled();
    },
  );

  it("preserves unresolved ancestor references without touching the wire row LRU", () => {
    const h = harness();
    const parent = {
      key: "parent",
      agentId: "work",
      sessionId: "parent-session",
      ancestorRevision: "parent-revision",
      snapshotAt: 100,
    };
    const reference = {
      key: parent.key,
      agentId: parent.agentId,
      sessionId: parent.sessionId,
      revision: parent.ancestorRevision,
      snapshotAt: 200,
    };
    const unresolved = [
      { ...reference, key: "other-parent" },
      { ...reference, agentId: "other-agent" },
      { ...reference, sessionId: "other-generation" },
      { ...reference, sessionId: undefined },
      { ...reference, revision: "other-revision" },
    ];
    h.send({
      ancestorSessions: [
        full(parent),
        ...Array.from({ length: SESSION_ROW_DELTA_MAX_ENTRIES - 1 }, (_, index) =>
          full({ key: `row-${index}` }),
        ),
      ],
    });
    expect(
      h.send({ ancestorSessions: [], ancestorSessionRefs: [...unresolved, reference] }),
    ).toEqual(
      event({
        ancestorSessions: [{ ...parent, snapshotAt: 200 }],
        ancestorSessionRefs: unresolved,
      }),
    );
    h.send({ session: full({ key: "new-row" }) });
    const unavailable = { ancestorSessions: [], ancestorSessionRefs: [reference] };
    expect(h.send(unavailable)).toEqual(event(unavailable));
    h.events.clear();
    expect(h.send(unavailable)).toEqual(event(unavailable));
    expect(h.reconnect).not.toHaveBeenCalled();
  });

  it("discards a divergent frame atomically and asks to reconnect once across listeners", () => {
    const h = harness();
    h.send({ session: full({ key: "child", runtimeMs: 10 }) });
    const broken = event({
      session: delta({ runtimeMs: 20 }),
      ancestorSessions: [delta({}, { key: "unheld" })],
    });
    h.listener.mockClear();
    h.events.dispatch(broken, h.listener);
    h.events.dispatch(broken, h.listener);
    expect(h.listener).not.toHaveBeenCalled();
    expect(h.reconnect).toHaveBeenCalledExactlyOnceWith("session row baseline missing");
    // A rejected ancestor must not commit the leaf's version or contents.
    expect(h.send({ session: delta({ title: "After" }) })).toEqual(
      event({ session: { key: "child", runtimeMs: 10, title: "After" } }),
    );
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
    const h = harness();
    h.send({ session: full({ key: "child" }) });
    h.listener.mockClear();
    h.send({ session });
    expect(h.listener).not.toHaveBeenCalled();
    expect(h.reconnect).toHaveBeenCalledExactlyOnceWith("session row baseline missing");
  });

  it("mirrors count LRU touches, including eviction during a multi-row frame", () => {
    const h = harness();
    h.send({
      ancestorSessions: Array.from({ length: SESSION_ROW_DELTA_MAX_ENTRIES }, (_, index) =>
        full({ key: `row-${index}` }),
      ),
    });
    h.send({
      session: delta({ title: "touched" }, { key: "row-0" }),
      ancestorSessions: [full({ key: "new" })],
    });
    expect(h.send({ session: delta({}, { key: "row-0", base: 2, version: 3 }) })).toEqual(
      event({ session: { key: "row-0", title: "touched" } }),
    );
    h.listener.mockClear();
    h.send({ session: delta({}, { key: "row-1" }) });
    expect(h.listener).not.toHaveBeenCalled();
    expect(h.reconnect).toHaveBeenCalledOnce();
  });

  it("delivers unretained full rows, discards their earlier baseline and accepts a later full", () => {
    const h = harness();
    h.send({ session: full({ key: "large", title: "Before" }) });
    expect(
      h.send({ session: { ...full({ key: "large", title: "Large" }), version: 2, retain: false } }),
    ).toEqual(event({ session: { key: "large", title: "Large" } }));
    h.listener.mockClear();
    h.send({ session: delta({}, { key: "large", base: 2, version: 3 }) });
    expect(h.listener).not.toHaveBeenCalled();
    h.send({ session: { ...full({ key: "large", title: "Small" }), version: 4 } });
    expect(
      h.send({
        session: delta({ title: "After" }, { key: "large", base: 4, version: 5 }),
      }),
    ).toEqual(event({ session: { key: "large", title: "After" } }));
  });

  it("clears the entire row store when the transport resets", () => {
    const h = harness();
    h.send({ session: full({ key: "one" }), ancestorSessions: [full({ key: "two" })] });
    h.events.clear();
    h.listener.mockClear();
    h.send({ session: delta({}, { key: "two" }) });
    expect(h.listener).not.toHaveBeenCalled();
    expect(h.reconnect).toHaveBeenCalledOnce();
  });

  it("preserves legacy rows and isolates the same key for different agents", () => {
    const h = harness();
    const legacy = event({ session: { key: "plain", title: "Legacy" } }, "session.message");
    h.events.dispatch(legacy, h.listener);
    expect(h.listener).toHaveBeenCalledExactlyOnceWith(legacy);
    h.send({ session: full({ key: "global", agentId: "one", title: "One" }) });
    h.send({ session: full({ key: "global", agentId: "two", title: "Two" }) });
    expect(
      h.send({ session: delta({}, { key: "global", agentId: "one" }) }, "session.message"),
    ).toEqual(
      event({ session: { key: "global", agentId: "one", title: "One" } }, "session.message"),
    );
  });
});
