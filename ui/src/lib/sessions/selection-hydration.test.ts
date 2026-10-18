// @vitest-environment node
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  createAgentSelectionCapability,
  selectApplicationSession,
} from "../../app/agent-selection.ts";
import { createConnectionBootstrapCoordinator } from "../../app/connection-bootstrap.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createSessionCapability } from "./index.ts";
import {
  createGatewayHarness,
  createSubscriptionHydrationHarness,
  runningSessionsResult,
  sessionsResult,
} from "./session-capability.test-support.ts";

const requireRecord = createRequireRecord("object", "expected-label");
type Sessions = ReturnType<typeof createSubscriptionHydrationHarness>["sessions"];

function row(key: string, updatedAt = 1, fields: Partial<GatewaySessionRow> = {}) {
  return { key, kind: "direct" as const, updatedAt, ...fields };
}

function listRequest(
  list: (params?: Record<string, unknown>) => SessionsListResult | Promise<SessionsListResult>,
) {
  return vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.list") {
      return list(params);
    }
    throw new Error(`Unexpected request: ${method}`);
  });
}

function writerHarness(archived = false, savedAgentId: string | null = null) {
  const result = sessionsResult(
    [row(`agent:writer:${archived ? "draft" : "dashboard:one"}`, 1, archived ? { archived } : {})],
    1,
  );
  const request = listRequest((params) =>
    params?.agentId === "writer" ? result : sessionsResult([], 1),
  );
  const h = createSubscriptionHydrationHarness(request, savedAgentId);
  onTestFinished(() => h.sessions.dispose());
  return { ...h, request, result };
}

function expectRoster(sessions: Sessions, agentId: string, result: SessionsListResult) {
  expect(sessions.state.agentId).toBe(agentId);
  expect(sessions.state.result?.sessions).toEqual(result.sessions);
}

function recordAgents(sessions: Sessions) {
  const agents: Array<string | null> = [];
  const stop = sessions.subscribe(({ result, agentId }) => {
    if (result) {
      agents.push(agentId);
    }
  });
  onTestFinished(stop);
  return agents;
}

describe("session selection hydration", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it.each([
    { finalAgent: "main" },
    { finalAgent: "research" },
    { finalAgent: "research", queuedExplicit: true },
    { finalAgent: "research", remembered: "before" },
    { finalAgent: "research", remembered: "after" },
    { finalAgent: "research", recover: true },
    { finalAgent: "research", direct: { append: true, offset: 1 } },
    { finalAgent: "research", direct: { backgroundHydrate: true } },
  ])(
    "retires a slow intermediate agent when automatic selection moves main to writer to $finalAgent (queued explicit: $queuedExplicit, observer recovery: $recover, remembered refresh: $remembered)",
    async ({ finalAgent, queuedExplicit, recover, direct, remembered }) => {
      const writer = createDeferred<SessionsListResult>();
      const subscription = createDeferred<{ subscribed: boolean }>();
      let subscriptions = 0;
      const result = (agentId: string, ts: number) =>
        sessionsResult([row(`agent:${agentId}:main`, ts)], ts);
      const reads: string[] = [];
      const client = createTestGatewayClient(async (method, params) => {
        if (method === "sessions.subscribe") {
          if (++subscriptions === 1 && recover) {
            return subscription.promise;
          }
          return { subscribed: true };
        }
        if (method !== "sessions.list") {
          throw new Error(`Unexpected request: ${method}`);
        }
        const agentId = requireRecord(params, "sessions.list params").agentId;
        if (typeof agentId !== "string") {
          throw new Error("Session query has no agent owner");
        }
        reads.push(agentId);
        return agentId === "writer" ? writer.promise : result(agentId, reads.length);
      });
      const { gateway, publish, emitEvent } = createGatewayHarness(client);
      const selection = createAgentSelectionCapability(
        { ...gateway, connection: { gatewayUrl: "ws://gateway.example.test" } },
        {
          state: {
            agentsList: {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: ["main", "writer", "research"].map((id) => ({ id })),
            },
          },
          subscribe: () => () => undefined,
        },
      );
      const coordinator = createConnectionBootstrapCoordinator();
      coordinator.synchronize({ client, connected: true });
      // Roster/default reconciliation publishes selection without a new user intent.
      const automaticSelection = {
        get state() {
          return selection.state;
        },
        subscribe: selection.subscribe,
      };
      const sessions = createSessionCapability(gateway, automaticSelection, {
        connectionBootstrap: coordinator,
      });
      const publishedAgents = recordAgents(sessions);
      let superseded: Promise<void> | undefined;
      try {
        publish(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toEqual(["main"]);
        selection.set("writer");
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toEqual(["main", "writer"]);
        if (queuedExplicit) {
          superseded = sessions.refresh({ agentId: "writer", force: true });
        }
        if (remembered === "before") {
          superseded = sessions.refreshReplacement().then(() => undefined);
        }
        coordinator.setForegroundRoute(`agent:${finalAgent}:main`);
        selection.set(finalAgent);
        expect(selection.state.selectedId).toBe(finalAgent);
        if (remembered === "after") {
          superseded = sessions.refreshReplacement().then(() => undefined);
        }
        emitEvent({
          type: "event",
          event: "sessions.changed",
          payload: { agentId: "writer", reason: "create" },
        });
        await vi.advanceTimersByTimeAsync(5_000);
        if (recover) {
          subscription.resolve({ subscribed: false });
          await vi.advanceTimersByTimeAsync(1_000);
          expect(subscriptions).toBe(2);
        }
        writer.resolve(result("writer", 2));
        subscription.resolve({ subscribed: true });
        await vi.advanceTimersByTimeAsync(0);
        expect.soft(publishedAgents).not.toContain("writer");
        expect(reads).toEqual(["main", "writer"]);
        if (direct) {
          await sessions.refresh({ agentId: "writer", force: true, ...direct });
          expect(reads).toEqual(["main", "writer", "writer"]);
        }
        coordinator.setForegroundPane(
          {},
          { sessionKey: `agent:${finalAgent}:main`, client, ready: true },
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toEqual(["main", "writer", ...(direct ? ["writer"] : []), finalAgent]);
        expect(sessions.state).toMatchObject({
          agentId: finalAgent,
          result: { ts: direct ? 4 : 3, sessions: [{ key: `agent:${finalAgent}:main` }] },
        });
      } finally {
        writer.resolve(result("writer", 2));
        subscription.resolve({ subscribed: true });
        sessions.dispose();
        await superseded;
        selection.dispose();
        coordinator.reset();
      }
    },
  );

  it.each([
    { name: "different owners with the same SID", agentId: "writer", preview: undefined },
    { name: "the same owner and SID", agentId: "main", preview: undefined },
    { name: "a present Work preview", agentId: "writer", preview: "Work preview" },
  ])("keeps presentation with its owner across $name", async ({ agentId, preview }) => {
    const main: GatewaySessionRow = {
      key: "global",
      agentId: "main",
      sessionId: "00000000-0000-4000-8000-000000000101",
      kind: "global",
      derivedTitle: "Main conversation",
      lastMessagePreview: "Main preview",
      updatedAt: 10,
    };
    const { lastMessagePreview: _preview, ...mainFields } = main;
    const mainWithoutPreview = { ...mainFields, updatedAt: 20 };
    const incoming: GatewaySessionRow = {
      ...mainFields,
      agentId,
      derivedTitle: agentId === "main" ? "Main current title" : "Work current title",
      ...(preview === undefined ? {} : { lastMessagePreview: preview }),
      updatedAt: 30,
    };
    const replacement = createDeferred<SessionsListResult>();
    let replacing = false;
    const request = listRequest((params) => {
      if (params?.includeLastMessage) {
        expect(params.agentId).toBe("main");
        return sessionsResult([main], 10);
      }
      expect(params?.includeLastMessage).toBeUndefined();
      expect(params?.agentId).toBe(replacing ? agentId : "main");
      return replacing ? replacement.promise : sessionsResult([mainWithoutPreview], 20);
    });
    const { gateway, selection, sessions, connect } = createSubscriptionHydrationHarness(request);
    let sameOwnerRefresh: ReturnType<typeof sessions.refreshReplacement> | undefined;
    try {
      connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(sessions.state.result?.sessions[0]?.lastMessagePreview).toBe(main.lastMessagePreview);

      // The normal chat query omits preview enrichment; replacements keep that query.
      await sessions.refresh({ agentId: "main", force: true });
      expect(sessions.state.result?.sessions[0]?.lastMessagePreview).toBe(main.lastMessagePreview);
      const heldMain = sessions.state.result;
      replacing = true;
      if (agentId === "main") {
        sameOwnerRefresh = sessions.refreshReplacement();
      } else {
        selectApplicationSession({ selection, gateway, sessionKey: `agent:${agentId}:main` });
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(selection.state.selectedId).toBe(agentId);
      expect(sessions.state.result).toBe(heldMain);
      expect(sessions.state).toMatchObject({ loading: true, agentId: "main" });
      expect(request).toHaveBeenLastCalledWith(
        "sessions.list",
        expect.objectContaining({ agentId, includeGlobal: true, includeDerivedTitles: true }),
      );

      replacement.resolve(sessionsResult([incoming], 30));
      await vi.advanceTimersByTimeAsync(0);
      await sameOwnerRefresh;
      expect(sessions.state).toMatchObject({
        agentId,
        loading: false,
        result: { ts: 30, count: 1, sessions: [incoming] },
      });
      const current = sessions.state.result?.sessions[0];
      expect({ title: current?.derivedTitle, preview: current?.lastMessagePreview }).toEqual({
        title: incoming.derivedTitle,
        preview: preview ?? (agentId === "main" ? main.lastMessagePreview : undefined),
      });
    } finally {
      sessions.dispose();
      replacement.resolve(sessionsResult([incoming], 30));
      await vi.advanceTimersByTimeAsync(0);
      await sameOwnerRefresh;
    }
  });

  it("discards a delayed default-agent bootstrap after the route selects another agent", async () => {
    const bootstrap = createDeferred<SessionsListResult>();
    const writerList = createDeferred<SessionsListResult>();
    const writerResult = sessionsResult(
      [row("agent:writer:dashboard:one", 2), row("agent:writer:dashboard:two")],
      1,
    );
    const request = listRequest((params) =>
      params?.agentId === "writer" ? writerList.promise : bootstrap.promise,
    );
    const { gateway, selection, sessions, connect } = createSubscriptionHydrationHarness(request);
    const publishedAgents = recordAgents(sessions);
    try {
      connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledWith(
        "sessions.subscribe",
        {},
        { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
      );
      expect(request).toHaveBeenCalledWith(
        "sessions.list",
        expect.objectContaining({ agentId: "main" }),
      );

      selectApplicationSession({ selection, gateway, sessionKey: "agent:writer:dashboard:one" });
      bootstrap.resolve(runningSessionsResult());
      await vi.advanceTimersByTimeAsync(0);

      expect(publishedAgents).toEqual([]);
      expect(sessions.state.result).toBeNull();
      expect(request).toHaveBeenCalledWith(
        "sessions.list",
        expect.objectContaining({ agentId: "writer" }),
      );
      writerList.resolve(writerResult);
      await vi.advanceTimersByTimeAsync(0);

      expectRoster(sessions, "writer", writerResult);
      expect(new Set(publishedAgents)).toEqual(new Set(["writer"]));
    } finally {
      sessions.dispose();
      bootstrap.resolve(runningSessionsResult());
      writerList.resolve(writerResult);
    }
  });

  it.each([false, true])("retains the writer roster across reconnect=%s", async (reconnect) => {
    const { gateway, selection, sessions, connect, disconnect, request, result } = writerHarness(
      reconnect,
      reconnect ? null : "writer",
    );
    const writerQuery = { agentId: "writer", search: "draft", archived: true, limit: 25 };
    if (!reconnect) {
      expect(gateway.snapshot.assistantAgentId).toBeNull();
      expect(selection.state.selectedId).toBe("writer");
    }
    connect();
    await vi.advanceTimersByTimeAsync(0);
    if (reconnect) {
      expect(sessions.state.agentId).toBe("main");
      await sessions.refresh({
        agentId: "main",
        search: "draft",
        archivedFilter: "archived",
        limit: 25,
        force: true,
      });
      disconnect();
      selection.set("writer");
      connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenLastCalledWith(
        "sessions.list",
        expect.objectContaining(writerQuery),
      );
    } else {
      expect(request).toHaveBeenCalledWith(
        "sessions.list",
        expect.objectContaining({ agentId: "writer" }),
      );
    }
    expectRoster(sessions, "writer", result);
    const requestsBeforeScopeChange = request.mock.calls.length;
    if (reconnect) {
      await sessions.refreshReplacement();
      expect(request).toHaveBeenLastCalledWith(
        "sessions.list",
        expect.objectContaining(writerQuery),
      );
    } else {
      selection.setScope(null);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(selection.state).toEqual({ selectedId: "writer", scopeId: null });
      expect(request).toHaveBeenCalledTimes(requestsBeforeScopeChange);
    }
    expectRoster(sessions, "writer", result);
  });
});
