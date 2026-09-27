import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { QueuedSessionDeliveryPayload } from "../infra/session-delivery-queue.records.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn<(typeof import("./session-utils.js"))["loadSessionEntry"]>(),
  requestHeartbeat: vi.fn(),
}));

vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadSessionEntry: mocks.loadSessionEntry,
}));
vi.mock("../infra/heartbeat-wake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/heartbeat-wake.js")>()),
  requestHeartbeat: mocks.requestHeartbeat,
}));

const { deliverQueuedSessionDelivery } = await import("./server-restart-sentinel.js");
const deliveryContext = { channel: "telegram", to: "42", accountId: "work", threadId: "7" };
const cases = [
  {
    name: "legacy system event",
    loadedAgentId: "research",
    payload: { kind: "systemEvent", sessionKey: "global", text: "resume work" },
  },
  {
    name: "stored system-event owner",
    loadedAgentId: "main",
    payload: {
      kind: "systemEvent",
      sessionKey: "global",
      agentId: "research",
      text: "resume work",
    },
  },
  {
    name: "agent turn without a route",
    loadedAgentId: "research",
    payload: {
      kind: "agentTurn",
      sessionKey: "global",
      message: "resume work",
      messageId: "resume-1",
    },
  },
  {
    name: "replaced agent-turn session",
    loadedAgentId: "research",
    payload: {
      kind: "agentTurn",
      sessionKey: "global",
      message: "resume work",
      messageId: "resume-1",
      expectedSessionId: "old-session",
      route: { ...deliveryContext, chatType: "direct" },
    },
  },
] satisfies Array<{
  name: string;
  loadedAgentId: string;
  payload: QueuedSessionDeliveryPayload;
}>;

beforeEach(() => {
  vi.clearAllMocks();
  resetSystemEventsForTest();
});

afterEach(resetSystemEventsForTest);

it.each(cases)(
  "binds $name to its destination without rewriting its queued key",
  async ({ loadedAgentId, payload }) => {
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      agentId: loadedAgentId,
      entry: { sessionId: "current-session", updatedAt: 1 },
      store: {},
      storePath: "/tmp/restart-owner/openclaw-agent.sqlite",
      canonicalKey: "global",
      storeKeys: ["global"],
      legacyKey: undefined,
    });
    const entry = {
      ...payload,
      sessionKey: "global",
      deliveryContext,
      id: "queued-1",
      enqueuedAt: 1,
      retryCount: 0,
    };
    const original = structuredClone(entry);
    enqueueSystemEvent("keep other agent", { sessionKey: "agent:main:global" });

    await deliverQueuedSessionDelivery({
      deps: {},
      entry,
      queueContext: captureOpenClawStateWorkerContext(),
    });

    expect(peekSystemEventEntries("agent:research:global")).toMatchObject([
      { text: "resume work", deliveryContext },
    ]);
    expect(peekSystemEvents("agent:main:global")).toEqual(["keep other agent"]);
    expect(mocks.requestHeartbeat).toHaveBeenCalledExactlyOnceWith({
      source: "restart-sentinel",
      intent: "immediate",
      reason: "wake",
      agentId: "research",
      sessionKey: "global",
    });
    expect(entry).toEqual(original);
  },
);

it("carries a persisted owner through global session lookup in an explicit roster", async () => {
  const actual = await vi.importActual<typeof import("./session-utils.js")>("./session-utils.js");
  mocks.loadSessionEntry.mockImplementation(actual.loadSessionEntry);
  await withOpenClawTestState(
    { label: "restart-queue-owner", layout: "state-only" },
    async (state) => {
      const config = {
        agents: { ownership: "explicit" as const, entries: { main: {}, research: {} } },
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

      await deliverQueuedSessionDelivery({
        deps: {},
        queueContext: captureOpenClawStateWorkerContext(),
        entry: {
          kind: "systemEvent",
          sessionKey: "global",
          agentId: "research",
          text: "resume work",
          deliveryContext,
          id: "stored-owner",
          enqueuedAt: 1,
          retryCount: 0,
        },
      });

      expect(peekSystemEvents("agent:research:global")).toEqual(["resume work"]);
      expect(peekSystemEvents("agent:main:global")).toEqual([]);
      expect(mocks.requestHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "research", sessionKey: "global" }),
      );
    },
  );
});
