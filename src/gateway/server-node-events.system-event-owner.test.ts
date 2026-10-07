import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { NodeEventContext } from "./server-node-events-types.js";
import * as sessionStores from "./session-utils-store-worker.js";

const enqueueSessionEvent = vi.hoisted(() =>
  vi.fn((_text: string, _options: Record<string, unknown>) => ({
    accepted: Promise.resolve({ ok: true }),
    settled: Promise.resolve({ status: "completed" }),
  })),
);
vi.mock("../auto-reply/reply/session-event-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auto-reply/reply/session-event-handoff.js")>()),
  enqueueSessionEventForHost: enqueueSessionEvent,
}));

const { handleNodeEvent } = await import("./server-node-events.js");

function createNodeEventContext(
  authorizeNodeSystemRunEvent: NodeEventContext["authorizeNodeSystemRunEvent"],
): NodeEventContext {
  return {
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
}

afterEach(resetSystemEventsForTest);

it.each([
  { name: "explicit notification", event: "notifications.changed", explicit: true },
  { name: "system-agent notification", event: "notifications.changed", explicit: false },
  { name: "authorized exec completion", event: "exec.finished", explicit: true },
  { name: "unmatched exec completion", event: "exec.finished", explicit: true, denied: true },
])("preserves the loaded global owner for $name", async ({ name, event, explicit, denied }) => {
  enqueueSessionEvent.mockClear();
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
      const ctx = createNodeEventContext(authorizeNodeSystemRunEvent);
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
        expect(enqueueSessionEvent).not.toHaveBeenCalled();
        return;
      }
      expect(result).toBeUndefined();
      if (event === "notifications.changed") {
        expect(peekSystemEvents("agent:research:global")).toEqual([
          expect.stringContaining("Owned notification"),
        ]);
      }
      expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(
          event === "exec.finished" ? "owned exec result" : "Owned notification",
        ),
        expect.objectContaining({
          agentId: "research",
          sessionKey: "global",
          expectedTarget: expect.objectContaining({
            agentId: "research",
            sessionKey: "global",
            sessionId: "research-session",
          }),
        }),
      );
    },
  );
});

it.for(
  (["lookup", "capture", "connection"] as const).flatMap((stage) =>
    (["notification", "exec"] as const).map((kind) => ({ stage, kind })),
  ),
)(
  "rejects a config publication during $kind $stage preparation",
  async ({ stage, kind }, { signal }) => {
    enqueueSessionEvent.mockClear();
    await withOpenClawTestState(
      { label: "node-event-config-fence", layout: "state-only" },
      async (state) => {
        const config: OpenClawConfig = {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "research" } },
            entries: { main: {}, research: {} },
          },
          session: { store: path.join(state.sessionsDir("research"), "sessions.json") },
          tools: { exec: { notifyOnExit: true } },
        };
        setRuntimeConfigSnapshot(config, config);
        await replaceSessionEntry(
          { agentId: "research", sessionKey: "agent:research:main" },
          { sessionId: "research-session", updatedAt: 1 },
        );
        const entered = createDeferred();
        const release = createDeferred();
        const hold = async <T>(value: T): Promise<T> => {
          entered.resolve();
          await release.promise;
          return value;
        };
        const lookup = sessionStores.resolveGatewaySessionStoreTargetInWorker;
        const capture = sessionEvents.captureSessionEventTargetForHost;
        let targetCaptured = false;
        const lookupSpy = vi
          .spyOn(sessionStores, "resolveGatewaySessionStoreTargetInWorker")
          .mockImplementation(async (...args) => {
            const result = await lookup(...args);
            return stage === "lookup" ? hold(result) : result;
          });
        const captureSpy = vi
          .spyOn(sessionEvents, "captureSessionEventTargetForHost")
          .mockImplementation(async (...args) => {
            const result = await capture(...args);
            targetCaptured = true;
            return stage === "capture" ? hold(result) : result;
          });
        const authorize = vi.fn(() => true);
        const event = kind === "notification" ? "notifications.changed" : "exec.finished";
        const handling = handleNodeEvent(
          createNodeEventContext(authorize),
          "config-fence-node",
          {
            event,
            payloadJSON: JSON.stringify({
              ...(kind === "exec" ? { sessionKey: "agent:research:main" } : {}),
              change: "posted",
              key: `config-fence-${stage}`,
              title: "Owned notification",
              runId: `config-fence-${stage}`,
              exitCode: 0,
              output: "Owned exec output",
            }),
          },
          {
            isConnectionCurrent: () =>
              stage === "connection" && targetCaptured ? hold(true) : true,
          },
        );
        const outcome = handling.then(
          () => undefined,
          (error: unknown) => error,
        );
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              entered.promise,
              handling,
              "event settled before its preparation gate",
            ),
            signal,
          );
          const next = stage === "connection" ? config : structuredClone(config);
          next.agents!.defaults!.systemAgent = { agentId: "main" };
          next.session!.store = path.join(state.root, "replacement.sqlite");
          next.tools!.exec!.notifyOnExit = false;
          setRuntimeConfigSnapshot(next, next);
          release.resolve();
          const error = await withinTest(outcome, signal);
          expect(enqueueSessionEvent).not.toHaveBeenCalled();
          expect(peekSystemEvents("agent:research:main")).toEqual([]);
          expect(peekSystemEvents("agent:main:main")).toEqual([]);
          expect(authorize).not.toHaveBeenCalled();
          expect(String(error)).toContain("Node event configuration changed during preparation");
        } finally {
          release.resolve();
          await outcome;
          lookupSpy.mockRestore();
          captureSpy.mockRestore();
        }
      },
    );
  },
);
