// @vitest-environment node
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { describe, expect, it, vi } from "vitest";
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

describe("session selection hydration", () => {
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
      vi.useFakeTimers();
      const writer = createDeferred<SessionsListResult>();
      const subscription = createDeferred<{ subscribed: boolean }>();
      let subscriptions = 0;
      const result = (agentId: string, ts: number) =>
        sessionsResult([{ key: `agent:${agentId}:main`, kind: "direct", updatedAt: ts }], ts);
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
      const publishedAgents: Array<string | null> = [];
      const stop = sessions.subscribe((state) => {
        if (state.result) {
          publishedAgents.push(state.agentId);
        }
      });
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
        await vi.advanceTimersByTimeAsync(200);
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
        stop();
        sessions.dispose();
        await superseded;
        selection.dispose();
        coordinator.reset();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    {
      name: "different owners with the same SID",
      agentId: "writer",
      sameSid: true,
      preview: undefined,
    },
    { name: "the same owner and SID", agentId: "main", sameSid: true, preview: undefined },
    { name: "different owners and SIDs", agentId: "writer", sameSid: false, preview: undefined },
    { name: "a present Work preview", agentId: "writer", sameSid: true, preview: "Work preview" },
  ])("keeps presentation with its owner across $name", async ({ agentId, sameSid, preview }) => {
    vi.useFakeTimers();
    const sharedSid = "00000000-0000-4000-8000-000000000101";
    const main: GatewaySessionRow = {
      key: "global",
      agentId: "main",
      sessionId: sharedSid,
      kind: "global",
      derivedTitle: "Main conversation",
      lastMessagePreview: "Main preview",
      updatedAt: 10,
    };
    const mainWithoutPreview: GatewaySessionRow = {
      key: main.key,
      agentId: main.agentId,
      sessionId: main.sessionId,
      kind: main.kind,
      derivedTitle: main.derivedTitle,
      updatedAt: 20,
    };
    const incoming: GatewaySessionRow = {
      key: "global",
      agentId,
      sessionId: sameSid ? sharedSid : "00000000-0000-4000-8000-000000000102",
      kind: "global",
      derivedTitle: agentId === "main" ? "Main current title" : "Work current title",
      ...(preview === undefined ? {} : { lastMessagePreview: preview }),
      updatedAt: 30,
    };
    const replacement = createDeferred<SessionsListResult>();
    let replacing = false;
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.list") {
        if (params?.includeLastMessage) {
          expect(params.agentId).toBe("main");
          return sessionsResult([main], 10);
        }
        expect(params?.includeLastMessage).toBeUndefined();
        expect(params?.agentId).toBe(replacing ? agentId : "main");
        return replacing ? replacement.promise : sessionsResult([mainWithoutPreview], 20);
      }
      throw new Error(`Unexpected request: ${method}`);
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
      expect(sessions.state.loading).toBe(true);
      expect(sessions.state.result).toBe(heldMain);
      expect(sessions.state.agentId).toBe("main");
      expect(request).toHaveBeenLastCalledWith(
        "sessions.list",
        expect.objectContaining({ agentId, includeGlobal: true, includeDerivedTitles: true }),
      );

      replacement.resolve(sessionsResult([incoming], 30));
      await vi.advanceTimersByTimeAsync(0);
      await sameOwnerRefresh;
      expect(sessions.state.agentId).toBe(agentId);
      expect(sessions.state.loading).toBe(false);
      expect(sessions.state.result).toMatchObject({ ts: 30, count: 1, sessions: [incoming] });
      const current = sessions.state.result?.sessions[0];
      expect(current?.derivedTitle).toBe(incoming.derivedTitle);
      expect(current?.lastMessagePreview).toBe(
        preview ?? (agentId === "main" ? main.lastMessagePreview : undefined),
      );
    } finally {
      sessions.dispose();
      replacement.resolve(sessionsResult([incoming], 30));
      await vi.advanceTimersByTimeAsync(0);
      await sameOwnerRefresh;
      vi.useRealTimers();
    }
  });

  it("discards a delayed default-agent bootstrap after the route selects another agent", async () => {
    vi.useFakeTimers();
    const bootstrap = createDeferred<SessionsListResult>();
    const writerList = createDeferred<SessionsListResult>();
    const writerResult = sessionsResult(
      [
        { key: "agent:writer:dashboard:one", kind: "direct", updatedAt: 2 },
        { key: "agent:writer:dashboard:two", kind: "direct", updatedAt: 1 },
      ],
      1,
    );
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.list") {
        return params?.agentId === "writer" ? writerList.promise : bootstrap.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { gateway, selection, sessions, connect } = createSubscriptionHydrationHarness(request);
    const publishedAgents: Array<string | null> = [];
    const stop = sessions.subscribe((next) => {
      if (next.result) {
        publishedAgents.push(next.agentId);
      }
    });
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

      selectApplicationSession({
        selection,
        gateway,
        sessionKey: "agent:writer:dashboard:one",
      });
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

      expect(sessions.state.agentId).toBe("writer");
      expect(sessions.state.result?.sessions).toEqual(writerResult.sessions);
      expect(new Set(publishedAgents)).toEqual(new Set(["writer"]));
    } finally {
      stop();
      sessions.dispose();
      bootstrap.resolve(runningSessionsResult());
      writerList.resolve(writerResult);
      vi.useRealTimers();
    }
  });

  it("hydrates the saved agent before hello and retains its roster when page scope widens", async () => {
    vi.useFakeTimers();
    const writerResult = sessionsResult(
      [{ key: "agent:writer:dashboard:one", kind: "direct", updatedAt: 1 }],
      1,
    );
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      const list = params?.agentId === "writer" ? writerResult : sessionsResult([], 1);
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.list") {
        return list;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { gateway, selection, sessions, connect } = createSubscriptionHydrationHarness(
      request,
      "writer",
    );
    try {
      expect(gateway.snapshot.assistantAgentId).toBeNull();
      expect(selection.state.selectedId).toBe("writer");
      connect();
      await vi.advanceTimersByTimeAsync(0);

      expect(request).toHaveBeenCalledWith(
        "sessions.list",
        expect.objectContaining({ agentId: "writer" }),
      );
      expect(sessions.state.agentId).toBe("writer");
      expect(sessions.state.result?.sessions).toEqual(writerResult.sessions);
      const requestsBeforeScopeChange = request.mock.calls.length;

      selection.setScope(null);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(selection.state).toEqual({ selectedId: "writer", scopeId: null });
      expect(sessions.state.agentId).toBe("writer");
      expect(sessions.state.result?.sessions).toEqual(writerResult.sessions);
      expect(request).toHaveBeenCalledTimes(requestsBeforeScopeChange);
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("retains an offline agent selection and list filters through reconnect refreshes", async () => {
    vi.useFakeTimers();
    const writerResult = sessionsResult(
      [{ key: "agent:writer:draft", kind: "direct", updatedAt: 1, archived: true }],
      1,
    );
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      const list = params?.agentId === "writer" ? writerResult : sessionsResult([], 1);
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.list") {
        return list;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { selection, sessions, connect, disconnect } =
      createSubscriptionHydrationHarness(request);
    const writerQuery = { agentId: "writer", search: "draft", archived: true, limit: 25 };
    try {
      connect();
      await vi.advanceTimersByTimeAsync(0);
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
      expect(sessions.state.agentId).toBe("writer");
      expect(sessions.state.result?.sessions).toEqual(writerResult.sessions);

      await sessions.refreshReplacement();

      expect(request).toHaveBeenLastCalledWith(
        "sessions.list",
        expect.objectContaining(writerQuery),
      );
      expect(sessions.state.agentId).toBe("writer");
      expect(sessions.state.result?.sessions).toEqual(writerResult.sessions);
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });
});
