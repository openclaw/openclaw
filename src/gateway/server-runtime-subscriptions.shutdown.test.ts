import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  loadSessionEntryReadOnly,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { GatewayConnectionWork } from "./server-connection-work.js";
import { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import * as sessionObserverModel from "./session-observer-model.js";

const runtimeConfigState = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => runtimeConfigState.value }));
vi.mock("../audit/audit-recorder.js", () => ({
  createAuditEventRecorder: () => ({
    record: vi.fn(),
    recordTool: vi.fn(),
    recordMessage: vi.fn(),
    recordExecutionIdentity: vi.fn(),
    recordExecutionDecision: vi.fn(),
    stop: vi.fn(async () => {}),
  }),
}));

function createParams(signal: AbortSignal): Parameters<typeof startGatewayEventSubscriptions>[0] {
  const chatRunState = createChatRunState();
  return {
    scheduler: createTestGatewayScheduler(),
    signal,
    log: createSubsystemLogger("test/subscriptions-shutdown"),
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    nodeHasSessionSubscribers: () => false,
    nodeSendToSession: vi.fn(),
    agentRunSeq: new Map(),
    chatRunState,
    toolEventRecipients: chatRunState.toolEventRecipients,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    chatAbortControllers: new Map(),
    restartRecoveryCandidates: new Map(),
    terminalSessions: { closeTaskSessions: vi.fn() },
    refreshConnectedUserProfiles: vi.fn(),
  };
}

it.each(["before startup", "before inherited connection drain"] as const)(
  "cancels auxiliary model work %s",
  async (phase) => {
    let unsubs: ReturnType<typeof startGatewayEventSubscriptions> | undefined;
    const testState = await createOpenClawTestState({ scenario: "minimal" });
    const connectionWork = new GatewayConnectionWork();
    const target = { key: "agent:main:shutdown-recap", agentId: "main" };
    const scope = {
      sessionKey: target.key,
      agentId: target.agentId,
      sessionId: "shutdown-recap",
    };
    const finish = createDeferred();
    const prepared = vi.spyOn(sessionObserverModel, "defaultPrepareModel").mockResolvedValue({
      config: {},
      authProfileId: undefined,
      provider: "test",
      model: "utility",
      agentId: "main",
      agentDir: testState.path("agent"),
      outputTextPolicy: "strict-visible",
    });
    const complete = vi.spyOn(sessionObserverModel, "defaultCompleteModel").mockImplementation(() =>
      trackAsyncWork(async () => {
        await finish.promise;
        return {
          text: "Finished.",
          provider: "test",
          model: "utility",
          owner: { kind: "harness", id: "test" },
        };
      }),
    );
    let draining: Promise<void> | undefined;
    try {
      runtimeConfigState.value = { agents: { defaults: { utilityModel: "test/utility" } } };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await persistSessionTranscriptTurn(scope, {
        messages: Array.from({ length: 70 }, (_, index) => ({
          eventId: `shutdown-message-${index}`,
          message: { role: "user", content: `Work ${index}` },
        })),
        touchSessionEntry: false,
      });
      if (phase === "before startup") {
        connectionWork.beginClose();
      }
      unsubs = startGatewayEventSubscriptions(createParams(connectionWork.signal));
      if (phase === "before startup") {
        expect(unsubs.sessionActivitySummaries.ensure(target).state).toBe("unavailable");
        expect(prepared).not.toHaveBeenCalled();
        expect(complete).not.toHaveBeenCalled();
        return;
      }
      await connectionWork.track(() => unsubs!.sessionActivitySummaries.ensure(target));
      await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
      const modelSignal = complete.mock.calls[0]![0].abortSignal!;
      let drained = false;
      draining = connectionWork.drain().then(() => {
        drained = true;
      });
      expect(modelSignal.aborted).toBe(true);
      expect(drained).toBe(false);
      finish.resolve();
      await draining;
      await unsubs.agentUnsub();
      expect(complete).toHaveBeenCalledOnce();
      expect(loadSessionEntryReadOnly(scope)?.activitySummary).toBeUndefined();
    } finally {
      finish.resolve();
      await unsubs?.agentUnsub();
      unsubs?.heartbeatUnsub();
      unsubs?.transcriptUnsub();
      unsubs?.lifecycleUnsub();
      await unsubs?.taskUnsub();
      unsubs = undefined;
      await draining;
      prepared.mockRestore();
      complete.mockRestore();
      await testState.cleanup();
    }
  },
);
