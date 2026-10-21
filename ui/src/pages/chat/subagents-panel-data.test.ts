/* @vitest-environment jsdom */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { disposeSidebarContextLifecycles } from "../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createGatewayHarness } from "../../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  gatewayHelloForMethods,
  SESSION_MUTATION_TEST_METHODS,
} from "../../test-helpers/gateway-methods.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { SubagentsPanelData } from "./subagents-panel-data.ts";

const parentKey = "agent:main:parent";
const otherParentKey = "agent:main:other-parent";

function child(id: string, extra: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key: `agent:worker:subagent:${id}`,
    agentId: "worker",
    sessionId: `session-${id}`,
    spawnedBy: parentKey,
    kind: "direct",
    classification: "subagent",
    status: "done",
    sharingRole: "owner",
    updatedAt: 1,
    ...extra,
  };
}

function runningChild(id: string, extra: Partial<GatewaySessionRow> = {}) {
  return child(id, { status: "running", hasActiveRun: true, activeRunIds: ["run-1"], ...extra });
}

function rowFixture(row: () => GatewaySessionRow, readHistory = () => history(row())) {
  return fixture((params) => page(params.spawnedBy ? [row()] : []), readHistory);
}

const READING = "Reading source";
const readItem = (extra: Record<string, unknown> = {}) => ({
  itemId: "item-read",
  kind: "tool",
  phase: "start",
  status: "running",
  name: "read",
  title: "Read file",
  progressText: READING,
  ...extra,
});
const execItem = (itemId: string, meta: string, extra: Record<string, unknown> = {}) => ({
  itemId,
  toolCallId: "exec-call",
  kind: "tool",
  name: "exec",
  phase: "update",
  status: "running",
  title: `Exec ${meta}`,
  meta,
  ...extra,
});

function page(
  rows: GatewaySessionRow[],
  extra: Partial<SessionsListResult> = {},
): SessionsListResult {
  return { ...sessionsResult(rows, 1), hasMore: false, nextOffset: null, ...extra };
}

function history(row: GatewaySessionRow, calls = 0): ChatHistoryResult {
  const messages = Array.from({ length: calls }, (_, index) => ({
    role: "assistant",
    runId: "run-1",
    content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: {} }],
  }));
  return { sessionId: row.sessionId, messages, hasMore: false, totalMessages: messages.length };
}

function fixture(
  list: (params: Record<string, unknown>) => SessionsListResult,
  readHistory: (params: Record<string, unknown>) => unknown,
) {
  const subscriptions = new Set<string>();
  const released = createDeferred();
  const request = vi.fn((method: string, params?: unknown): unknown => {
    const values = asOptionalRecord(params) ?? {};
    if (method === "sessions.messages.subscribe") {
      subscriptions.add(String(values.key));
      return { key: values.key, agentId: values.agentId };
    }
    if (method === "sessions.messages.unsubscribe") {
      subscriptions.delete(String(values.key));
      released.resolve();
      return {};
    }
    if (method === "sessions.subscribe" || method === "sessions.unsubscribe") {
      return {};
    }
    if (method === "sessions.abort") {
      return { aborted: true };
    }
    if (method === "sessions.list") {
      return list(values);
    }
    if (method === "chat.history") {
      return readHistory(values);
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const client = createTestGatewayClient(request);
  const connection = createGatewayHarness(client);
  connection.publish({
    hello: gatewayHelloForMethods([
      ...SESSION_MUTATION_TEST_METHODS,
      "sessions.list",
      "sessions.subscribe",
      "sessions.unsubscribe",
      "sessions.messages.subscribe",
      "sessions.messages.unsubscribe",
      "chat.history",
    ]),
  });
  const sessions = createTestSessionCapability(connection.gateway);
  const context = createContext(connection.gateway, sessions);
  const listeners = new Set<() => void>();
  const changed = vi.fn(() => {
    for (const listener of listeners) {
      listener();
    }
  });
  const data = new SubagentsPanelData(context, changed);
  onTestFinished(() => {
    data.dispose();
    sessions.dispose();
    disposeSidebarContextLifecycles();
  });
  const when = (predicate: () => boolean): Promise<void> => {
    if (predicate()) {
      return Promise.resolve();
    }
    const gate = createDeferred();
    const checkCondition = () => {
      if (predicate()) {
        listeners.delete(checkCondition);
        gate.resolve();
      }
    };
    listeners.add(checkCondition);
    return gate.promise;
  };
  const open = (sessionKey = parentKey) =>
    data.sync({ sessionKey, agentId: "main", presented: true });
  const publish = (
    row: GatewaySessionRow,
    payload: Record<string, unknown>,
    envelope: { event?: string; runId?: string; stream?: string; seq?: number; ts?: number } = {},
  ) => {
    const { event = "agent", runId = "run-1", stream = "item", ...rest } = envelope;
    connection.publishEvent(event, {
      sessionKey: row.key,
      agentId: "worker",
      runId,
      stream,
      data: payload,
      ...rest,
    });
  };
  return { data, when, open, request, connection, subscriptions, released, changed, publish };
}

const view = (f: ReturnType<typeof fixture>) => f.data.rows[0];

async function ready(
  f: ReturnType<typeof fixture>,
  predicate = () => view(f)?.callCount?.count === 0,
) {
  f.open();
  await f.when(predicate);
}

describe("Subagents panel data ownership", () => {
  it.each(["parent", "connection"])(
    "rejects late history after %s retirement",
    async (retirement) => {
      const oldRows = [child("old-a"), child("old-b")];
      const current = child("current", {
        spawnedBy: retirement === "parent" ? otherParentKey : parentKey,
      });
      const blocked = [createDeferred<ChatHistoryResult>(), createDeferred<ChatHistoryResult>()];
      const readsStarted = createDeferred();
      let initial = true;
      let started = 0;
      const f = fixture(
        (params) => page(params.spawnedBy ? (initial ? oldRows : [current]) : []),
        (params) => {
          const index = oldRows.findIndex((row) => row.key === params.sessionKey);
          if (index < 0) {
            return history(current);
          }
          if (++started === 2) {
            readsStarted.resolve();
          }
          return blocked[index]!.promise;
        },
      );
      onTestFinished(() =>
        blocked.forEach((gate, index) => gate.resolve(history(oldRows[index]!, 4))),
      );
      f.open();
      await readsStarted.promise;
      initial = false;
      if (retirement === "parent") {
        f.open(otherParentKey);
      } else {
        f.connection.publish({ phase: "reconnecting" });
        expect(f.data.rows).toEqual([]);
        f.connection.publish({ phase: "connected" });
      }
      blocked[0]!.resolve(history(oldRows[0]!, 4));
      await f.when(() => view(f)?.session.key === current.key && view(f)?.callCount?.count === 0);
      expect(f.data.rows.map((row) => [row.session.key, row.callCount])).toEqual([
        [current.key, { count: 0, exact: true }],
      ]);
      expect(f.data.error).toBeNull();
      blocked[1]!.resolve(history(oldRows[1]!, 4));
    },
  );

  it("withdraws readable rows and their message subscription when the child list is denied", async () => {
    const row = runningChild("running");
    let denied = false;
    const f = fixture(
      (params) => {
        if (denied && params.spawnedBy) {
          throw new Error("Session read access denied");
        }
        return page(params.spawnedBy ? [row] : []);
      },
      () => history(row),
    );
    await ready(f);
    expect(f.subscriptions.has(row.key)).toBe(true);
    denied = true;
    await f.data.refresh();
    await f.released.promise;
    expect(f.data.rows).toEqual([]);
    expect(f.data.error).toContain("Session read access denied");
    expect(f.subscriptions.has(row.key)).toBe(false);
  });

  it.each([undefined, "parallel-audits"])(
    "loads older running children beyond the first page (%s)",
    async (swarmGroupId) => {
      const finished = Array.from({ length: 20 }, (_, index) => child(`finished-${index}`));
      const last = child("last", {
        key: "agent:research:subagent:last",
        agentId: "research",
        swarmGroupId,
        status: "running",
        hasActiveRun: true,
        activeRunIds: ["run-1"],
      });
      const persistent = child("persistent", {
        key: "agent:main:dashboard:persistent",
        classification: undefined,
      });
      const f = fixture(
        (params) =>
          !params.spawnedBy
            ? page([])
            : params.offset === 21
              ? page([last], { offset: 21, totalCount: 22 })
              : page([...finished, persistent], { hasMore: true, nextOffset: 21, totalCount: 22 }),
        (params) => history(params.sessionKey === last.key ? last : finished[0]!),
      );
      f.open();
      await f.data.refresh();
      expect(f.data.rows.map((row) => row.session.key)).toEqual([
        ...finished.map((row) => row.key),
        last.key,
      ]);
      expect(f.data.rows.at(-1)?.canStop).toBe(true);
      expect(f.data.loading).toBe(false);
    },
  );

  it("rejects a stale Stop target while allowing the current run to be stopped exactly", async () => {
    let row = runningChild("stop", { activeRunIds: ["original-run"] });
    const f = rowFixture(() => row);
    await ready(f, () => view(f)?.canStop === true);
    const rendered = view(f)!;
    row = { ...row, activeRunIds: ["replacement-run"], updatedAt: 2 };
    await f.data.refresh();
    expect(view(f)).toMatchObject({
      session: { activeRunIds: ["replacement-run"] },
      canStop: true,
    });
    await f.data.stop(rendered);
    expect(f.request.mock.calls.filter(([method]) => method === "sessions.abort")).toEqual([]);
    await f.data.stop(view(f)!);
    expect(f.request.mock.calls.filter(([method]) => method === "sessions.abort")).toEqual([
      ["sessions.abort", { key: row.key, agentId: "worker", runId: "replacement-run" }],
    ]);
  });

  it("withdraws an exact count on an item-only live frame without losing public activity", async () => {
    const row = runningChild("activity");
    const f = rowFixture(() => row);
    await ready(f);
    const data = readItem();
    const publish = (item: Record<string, unknown>, seq: number) =>
      f.publish(row, item, { event: "session.tool", seq, ts: 1000 + seq });
    publish(data, 1);
    expect(view(f)?.callCount).toBeUndefined();
    expect(view(f)?.activity).toBe(READING);
    publish({ ...data, phase: "update", toolCallId: "call-read" }, 2);
    expect(view(f)).toMatchObject({ callCount: { count: 1, exact: false }, activity: READING });
  });

  it("prefers public progress and tool purpose over the observer digest while hiding routine calls", async () => {
    const row = runningChild("tool-only", {
      observerDigest: {
        runId: "run-1",
        headline: "Reviewing the benchmark results",
        health: "on-track",
        revision: 1,
        updatedAt: 1,
      },
    });
    const f = rowFixture(() => row);
    await ready(f, () => view(f)?.callCount !== undefined);
    expect(view(f)?.activity).toBe(row.observerDigest?.headline);
    const item = execItem("exec-item", "Retry failed benchmark targets");
    const publish = (data: Record<string, unknown>) => f.publish(row, data);
    publish(item);
    expect(view(f)?.activity).toBe(item.meta);
    for (const flag of ["hideFromChannelProgress", "suppressChannelProgress"]) {
      publish({
        ...item,
        itemId: flag,
        toolCallId: flag,
        title: "Exec Hidden purpose",
        meta: "Hidden purpose",
        [flag]: true,
      });
      expect(view(f)?.activity).toBe(item.meta);
    }
    publish({ ...item, progressText: "Public progress" });
    expect(view(f)?.activity).toBe("Public progress");
    publish({ ...item, itemId: "next-item", toolCallId: "next-call", meta: "Next tool purpose" });
    expect(view(f)?.activity).toBe("Next tool purpose");
  });

  it("keeps previous-run steps out of a continuation headline while counting the whole session", async () => {
    const row = runningChild("continuation", { activeRunIds: ["continuation-run"] });
    const previous = execItem("previous-item", "Previous attempt", {
      phase: "end",
      status: "failed",
    });
    const messages = [
      { role: "assistant", runId: "previous-run", content: [], activity: [previous] },
    ];
    const f = rowFixture(
      () => row,
      () => ({
        sessionId: row.sessionId,
        messages,
        hasMore: false,
        totalMessages: messages.length,
      }),
    );
    const publish = (runId: string, data: Record<string, unknown>) =>
      f.publish(row, data, { runId });
    await ready(f, () => view(f)?.callCount?.count === 1);
    expect(view(f)?.activity).toBeUndefined();
    publish("previous-run", previous);
    expect(view(f)?.activity).toBeUndefined();
    expect(view(f)?.callCount).toEqual({ count: 1, exact: true });

    publish("continuation-run", {
      ...previous,
      itemId: "continuation-item",
      phase: "update",
      status: "running",
      title: "Exec Continue the repair",
      meta: "Continue the repair",
    });
    expect(view(f)).toMatchObject({
      activity: "Continue the repair",
      callCount: { count: 2, exact: true },
    });
  });

  it("ignores unrelated deltas without skipping lifecycle activity cleanup", async () => {
    let row = runningChild("streams");
    const f = rowFixture(() => row);
    await ready(f);
    const publish = (runId: string, stream: string, data: Record<string, unknown>) =>
      f.publish(row, data, { runId, stream });
    publish(
      "run-1",
      "item",
      readItem({ itemId: "read-item", toolCallId: "read-call", title: "Read" }),
    );
    expect(view(f)?.activity).toBe(READING);
    f.changed.mockClear();
    publish("run-1", "assistant", { delta: "The" });
    publish("run-1", "assistant", { delta: " result" });
    publish("run-1", "thinking", { delta: "private reasoning" });
    publish("run-1", "item", {
      itemId: "analysis",
      kind: "analysis",
      phase: "update",
      title: "Thinking",
    });
    expect(f.changed).not.toHaveBeenCalled();
    expect(view(f)?.callCount).toEqual({ count: 1, exact: true });

    row = { ...row, activeRunIds: ["run-2"], updatedAt: 2 };
    await f.data.refresh();
    await f.when(() => view(f)?.callCount?.count === 0);
    f.changed.mockClear();
    publish("run-2", "lifecycle", { phase: "start" });
    expect(view(f)?.activity).toBeUndefined();
    expect(f.changed).toHaveBeenCalledOnce();
  });
});
