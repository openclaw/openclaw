import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  emitAgentEventForOwner,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
} from "../../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";

const persist = vi.hoisted(() => vi.fn());
vi.mock("../session-lifecycle-state.js", () => ({
  persistGatewaySessionLifecycleEvent: persist,
  isRestartRecoveryLifecycleEvent: () => false,
}));
vi.mock("../../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../session-utils.js", () => ({
  loadGatewaySessionEntryReadOnly: () => ({ entry: undefined }),
  loadGatewaySessionLifecycleSnapshot: () => ({ row: undefined }),
}));
vi.mock("../../logger.js", () => ({ logError: vi.fn(), logWarn: vi.fn() }));

import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../server-chat.js";
import { createSessionLifecyclePersistenceOwner } from "../session-lifecycle-persistence-owner.js";

afterEach(() => {
  resetAgentEventsForTest({ preserveListeners: true });
  vi.clearAllMocks();
});

it("cannot commit a start after its exact producer claim retires during persistence", async () => {
  const gate = createDeferred();
  let status = "queued";
  persist.mockImplementation(
    async (
      params: Parameters<
        typeof import("../session-lifecycle-state.js").persistGatewaySessionLifecycleEvent
      >[0],
    ) => {
      await gate.promise;
      params.assertCommitAllowed?.();
      status = "running";
    },
  );
  const owner = createSessionLifecyclePersistenceOwner();
  const chatRunState = createChatRunState();
  const handler = createAgentEventHandler({
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    nodeSendToSession: vi.fn(),
    agentRunSeq: new Map(),
    chatRunState,
    resolveSessionKeyForRun: () => "agent:main:selected",
    clearAgentRunContext: vi.fn(),
    toolEventRecipients: chatRunState.toolEventRecipients,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    persistGatewaySessionLifecycleEventForEvent: owner.persist,
  });
  const runId = "activity-start-owner";
  const claimId = claimAgentRunContext(
    runId,
    { sessionKey: "agent:main:selected", sessionId: "selected-session" },
    { exclusive: true, trackOwner: true },
  );
  expect(claimId).toBeDefined();
  if (!claimId) {
    throw new Error("fixture did not acquire the producer claim");
  }
  const unsubscribe = onAgentRuntimeEvent(handler);
  try {
    emitAgentEventForOwner(
      {
        runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: Date.now() },
      },
      claimId,
    );
    expect(persist).toHaveBeenCalledOnce();
    releaseAgentRunContext(runId, claimId);
    gate.resolve();
    await Promise.allSettled(persist.mock.results.map((result) => result.value));
    expect(status).toBe("queued");
  } finally {
    gate.resolve();
    unsubscribe();
    handler.dispose();
    await owner.drain();
  }
});
