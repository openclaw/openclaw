import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  createSessionCapabilityHarness,
  sessionsResult,
} from "../../../ui/src/lib/sessions/session-capability.test-support.js";
import { createTestGatewayClient } from "../../../ui/src/test-helpers/gateway-client.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginRuntimeCapabilityLease } from "../../plugins/capability-lease.js";
import { createPluginServiceGatewayEvents } from "../../plugins/gateway-events.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { createGatewayConnectionState } from "../server-connection-state.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import { emitSessionsChanged, flushPendingSessionsChangedEvents } from "./session-change-event.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["capture", "preparation", "canonical deferral"] as const)(
  "keeps private %s fallback fanout free of row reads and refreshes subscribers",
  async (failure) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      const sessionKey = "agent:main:dashboard:incognito-fallback";
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        {
          sessionId: "private-session",
          updatedAt: 1,
          incognito: true,
          label: "Private label",
        },
      );
      const projection = await createSessionRowProjection({ cfg });
      const connection = createGatewayConnectionState({
        scheduler: createTestGatewayScheduler(vi.isFakeTimers() ? "fake-timers" : undefined),
        bootId: "fallback-proof",
        cfg,
      });
      const detach = connection.attachSessionRowProjection(projection);
      const request = vi.fn(async () => sessionsResult([], 1));
      const client = createTestGatewayClient(request);
      const { sessions, emitEvent } = createSessionCapabilityHarness(client.request.bind(client));
      const frames: unknown[] = [];
      const send = vi.fn((frame: string) => {
        const decoded = JSON.parse(frame);
        frames.push(decoded);
        emitEvent(decoded);
      });
      const recipient = {
        connId: "conn-1",
        usesSharedGatewayAuth: false,
        connect: {
          minProtocol: 4,
          maxProtocol: 4,
          client: { id: "test", mode: "test", version: "1", platform: "test" },
          role: "operator",
          scopes: ["operator.admin"],
        },
        socket: {
          readyState: 1,
          bufferedAmount: 0,
          send,
          close: vi.fn(),
          terminate: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          once: vi.fn(),
        },
      } satisfies GatewayWsClient;
      connection.clients.add(recipient);
      const noRead = vi.fn();
      connection.clients.add({
        ...recipient,
        connId: "no-read",
        connect: { ...recipient.connect, scopes: [] },
        socket: { ...recipient.socket, send: noRead },
      });
      const lease = createPluginRuntimeCapabilityLease("fallback-proof");
      const notices = vi.fn();
      createPluginServiceGatewayEvents({
        pluginId: "fallback-proof",
        broadcast: vi.fn(),
        lease,
      })!.onSessionsChanged(notices);
      const reads: { describe: number; snapshot: number; sql: number }[] = [];
      const describe = vi.spyOn(projection, "describe");
      const snapshot = vi.spyOn(projection, "snapshot");
      const sql = [
        vi.spyOn(DatabaseSync.prototype, "exec"),
        ...(["all", "get", "iterate", "run"] as const).map((method) =>
          vi.spyOn(StatementSync.prototype, method),
        ),
      ];
      const broadcast = vi.fn((...args: Parameters<typeof connection.broadcastToConnIds>) => {
        describe.mockClear();
        snapshot.mockClear();
        sql.forEach((statement) => statement.mockClear());
        connection.broadcastToConnIds(...args);
        reads.push({
          describe: describe.mock.calls.length,
          snapshot: snapshot.mock.calls.length,
          sql: sql.reduce((count, statement) => count + statement.mock.calls.length, 0),
        });
      });
      const context = {
        ...bindSessionRowProjection({}, () => projection),
        broadcastToConnIds: broadcast,
        chatAbortControllers: connection.chatAbortControllers,
        getRuntimeConfig: () => cfg,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1", "no-read"]),
      };
      try {
        await sessions.refresh({ agentId: "main", force: true });
        const initialReads = request.mock.calls.length;
        if (failure === "capture") {
          vi.spyOn(projection, "capture").mockImplementationOnce(() => {
            throw new Error("synthetic capture failure");
          });
        } else if (failure === "preparation") {
          vi.spyOn(projection, "withPreparedExactRows").mockRejectedValueOnce(
            new Error("synthetic preparation failure"),
          );
        } else {
          vi.spyOn(projection, "withPreparedExactRows").mockResolvedValueOnce({
            kind: "pending",
            database: {
              agentId: "main",
              path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
            },
          });
        }
        vi.useFakeTimers();
        emitSessionsChanged(context, {
          sessionKey,
          sessionId: "private-session",
          reason: "patch",
          compacted: true,
          catalogChanged: true,
        });
        await flushPendingSessionsChangedEvents(context);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(reads).toEqual([
          { describe: 0, snapshot: 0, sql: 0 },
          { describe: 0, snapshot: 0, sql: 0 },
        ]);
        expect(notices).toHaveBeenCalledExactlyOnceWith({
          sessionKey,
          agentId: "main",
          reason: "patch",
        });
        expect(frames).toEqual([
          expect.objectContaining({
            event: "sessions.changed",
            payload: {
              reason: "update",
              agentId: "main",
              catalogChanged: true,
              ts: expect.any(Number),
            },
          }),
        ]);
        expect(noRead).not.toHaveBeenCalled();
        expect(broadcast.mock.calls[0]?.[2]).toEqual(new Set());
        expect(broadcast.mock.calls[1]?.[2]).toEqual(new Set(["conn-1", "no-read"]));
        expect(broadcast.mock.calls[1]?.[3]).toEqual({ agentId: "main", dropIfSlow: true });
        expect(request).toHaveBeenCalledTimes(initialReads + 1);
      } finally {
        await flushPendingSessionsChangedEvents(context);
        sql.forEach((statement) => statement.mockRestore());
        describe.mockRestore();
        snapshot.mockRestore();
        sessions.dispose();
        lease.revoke();
        detach();
        connection.mentionInbox.dispose();
        projection.dispose();
        vi.useRealTimers();
      }
    });
  },
);

const ownerCases: {
  name: string;
  cfg: OpenClawConfig;
  sessionKey: string;
  canonicalKey: string;
}[] = [
  {
    name: "configured main alias",
    cfg: { session: { mainKey: "inbox" }, agents: { entries: { ops: {} } } },
    sessionKey: "main",
    canonicalKey: "agent:ops:inbox",
  },
  {
    name: "fixed-store global owner",
    cfg: {
      session: { scope: "global", store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    },
    sessionKey: "global",
    canonicalKey: "global",
  },
];

it.each(ownerCases)(
  "keeps fallback plugin notices bound to the $name",
  async ({ cfg, sessionKey, canonicalKey }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const projection = createSessionRowProjectionFixture({ cfg, agentId: "ops", store: {} });
      vi.spyOn(projection, "capture").mockImplementation(() => {
        throw new Error("synthetic capture failure");
      });
      const broadcaster = createGatewayBroadcaster({ clients: new GatewayClientRegistry() });
      const broadcast = vi.fn(broadcaster.broadcastToConnIds);
      const lease = createPluginRuntimeCapabilityLease("fallback-scope");
      const notices = vi.fn();
      createPluginServiceGatewayEvents({
        pluginId: "fallback-scope",
        broadcast: vi.fn(),
        lease,
      })!.onSessionsChanged(notices);
      const context = {
        ...bindSessionRowProjection({}, () => projection),
        broadcastToConnIds: broadcast,
        chatAbortControllers: new Map(),
        getRuntimeConfig: () => cfg,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      };
      try {
        emitSessionsChanged(context, { sessionKey, reason: "patch" });
        await flushPendingSessionsChangedEvents(context);
        expect(notices).toHaveBeenCalledExactlyOnceWith({
          sessionKey: canonicalKey,
          agentId: "ops",
          reason: "patch",
        });
        expect(broadcast.mock.calls[1]?.slice(1)).toEqual([
          { reason: "update", agentId: "ops", ts: expect.any(Number) },
          new Set(["conn-1"]),
          { agentId: "ops", dropIfSlow: true },
        ]);
        emitSessionsChanged(context, {
          sessionKey: "agent:research:wrong-owner",
          agentId: "ops",
          reason: "patch",
        });
        await flushPendingSessionsChangedEvents(context);
        expect(notices).toHaveBeenCalledOnce();
        expect(broadcast).toHaveBeenCalledTimes(2);
      } finally {
        await flushPendingSessionsChangedEvents(context);
        lease.revoke();
        projection.dispose();
      }
    });
  },
);
