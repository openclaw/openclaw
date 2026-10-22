// Bound ACP events must persist a coherent source or target session owner.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockSubsystemLogger } from "../../../test/helpers/mock-subsystem-logger.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { heartbeatNotifications } from "../../infra/heartbeat-events.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../server-chat-state.js";
import { registerRpcSourceForTest } from "./rpc-source-fixtures.test-support.js";

const agentEventHandlerMocks = vi.hoisted(() => ({
  create: vi.fn(),
  persistLifecycle: vi.fn(async (_params: unknown) => {}),
}));
vi.mock("../../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../../audit/audit-config.js", () => ({
  isAuditLedgerEnabled: () => false,
  isExecutionIdentityCollectionEnabled: () => false,
  resolveAuditMessageMode: () => "off",
}));
vi.mock("../../audit/audit-recorder.js", () => ({
  createAuditEventRecorder: () => ({
    record: vi.fn(),
    recordTool: vi.fn(),
    stop: vi.fn(async () => {}),
  }),
}));
vi.mock("../server-chat.js", () => ({
  createAgentEventHandler: (...args: unknown[]) => agentEventHandlerMocks.create(...args),
}));
vi.mock("../session-lifecycle-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-lifecycle-state.js")>()),
  prepareGatewaySessionLifecycleEvent: (params: unknown) => () =>
    agentEventHandlerMocks.persistLifecycle(params),
}));
const { startGatewayEventSubscriptions } = await import("../server-runtime-subscriptions.js");
type SubscriptionParams = Parameters<typeof startGatewayEventSubscriptions>[0];
const mockLog = createMockSubsystemLogger("gateway-test", { isEnabled: () => true });
function createParams(): SubscriptionParams {
  const chatRunState = createChatRunState();
  return {
    scheduler: createTestGatewayScheduler(),
    signal: new AbortController().signal,
    log: mockLog,
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    nodeHasSessionSubscribers: () => false,
    nodeSendToSession: vi.fn(),
    agentRunSeq: new Map(),
    chatRunState,
    toolEventRecipients: chatRunState.toolEventRecipients,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    restartRecoveryCandidates: new Map(),
    refreshConnectedUserProfiles: vi.fn(),
  };
}

describe("bound ACP terminal lifecycle", () => {
  let unsubs: ReturnType<typeof startGatewayEventSubscriptions> | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await unsubs?.agentUnsub();
    heartbeatNotifications.onEvent = () => {};
    unsubs?.transcriptUnsub();
    unsubs?.lifecycleUnsub();
    resetAgentEventsForTest();
  });
  it.each([false, true])(
    "keeps bound ACP terminal ownership together (chat link=%s)",
    async (linked) => {
      const runId = "bound-acp-terminal";
      const sourceKey = "agent:main:dashboard:source";
      const targetKey = "agent:claude:acp:target";
      const params = createParams();
      const registration = registerRpcSourceForTest({
        runId,
        agentId: "main",
        sessionId: "source-session",
        sessionKey: sourceKey,
      });
      if (linked) {
        params.chatRunState.registry.add(runId, {
          clientRunId: runId,
          sessionKey: sourceKey,
          agentId: "main",
        });
      }
      agentEventHandlerMocks.create.mockReturnValue(Object.assign(vi.fn(), { dispose: vi.fn() }));
      unsubs = startGatewayEventSubscriptions(params);
      try {
        emitAgentEvent({
          runId,
          sessionKey: targetKey,
          agentId: "claude",
          stream: "lifecycle",
          data: { phase: "end", endedAt: 3_000, completionSource: "reply-dispatch" },
        });
        await vi.waitFor(() =>
          expect(agentEventHandlerMocks.persistLifecycle).toHaveBeenCalledOnce(),
        );
        expect(agentEventHandlerMocks.persistLifecycle).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKey: linked ? sourceKey : targetKey,
            agentId: linked ? "main" : "claude",
          }),
        );
      } finally {
        registration.cleanup();
      }
    },
  );
});
