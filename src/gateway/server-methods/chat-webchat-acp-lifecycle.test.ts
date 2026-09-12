// Bound ACP events must persist a coherent source or target session owner.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { installInMemoryTaskRegistryRuntime } from "../../test-utils/task-registry-runtime.js";
import { registerChatAbortController } from "../chat-abort.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../server-chat-state.js";

const agentEventHandlerMocks = vi.hoisted(() => ({
  create: vi.fn(),
  persistLifecycle: vi.fn(async () => {}),
}));
vi.mock("../../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../../audit/audit-config.js", () => ({
  isAuditLedgerEnabled: () => false,
  isExecutionIdentityCollectionEnabled: () => false,
  resolveAuditMessageMode: () => "off",
}));
vi.mock("../../audit/audit-recorder.js", () => ({
  createAuditEventRecorder: () => ({ stop: vi.fn(async () => {}) }),
}));
vi.mock("../server-chat.js", () => ({
  createAgentEventHandler: (...args: unknown[]) => agentEventHandlerMocks.create(...args),
}));
vi.mock("../session-lifecycle-state.js", () => ({
  persistGatewaySessionLifecycleEvent: agentEventHandlerMocks.persistLifecycle,
}));
const { startGatewayEventSubscriptions } = await import("../server-runtime-subscriptions.js");
type SubscriptionParams = Parameters<typeof startGatewayEventSubscriptions>[0];
const mockLog: SubsystemLogger = {
  subsystem: "gateway-test",
  isEnabled: () => true,
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  raw: vi.fn(),
  child: () => mockLog,
};
function createParams(): SubscriptionParams {
  const chatRunState = createChatRunState();
  return {
    log: mockLog,
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    nodeSendToSession: vi.fn(),
    agentRunSeq: new Map(),
    chatRunState,
    toolEventRecipients: chatRunState.toolEventRecipients,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    chatAbortControllers: new Map(),
    restartRecoveryCandidates: new Map(),
    terminalSessions: { closeTaskSessions: vi.fn() },
  };
}
describe("bound ACP terminal lifecycle", () => {
  let unsubs: ReturnType<typeof startGatewayEventSubscriptions> | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    installInMemoryTaskRegistryRuntime();
  });
  afterEach(async () => {
    await unsubs?.agentUnsub();
    unsubs?.heartbeatUnsub();
    unsubs?.transcriptUnsub();
    unsubs?.lifecycleUnsub();
    void unsubs?.taskUnsub();
    resetAgentEventsForTest();
    resetTaskRegistryForTests({ persist: false });
  });
  it.each([false, true])(
    "keeps bound ACP terminal ownership together (chat link=%s)",
    async (linked) => {
      const runId = "bound-acp-terminal";
      const sourceKey = "agent:main:dashboard:source";
      const targetKey = "agent:claude:acp:target";
      const params = createParams();
      const registration = registerChatAbortController({
        chatAbortControllers: params.chatAbortControllers,
        runId,
        agentId: "main",
        sessionId: "source-session",
        sessionKey: sourceKey,
        timeoutMs: 60_000,
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
