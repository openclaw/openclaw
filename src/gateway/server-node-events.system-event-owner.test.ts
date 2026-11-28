import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  enqueueSystemEventEntry,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { NodeEventContext } from "./server-node-events-types.js";

const enqueueSessionEvent = vi.hoisted(() =>
  vi.fn(() => ({
    id: "node-event-receipt",
    cancel: () => true,
    accepted: Promise.resolve({ ok: true as const }),
    settled: Promise.resolve({
      status: "completed" as const,
      executionStarted: true,
      delivered: false,
    }),
  })),
);
vi.mock("../auto-reply/reply/session-event-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auto-reply/reply/session-event-handoff.js")>()),
  enqueueSessionEventForHost: enqueueSessionEvent,
}));

const { handleNodeEvent } = await import("./server-node-events.js");

afterEach(resetSystemEventsForTest);

it.each([
  { name: "explicit notification", event: "notifications.changed", explicit: true },
  { name: "system-agent notification", event: "notifications.changed", explicit: false },
  { name: "authorized exec completion", event: "exec.finished", explicit: true },
  { name: "unmatched exec completion", event: "exec.finished", explicit: true, denied: true },
  { name: "rejected notification", event: "notifications.changed", explicit: true, rejected: true },
  { name: "rejected exec completion", event: "exec.finished", explicit: true, rejected: true },
])(
  "preserves the loaded global owner for $name",
  async ({ name, event, explicit, denied, rejected }) => {
    enqueueSessionEvent.mockClear();
    resetSystemEventsForTest();
    await withOpenClawTestState({ label: "node-owner", layout: "state-only" }, async (state) => {
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
      const ctx: NodeEventContext = {
        deps: {},
        broadcast: () => {},
        nodeSendToSession: () => {},
        nodeSubscribe: () => {},
        nodeUnsubscribe: () => {},
        broadcastVoiceWakeChanged: () => {},
        addChatRun: () => {},
        removeChatRun: () => undefined,
        dedupe: new Map(),
        agentRunSeq: new Map(),
        getHealthCache: () => null,
        refreshHealthSnapshot: async () => {
          throw new Error("Unexpected health refresh");
        },
        loadGatewayModelCatalog: async () => [],
        authorizeNodeSystemRunEvent: () => !denied,
        logGateway: { warn: vi.fn() },
      };
      const runId = `node-owner-${name}`;
      if (rejected) {
        enqueueSystemEventEntry("Unrelated pending occurrence", {
          sessionKey: "agent:research:global",
        });
        enqueueSessionEvent.mockImplementationOnce(() => {
          throw new Error("Session event admission rejected");
        });
      }
      const request = handleNodeEvent(
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
      let result;
      if (rejected) {
        await expect(request).rejects.toThrow("Session event admission rejected");
      } else {
        result = await request;
      }

      expect(peekSystemEvents("agent:main:global")).toEqual([]);
      expect(result).toEqual(
        denied
          ? expect.objectContaining({ handled: false, reason: "unmatched_exec_event" })
          : undefined,
      );
      const text = event === "exec.finished" ? "owned exec result" : "Owned notification";
      expect(peekSystemEvents("agent:research:global")).toEqual(
        rejected ? ["Unrelated pending occurrence"] : denied ? [] : [expect.stringContaining(text)],
      );
      const handoff = {
        source: event === "exec.finished" ? "node" : "device",
        agentId: "research",
        sessionKey: "global",
        expectedTarget: expect.objectContaining({
          agentId: "research",
          sessionKey: "global",
          sessionId: "research-session",
        }),
      };
      if (denied) {
        expect(enqueueSessionEvent).not.toHaveBeenCalled();
      } else {
        expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining(text),
          expect.objectContaining(handoff),
        );
      }
    });
  },
);
