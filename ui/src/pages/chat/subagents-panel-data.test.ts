/* @vitest-environment jsdom */
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
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

function fixture(read: (method: string, params: Record<string, unknown>) => unknown) {
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
    return read(method, values);
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
  return { data, when, open, request, connection, subscriptions, released, changed };
}

describe("Subagents panel data ownership", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["presented:false", "dispose"])(
    "settles a retryable message release after %s without another render",
    async (retirement) => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const row = child("retiring", {
        status: "running",
        hasActiveRun: true,
        activeRunIds: ["run-1"],
      });
      const f = fixture((method, params) => {
        if (method === "sessions.list") {
          return page(params.spawnedBy ? [row] : []);
        }
        if (method === "chat.history") {
          return history(row);
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      f.open();
      await f.when(() => f.data.rows[0]?.callCount === 0);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.subscriptions.has(row.key)).toBe(true);

      const request = f.request.getMockImplementation()!;
      let releases = 0;
      f.request.mockImplementation((method, params) => {
        if (method === "sessions.messages.unsubscribe" && ++releases === 1) {
          throw new GatewayProtocolRequestError({ retryable: true });
        }
        return request(method, params);
      });
      if (retirement === "dispose") {
        f.data.dispose();
      } else {
        f.data.sync({ sessionKey: parentKey, agentId: "main", presented: false });
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(releases).toBe(1);
      expect(f.subscriptions.has(row.key)).toBe(true);

      await vi.advanceTimersByTimeAsync(249);
      expect(releases).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.subscriptions.has(row.key)).toBe(false);
      expect(releases).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

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
      const f = fixture((method, params) => {
        if (method === "sessions.list") {
          return page(params.spawnedBy ? (initial ? oldRows : [current]) : []);
        }
        if (method === "chat.history") {
          const index = oldRows.findIndex((row) => row.key === params.sessionKey);
          if (index >= 0) {
            if (++started === 2) {
              readsStarted.resolve();
            }
            return blocked[index]!.promise;
          }
          return history(current);
        }
        throw new Error(`Unexpected method: ${method}`);
      });
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
      await f.when(
        () => f.data.rows[0]?.session.key === current.key && f.data.rows[0]?.callCount === 0,
      );
      expect(f.data.rows.map((row) => [row.session.key, row.callCount])).toEqual([
        [current.key, 0],
      ]);
      expect(f.data.error).toBeNull();
      blocked[1]!.resolve(history(oldRows[1]!, 4));
    },
  );

  it("withdraws readable rows and their message subscription when the child list is denied", async () => {
    const row = child("running", {
      status: "running",
      hasActiveRun: true,
      activeRunIds: ["run-1"],
    });
    let denied = false;
    const f = fixture((method, params) => {
      if (method === "sessions.list") {
        if (denied && params.spawnedBy) {
          throw new Error("Session read access denied");
        }
        return page(params.spawnedBy ? [row] : []);
      }
      if (method === "chat.history") {
        return history(row);
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    f.open();
    await f.when(() => f.data.rows[0]?.callCount === 0);
    expect(f.subscriptions.has(row.key)).toBe(true);
    denied = true;
    await f.data.refresh();
    await f.released.promise;
    expect(f.data.rows).toEqual([]);
    expect(f.data.error).toContain("Session read access denied");
    expect(f.subscriptions.has(row.key)).toBe(false);
  });

  it("keeps later child pages available while excluding Swarm and persistent sessions", async () => {
    const first = child("first");
    const last = child("last", { key: "agent:research:subagent:last", agentId: "research" });
    const swarm = child("swarm", { swarmGroupId: "parallel-audits" });
    const persistent = child("persistent", {
      key: "agent:main:dashboard:persistent",
      classification: undefined,
    });
    const f = fixture((method, params) => {
      if (method === "sessions.list") {
        if (!params.spawnedBy) {
          return page([]);
        }
        return params.offset === 3
          ? page([last], { offset: 3, totalCount: 4 })
          : page([first, swarm, persistent], { hasMore: true, nextOffset: 3, totalCount: 4 });
      }
      if (method === "chat.history") {
        return history(params.sessionKey === last.key ? last : first);
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    f.open();
    await f.when(() => f.data.hasResult && !f.data.loading);
    expect(f.data.rows.map((row) => row.session.key)).toEqual([first.key]);
    expect(f.data.hasMore).toBe(true);
    await f.data.loadMore();
    expect(f.data.rows.map((row) => row.session.key)).toEqual([first.key, last.key]);
    expect(f.data.hasMore).toBe(false);
  });

  it("rejects a stale Stop target while allowing the current run to be stopped exactly", async () => {
    let row = child("stop", {
      status: "running",
      hasActiveRun: true,
      activeRunIds: ["original-run"],
    });
    const f = fixture((method, params) => {
      if (method === "sessions.list") {
        return page(params.spawnedBy ? [row] : []);
      }
      if (method === "chat.history") {
        return history(row);
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    f.open();
    await f.when(() => f.data.rows[0]?.canStop === true);
    const rendered = f.data.rows[0]!;
    row = { ...row, activeRunIds: ["replacement-run"], updatedAt: 2 };
    await f.data.refresh();
    expect(f.data.rows[0]?.session.activeRunIds).toEqual(["replacement-run"]);
    expect(f.data.rows[0]?.canStop).toBe(true);
    await f.data.stop(rendered);
    expect(f.request.mock.calls.filter(([method]) => method === "sessions.abort")).toEqual([]);
    await f.data.stop(f.data.rows[0]!);
    expect(f.request.mock.calls.filter(([method]) => method === "sessions.abort")).toEqual([
      ["sessions.abort", { key: row.key, agentId: "worker", runId: "replacement-run" }],
    ]);
  });

  it("withdraws an exact count on an item-only live frame without losing public activity", async () => {
    const row = child("activity", {
      status: "running",
      hasActiveRun: true,
      activeRunIds: ["run-1"],
    });
    const f = fixture((method, params) => {
      if (method === "sessions.list") {
        return page(params.spawnedBy ? [row] : []);
      }
      if (method === "chat.history") {
        return history(row);
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    f.open();
    await f.when(() => f.data.rows[0]?.callCount === 0);
    const data = {
      itemId: "item-read",
      kind: "tool",
      phase: "start",
      status: "running",
      name: "read",
      title: "Read file",
      progressText: "Reading source",
    };
    const publish = (item: Record<string, unknown>, seq: number) =>
      f.connection.publishEvent("session.tool", {
        sessionKey: row.key,
        agentId: "worker",
        runId: "run-1",
        stream: "item",
        ts: 1000 + seq,
        seq,
        data: item,
      });
    publish(data, 1);
    expect(f.data.rows[0]?.callCount).toBeUndefined();
    expect(f.data.rows[0]?.activity).toBe("Reading source");
    publish({ ...data, phase: "update", toolCallId: "call-read" }, 2);
    expect(f.data.rows[0]?.callCount).toBeUndefined();
    expect(f.data.rows[0]?.activity).toBe("Reading source");
  });

  it("ignores unrelated deltas without skipping lifecycle activity cleanup", async () => {
    let row = child("streams", { status: "running", hasActiveRun: true, activeRunIds: ["run-1"] });
    const f = fixture((method, params) => {
      if (method === "sessions.list") {
        return page(params.spawnedBy ? [row] : []);
      }
      if (method === "chat.history") {
        return history(row);
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    f.open();
    await f.when(() => f.data.rows[0]?.callCount === 0);
    const publish = (runId: string, stream: string, data: Record<string, unknown>) =>
      f.connection.publishEvent("agent", {
        sessionKey: row.key,
        agentId: "worker",
        runId,
        stream,
        data,
      });
    publish("run-1", "item", {
      itemId: "read-item",
      toolCallId: "read-call",
      kind: "tool",
      phase: "start",
      status: "running",
      name: "read",
      title: "Read",
      progressText: "Reading source",
    });
    expect(f.data.rows[0]?.activity).toBe("Reading source");
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
    expect(f.data.rows[0]?.callCount).toBe(1);

    row = { ...row, activeRunIds: ["run-2"], updatedAt: 2 };
    await f.data.refresh();
    await f.when(() => f.data.rows[0]?.callCount === 0);
    f.changed.mockClear();
    publish("run-2", "lifecycle", { phase: "start" });
    expect(f.data.rows[0]?.activity).toBeUndefined();
    expect(f.changed).toHaveBeenCalledOnce();
  });
});
