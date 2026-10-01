import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { NodeEventContext } from "./server-node-events-types.js";

const requestHeartbeat = vi.hoisted(() => vi.fn());
vi.mock("../infra/heartbeat-wake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/heartbeat-wake.js")>()),
  requestHeartbeat,
}));

const { handleNodeEvent } = await import("./server-node-events.js");

afterEach(resetSystemEventsForTest);

it.each([
  { name: "explicit notification", event: "notifications.changed", explicit: true },
  { name: "system-agent notification", event: "notifications.changed", explicit: false },
  { name: "authorized exec completion", event: "exec.finished", explicit: true },
  { name: "unmatched exec completion", event: "exec.finished", explicit: true, denied: true },
])("preserves the loaded global owner for $name", async ({ name, event, explicit, denied }) => {
  requestHeartbeat.mockClear();
  resetSystemEventsForTest();
  await withOpenClawTestState(
    { label: "node-event-owner", layout: "state-only" },
    async (state) => {
      const config = {
        agents: {
          ownership: "explicit" as const,
          defaults: { systemAgent: { agentId: "research" } },
          entries: { main: {}, research: {} },
        },
        session: {
          scope: "global" as const,
          store: path.join(state.stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
      };
      setRuntimeConfigSnapshot(config, config);
      for (const agentId of ["main", "research"]) {
        await replaceSessionEntry(
          { agentId, sessionKey: "global" },
          { sessionId: `${agentId}-session`, updatedAt: 1 },
        );
      }
      const authorizeNodeSystemRunEvent = vi.fn(() => !denied);
      const ctx: NodeEventContext = {
        deps: {},
        broadcast: () => {},
        nodeSendToSession: () => {},
        nodeSubscribe: () => {},
        nodeUnsubscribe: () => {},
        broadcastVoiceWakeChanged: () => {},
        addChatRun: () => {},
        removeChatRun: () => undefined,
        chatAbortControllers: new Map(),
        dedupe: new Map(),
        agentRunSeq: new Map(),
        getHealthCache: () => null,
        refreshHealthSnapshot: async () => {
          throw new Error("Unexpected health refresh");
        },
        loadGatewayModelCatalog: async () => [],
        authorizeNodeSystemRunEvent,
        logGateway: { warn: vi.fn() },
      };
      const runId = `node-owner-${name}`;
      const result = await handleNodeEvent(
        ctx,
        "node-owner",
        {
          event,
          payloadJSON: JSON.stringify({
            ...(explicit ? { sessionKey: "agent:research:main" } : {}),
            change: "posted",
            key: "notification-owner",
            title: "Owned notification",
            runId,
            exitCode: 0,
            output: "owned exec result",
          }),
        },
        { connId: "owner-connection" },
      );

      expect(peekSystemEvents("agent:main:global")).toEqual([]);
      if (event === "exec.finished") {
        expect(authorizeNodeSystemRunEvent).toHaveBeenCalledExactlyOnceWith({
          nodeId: "node-owner",
          connId: "owner-connection",
          runId,
          sessionKey: "agent:research:main",
          terminal: true,
        });
      }
      if (denied) {
        expect(result).toMatchObject({ handled: false, reason: "unmatched_exec_event" });
        expect(peekSystemEvents("agent:research:global")).toEqual([]);
        expect(requestHeartbeat).not.toHaveBeenCalled();
        return;
      }
      expect(result).toBeUndefined();
      expect(peekSystemEvents("agent:research:global")).toEqual([
        expect.stringContaining(
          event === "exec.finished" ? "owned exec result" : "Owned notification",
        ),
      ]);
      expect(requestHeartbeat).toHaveBeenCalledExactlyOnceWith(
        event === "exec.finished"
          ? {
              source: "exec-event",
              intent: "event",
              reason: "exec-event",
              coalesceMs: 0,
              agentId: "research",
            }
          : {
              source: "notifications-event",
              intent: "event",
              reason: "notifications-event",
              agentId: "research",
              sessionKey: "global",
            },
      );
    },
  );
});
