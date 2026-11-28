import "../../test-utils/prepare-compiled-subprocesses.js";
import { expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
} from "../../infra/outbound/session-binding-service.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import * as routedReplies from "./route-reply.js";
import * as handoff from "./session-event-handoff.js";
import {
  configureEventState,
  runEventFixture,
  startEmbeddedTurn,
} from "./session-event.test-support.js";

// mock-isolation: Use synthetic model execution with real event admission and delivery planning.
vi.mock("../../agents/embedded-agent-runner/run.js", () => ({
  runEmbeddedAgent: vi.fn(),
}));
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);
// Match Gateway startup: activate the real reply runtimes before timing turn authority.
await Promise.all([
  import("../dispatch.js"),
  import("./get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

const requesterRoute = { channel: "telegram", to: "synthetic-requester-chat" };

const destinations: Record<
  string,
  { sessionKey: string; entry: Partial<SessionEntry>; delivered: boolean; threadBound?: true }
> = {
  "hidden subagent": {
    sessionKey: "agent:main:subagent:synthetic-worker",
    entry: { spawnedBy: "agent:main:main", spawnDepth: 1 },
    delivered: false,
  },
  "hidden dashboard child": {
    sessionKey: "agent:main:dashboard:synthetic-hidden-child",
    entry: { spawnedBy: "agent:main:main", spawnDepth: 1 },
    delivered: false,
  },
  "thread-bound subagent": {
    sessionKey: "agent:main:subagent:synthetic-thread-worker",
    entry: { spawnedBy: "agent:main:main", spawnDepth: 1 },
    delivered: true,
    threadBound: true,
  },
  "visible spawned session": {
    sessionKey: "agent:main:dashboard:synthetic-visible-child",
    entry: { spawnedBy: "agent:main:main", spawnDepth: 1, createdVia: "spawn" },
    delivered: true,
  },
  "ordinary session": {
    sessionKey: "agent:main:synthetic-ordinary-chat",
    entry: {},
    delivered: true,
  },
};

it.for(Object.keys(destinations))(
  "sends a background wake reply to the requester chat only from an interactive session: %s",
  async (name, { signal, onTestFinished }) => {
    const destination = destinations[name];
    if (!destination) {
      throw new Error(`Unknown destination ${name}`);
    }
    await runEventFixture("session-event-hidden-subagent", onTestFinished, async (state) => {
      await configureEventState(state);
      sessionBindingTesting.resetSessionBindingAdaptersForTests();
      onTestFinished(() => sessionBindingTesting.resetSessionBindingAdaptersForTests());
      if (destination.threadBound) {
        // The user talks to this worker in its own bound thread, so its replies belong there.
        registerSessionBindingAdapter({
          channel: "telegram",
          accountId: "default",
          listBySession: (key) =>
            key === destination.sessionKey
              ? [
                  {
                    bindingId: "synthetic-thread-binding",
                    targetSessionKey: key,
                    targetKind: "subagent",
                    conversation: {
                      channel: "telegram",
                      accountId: "default",
                      conversationId: "synthetic-worker-thread",
                    },
                    status: "active",
                    boundAt: 1,
                  },
                ]
              : [],
          resolveByConversation: () => null,
        });
      }
      const scope = { agentId: "main", sessionKey: destination.sessionKey };
      // The child inherited the chat its requester was using when the task started.
      await replaceSessionEntry(scope, {
        sessionId: "synthetic-child-session",
        lifecycleRevision: "synthetic-revision",
        updatedAt: Date.now(),
        sessionStartedAt: Date.now(),
        permissionMode: "full",
        delivery: normalizeSessionDeliveryState({ context: requesterRoute }),
        ...destination.entry,
      });
      runEmbeddedAgentMock
        .mockReset()
        .mockImplementation(async (params: RunEmbeddedAgentParams) => {
          await startEmbeddedTurn(params, "background wake admission");
          return { payloads: [{ text: "Worker follow-up result" }], meta: { durationMs: 1 } };
        });
      const route = vi
        .spyOn(routedReplies, "routePreparedReply")
        .mockResolvedValue({ ok: true, delivered: true });
      try {
        // A finished command or tool handoff wakes the session with the chat its tool captured.
        const receipt = handoff.enqueueSessionEventForHost("Background command finished.", {
          ...scope,
          source: "exec",
          abortSignal: signal,
          expectedTarget: await handoff.captureSessionEventTargetForHost(
            scope.agentId,
            scope.sessionKey,
          ),
          deliveryContext: requesterRoute,
        });
        expect(await receipt.accepted).toEqual({ ok: true });
        const outcome = await receipt.settled;
        expect(outcome, JSON.stringify(outcome)).toMatchObject({
          status: "completed",
          executionStarted: true,
          delivered: destination.delivered,
        });
        expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
        expect(route.mock.calls.length > 0).toBe(destination.delivered);
      } finally {
        route.mockRestore();
      }
    });
  },
);
