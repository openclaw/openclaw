import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  emitAgentEventForRunContext,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
} from "../infra/agent-events.js";
import { getAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
  type AgentEventHandlerOptions,
} from "./server-chat.js";
import * as sessionEventRows from "./session-event-prepared-row.js";

const { logErrorMock } = vi.hoisted(() => ({ logErrorMock: vi.fn() }));

vi.mock("../logger.js", () => ({ logError: logErrorMock, logWarn: vi.fn() }));
vi.mock("../config/io.js", () => ({ getRuntimeConfig: vi.fn(() => ({})) }));
vi.mock("./session-utils.js", () => ({ loadGatewaySessionEntryReadOnly: vi.fn() }));

type ModelObservation = { provider: string | null; model: string | null };
const PRIMARY_MODEL: ModelObservation = { provider: "provider", model: "primary" };

function createHarness() {
  const runId = "run-model";
  registerAgentRunContext(runId, {
    agentId: "main",
    sessionKey: "session-1",
    sessionId: "original",
    projectSessionActive: true,
  });
  const owner = getAgentRunContext(runId)!;
  const broadcast = vi.fn<AgentEventHandlerOptions["broadcast"]>();
  const broadcastToConnIds = vi.fn<AgentEventHandlerOptions["broadcastToConnIds"]>();
  const persist = vi
    .fn<NonNullable<AgentEventHandlerOptions["persistGatewaySessionLifecycleEventForEvent"]>>()
    .mockResolvedValue(undefined);
  const chatRunState = createChatRunState();
  const sessionEventSubscribers = createSessionEventSubscriberRegistry();
  const handler = createAgentEventHandler({
    broadcast,
    broadcastToConnIds,
    nodeSendToSession: vi.fn(),
    nodeHasSessionSubscribers: () => false,
    agentRunSeq: new Map(),
    chatRunState,
    resolveSessionKeyForRun: () => owner.sessionKey,
    clearAgentRunContext: vi.fn(),
    toolEventRecipients: chatRunState.toolEventRecipients,
    sessionEventSubscribers,
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    loadGatewaySessionLifecycleSnapshotForEvent: (key) => ({
      row: {
        key,
        sessionId: owner.sessionId,
        kind: "direct",
        updatedAt: 1,
        status: "running",
        modelProvider: "selected",
        model: "configured",
        activeModelProvider: owner.activeModel?.provider,
        activeModel: owner.activeModel?.model,
      },
    }),
    persistGatewaySessionLifecycleEventForEvent: persist,
    resolveSessionActiveRunState: () => ({ active: true, runIds: [runId] }),
  });
  onTestFinished(onAgentRuntimeEvent(handler));
  return {
    runId,
    broadcast,
    broadcastToConnIds,
    persist,
    sessionEventSubscribers,
    changes: () =>
      broadcastToConnIds.mock.calls
        .filter(([event]) => event === "sessions.changed")
        .map(([, payload]) => payload),
    observe: (candidate: ModelObservation = PRIMARY_MODEL, sessionKey?: string) =>
      emitAgentEventForRunContext(
        { runId, sessionKey, stream: "lifecycle", data: { phase: "model", ...candidate } },
        owner,
      ),
  };
}

describe("agent model roster publications", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
    logErrorMock.mockReset();
  });
  afterEach(() => resetAgentEventsForTest());

  it("publishes candidate changes and clearing without persisting session selection", () => {
    const { runId, broadcast, changes, observe, persist, sessionEventSubscribers } =
      createHarness();
    sessionEventSubscribers.subscribe("conn-model");
    const candidates: ModelObservation[] = [
      PRIMARY_MODEL,
      { provider: "other-provider", model: "primary" },
      { provider: "other-provider", model: "fallback" },
      { provider: null, model: null },
    ];
    for (const candidate of candidates) {
      observe(candidate);
      observe(candidate);
    }
    expect(broadcast.mock.calls.filter(([event]) => event === "agent")).toHaveLength(8);
    expect(changes()).toHaveLength(4);
    for (const [index, { provider, model }] of candidates.entries()) {
      expect(changes()[index]).toMatchObject({
        phase: "model",
        modelProvider: "selected",
        model: "configured",
        activeModelProvider: provider,
        activeModel: model,
        hasActiveRun: true,
        activeRunIds: [runId],
        session: { activeModelProvider: provider, activeModel: model },
      });
      expect(changes()[index]).not.toHaveProperty("catalogChanged");
    }
    expect(persist).not.toHaveBeenCalled();
  });

  it("publishes unchanged candidates after visibility, receiver, or target changes", () => {
    const { runId, changes, observe, sessionEventSubscribers } = createHarness();
    observe();
    registerAgentRunContext(runId, { isControlUiVisible: false });
    sessionEventSubscribers.subscribe("conn-model");
    observe();
    expect(changes()).toHaveLength(0);
    registerAgentRunContext(runId, { isControlUiVisible: true });
    observe();
    observe();
    expect(changes()).toHaveLength(1);
    registerAgentRunContext(runId, { sessionId: "replacement" });
    observe();
    observe();
    expect(changes()).toHaveLength(2);
    expect(changes()[1]).toMatchObject({ session: { sessionId: "replacement" } });
    observe(PRIMARY_MODEL, "session-2");
    observe(PRIMARY_MODEL, "session-2");
    expect(changes()).toHaveLength(3);
    expect(changes()[2]).toMatchObject({
      sessionKey: "session-2",
      session: { key: "session-2", activeModel: "primary" },
    });
  });

  it("remembers the committed model after deferred row preparation", async () => {
    const { changes, observe, sessionEventSubscribers } = createHarness();
    sessionEventSubscribers.subscribe("conn-model");
    observe();
    const ready = Promise.withResolvers<void>();
    const preparation = vi
      .spyOn(sessionEventRows, "withPreparedSessionEventRow")
      .mockImplementationOnce(async (_projection, _key, _agentId, publish) => {
        await ready.promise;
        publish();
      });
    onTestFinished(() => preparation.mockRestore());
    const fallback = { provider: "provider", model: "fallback" };
    observe(fallback);
    const pending = preparation.mock.results[0]?.value;
    observe();
    ready.resolve();
    await pending;
    expect(changes()).toHaveLength(1);
    expect(changes()[0]).toMatchObject({ session: { activeModel: "primary" } });
    observe(fallback);
    observe(fallback);
    expect(changes()).toHaveLength(2);
    expect(changes()[1]).toMatchObject({ session: { activeModel: "fallback" } });
  });

  it("retries an unchanged model snapshot after publication fails", async () => {
    const { broadcastToConnIds, changes, observe, sessionEventSubscribers } = createHarness();
    sessionEventSubscribers.subscribe("conn-model");
    broadcastToConnIds.mockImplementationOnce(() => {
      throw new Error("publication failed");
    });
    observe();
    await Promise.resolve();
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("session snapshot publication failed"),
    );
    observe();
    observe();
    expect(changes()).toHaveLength(2);
    expect(changes()[1]).toMatchObject({ session: { activeModel: "primary" } });
  });
});
