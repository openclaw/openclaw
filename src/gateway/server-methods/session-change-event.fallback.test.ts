import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  createSessionCapabilityHarness,
  sessionsResult,
} from "../../../ui/src/lib/sessions/session-capability.test-support.js";
import { createTestGatewayClient } from "../../../ui/src/test-helpers/gateway-client.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginRuntimeCapabilityLease } from "../../plugins/capability-lease.js";
import { createPluginServiceGatewayEvents } from "../../plugins/gateway-events.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { SerializedGatewayFrame } from "../serialized-json.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { createGatewayConnectionState } from "../server-connection-state.js";
import { gatewayConnect } from "../server/client-fixtures.test-support.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import { createInertGatewayTestSocket } from "../server/inert-socket.test-support.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import { emitSessionsChanged, flushPendingSessionsChangedEvents } from "./session-change-event.js";

function pluginNotices(pluginId: string) {
  const lease = createPluginRuntimeCapabilityLease(pluginId);
  const notices = vi.fn();
  createPluginServiceGatewayEvents({ pluginId, broadcast: vi.fn(), lease })!.onSessionsChanged(
    notices,
  );
  return { lease, notices };
}

function expectFrame(frames: unknown[], payload: unknown) {
  expect(frames).toEqual([expect.objectContaining({ event: "sessions.changed", payload })]);
}

afterEach(async () => {
  await flushPendingSessionsChangedEvents();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["ready", "preparation"] as const)(
  "publishes private repository facts or refreshes subscribers after %s preparation",
  async (failure) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const cfg = { agents: { entries: { main: {} } } };
      const sessionKey = "agent:main:dashboard:incognito-fallback";
      const repository = await getSessionRepositoryWorkspaceStore().create({
        agentId: "main",
        sessionKey,
        url: "https://github.com/synthetic/private-event.git",
        branch: "private-event",
        assertCurrent: () => {},
      });
      await replaceSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "private-session",
          updatedAt: 1,
          incognito: true,
          label: "Private label",
          repositoryWorkspaceId: repository.workspaceId,
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
      const send = vi.fn((frame: string | Buffer | SerializedGatewayFrame) => {
        const decoded = JSON.parse(frame.toString());
        frames.push(decoded);
        emitEvent(decoded);
      });
      const recipient = {
        connId: "conn-1",
        usesSharedGatewayAuth: false,
        connect: gatewayConnect(["operator.admin"], { id: "test", mode: "test", version: "1" }, 4),
        socket: createInertGatewayTestSocket(send),
      } satisfies GatewayWsClient;
      connection.clients.add(recipient);
      const noRead = vi.fn();
      connection.clients.add({
        ...recipient,
        connId: "no-read",
        connect: { ...recipient.connect, scopes: [] },
        socket: { ...recipient.socket, send: noRead },
      });
      const { lease, notices } = pluginNotices("fallback-proof");
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
        getRuntimeConfig: () => cfg,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1", "no-read"]),
      };
      try {
        await sessions.refresh({ agentId: "main", force: true });
        const initialReads = request.mock.calls.length;
        if (failure === "preparation") {
          vi.spyOn(projection, "withPreparedExactRows").mockRejectedValueOnce(
            new Error("synthetic preparation failure"),
          );
          vi.useFakeTimers();
        }
        emitSessionsChanged(context, {
          sessionKey,
          sessionId: "private-session",
          reason: "patch",
          compacted: true,
          catalogChanged: true,
        });
        await flushPendingSessionsChangedEvents(context);
        if (failure === "ready") {
          expect(reads).toMatchObject([{ describe: 0, snapshot: 0 }]);
          expectFrame(
            frames,
            expect.objectContaining({
              sessionKey,
              reason: "patch",
              session: expect.objectContaining({
                sessionId: "private-session",
                repository: { url: repository.url, branch: repository.branch },
              }),
            }),
          );
          expect(noRead).not.toHaveBeenCalled();
          expect(projection.selectEntries()).toEqual([]);
          return;
        }
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
        expectFrame(frames, {
          reason: "update",
          agentId: "main",
          catalogChanged: true,
          ts: expect.any(Number),
        });
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
        await connection.mentionInbox.dispose();
        projection.dispose();
        memorySessionActorOwners.closeDatabase({
          agentId: "main",
          path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
        });
        vi.useRealTimers();
      }
    });
  },
);

it.each(["main", "global"])(
  "keeps fallback plugin notices bound to the configured %s owner",
  async (sessionKey) => {
    const canonicalKey = sessionKey === "main" ? "agent:ops:inbox" : "global";
    const cfg: OpenClawConfig =
      sessionKey === "main"
        ? { session: { mainKey: "inbox" }, agents: { entries: { ops: {} } } }
        : {
            session: { scope: "global", store: "/stores/shared.sqlite" },
            agents: {
              ownership: "explicit",
              defaults: { sessionStore: { agentId: "ops" } },
              entries: { ops: {}, research: {} },
            },
          };
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const projection = createSessionRowProjectionFixture({ cfg, agentId: "ops", store: {} });
      vi.spyOn(projection, "withPreparedExactRows").mockRejectedValue(
        new Error("synthetic preparation failure"),
      );
      const broadcaster = createGatewayBroadcaster({ clients: new GatewayClientRegistry() });
      const broadcast = vi.fn(broadcaster.broadcastToConnIds);
      const { lease, notices } = pluginNotices("fallback-scope");
      const context = {
        ...bindSessionRowProjection({}, () => projection),
        broadcastToConnIds: broadcast,
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
