import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureGatewayDeviceRevocation,
  readGatewayDeviceSourceAuthority,
} from "../../gateway/device-revocation.js";
import { readInProcessSessionDeliveryGeneration } from "../../gateway/in-process-session-delivery.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import * as sessionStateEvents from "../../sessions/session-state-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { createOpenClawTools } from "../openclaw-tools.js";
import "../test-helpers/fast-openclaw-tools-sessions.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import * as inProcessGateway from "./in-process-gateway.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import * as sessionsSendFollowup from "./sessions-send-followup.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";
import { createSessionsSendTool } from "./sessions-send-tool.js";

vi.mock("./sessions-send-tool.a2a.js", () => ({
  runSessionsSendA2AFlow: vi.fn(async () => {}),
}));

const requesterSessionKey = "agent:main:main";
const targetSessionKey = "agent:main:dashboard:admission-target";
const runId = "sessions-send-admission-run";
const config = {
  agents: { ownership: "explicit", entries: { main: {} } },
  session: { mainKey: "main", scope: "per-sender" },
  tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
} satisfies OpenClawConfig;

describe("sessions_send dispatch admission", () => {
  let state: OpenClawTestState;
  let registerWatch: MockInstance<typeof sessionStateEvents.registerSessionStateWatch>;

  beforeEach(async () => {
    state = await createOpenClawTestState({ scenario: "minimal" });
    setRuntimeConfigSnapshot(config);
    setActivePluginRegistry(createSessionConversationTestRegistry());
    resetGatewayWorkAdmission();
    vi.mocked(runSessionsSendA2AFlow).mockClear();
    registerWatch = vi.spyOn(sessionStateEvents, "registerSessionStateWatch");
    for (const [sessionKey, sessionId] of [
      [requesterSessionKey, "requester-session"],
      [targetSessionKey, "target-session"],
    ] as const) {
      await replaceSessionEntry(
        { agentId: "main", sessionKey },
        { sessionId, updatedAt: Date.now() },
      );
    }
  });

  afterEach(async () => {
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    registerWatch.mockRestore();
    resetGatewayWorkAdmission();
    await state.cleanup();
  });

  const callerKeys = [requesterSessionKey, "agent:main:telegram:direct:peer-1"];
  it.each(callerKeys)("retains accepted reply source (%s)", async (sourceKey) => {
    if (sourceKey !== requesterSessionKey) {
      await replaceSessionEntry(
        { agentId: "main", sessionKey: sourceKey },
        { sessionId: "key-only-requester", updatedAt: 1 },
      );
      await replaceSessionEntry(
        { agentId: "main", sessionKey: targetSessionKey },
        { sessionId: "target-session", updatedAt: 1, spawnedBy: sourceKey },
      );
    }
    const context = createContext();
    const owner = createOperatorClient({ profileName: "send-owner", scopes: ["operator.write"] });
    const source = captureGatewayDeviceRevocation(
      context,
      { deviceId: "send-device", role: "operator" },
      () => true,
    );
    const finish = createDeferredCore();
    vi.mocked(runSessionsSendA2AFlow).mockImplementationOnce(() => finish.promise);
    const callGateway = vi.fn();
    callGateway.mockImplementation(
      async (request: Parameters<AgentToolGatewayRequestCaller>[0]) => {
        if (request.method === "sessions.resolve") {
          return { key: targetSessionKey, agentId: "main" };
        }
        if (request.method === "sessions.list") {
          return { sessions: [{ key: targetSessionKey, agentId: "main", kind: "direct" }] };
        }
        if (request.method === "agent") {
          return { runId, status: "accepted" };
        }
        throw new Error(`Unexpected Gateway method: ${request.method}`);
      },
    );
    try {
      const result = await withPluginRuntimeGatewayRequestScope(
        {
          client: owner,
          context,
          isWebchatConnect: () => false,
          hasCurrentClientAuthority: source.isCurrent,
        },
        () =>
          withOperatorToolGatewayAuthority(
            {
              authenticatedUserProfile: owner.authenticatedUserProfile,
              scopes: owner.connect.scopes ?? [],
            },
            () =>
              withGatewayToolCallerIdentity(
                {
                  agentId: "main",
                  sessionKey: sourceKey,
                  gatewayContextResolver: () => context,
                  receiptAuthority: () => true,
                },
                () =>
                  createSessionsSendTool({
                    agentSessionKey: sourceKey,
                    config,
                    callGateway,
                    idempotencyKey: runId,
                  }).execute("send-followup", {
                    sessionKey: targetSessionKey,
                    message: "Continue the task",
                    mode: "followup",
                    timeoutSeconds: 0,
                  }),
              ),
          ),
      );
      expect(result.details).toMatchObject({
        status: "accepted",
        delivery: { status: "pending" },
      });
      expect(runSessionsSendA2AFlow).toHaveBeenCalledOnce();
      expect(runSessionsSendA2AFlow).toHaveBeenCalledWith(
        expect.objectContaining({ requesterSessionKey, targetSessionKey }),
      );
      source.release();
      expect(readGatewayDeviceSourceAuthority(source.isCurrent)?.()).toBe(true);
    } finally {
      finish.resolve();
      source.release();
    }
  });

  it.each([
    {
      name: "default numeric-thread",
      accountId: "default",
      sourceKey: requesterSessionKey,
      threadId: 42,
    },
    { name: "direct", accountId: "direct", sourceKey: requesterSessionKey, threadId: "42" },
    {
      name: "exact legacy DM",
      accountId: "default",
      sourceKey: "agent:main:telegram:direct:peer-1",
      threadId: "42",
    },
    {
      name: "current source over agent delivery fallback",
      accountId: "default",
      sourceKey: requesterSessionKey,
      threadId: "42",
    },
  ])(
    "preserves the original $name route when a later turn changes the shared session route",
    async ({ name, accountId, sourceKey, threadId }) => {
      const { runSessionsSendA2AFlow: runActualFlow } = await vi.importActual<
        typeof import("./sessions-send-tool.a2a.js")
      >("./sessions-send-tool.a2a.js");
      let completion: Record<string, unknown> | undefined;
      const settled = createDeferredCore();
      vi.mocked(runSessionsSendA2AFlow).mockImplementationOnce(async (params) => {
        try {
          await runActualFlow(params);
        } finally {
          settled.resolve();
        }
      });
      await replaceSessionEntry(
        { agentId: "main", sessionKey: sourceKey },
        { sessionId: "requester-session", updatedAt: 1, lifecycleRevision: "original-generation" },
      );
      await replaceSessionEntry(
        { agentId: "main", sessionKey: targetSessionKey },
        { sessionId: "target-session", updatedAt: 1, spawnedBy: sourceKey },
      );
      const callGateway = vi.fn();
      callGateway.mockImplementation(
        async (request: Parameters<AgentToolGatewayRequestCaller>[0]) => {
          if (request.method === "sessions.resolve") {
            return { key: targetSessionKey, agentId: "main" };
          }
          if (request.method === "sessions.list") {
            return { sessions: [{ key: targetSessionKey, agentId: "main", kind: "direct" }] };
          }
          if (request.method === "agent.wait") {
            return {
              status: "ok",
              terminalReply: { disposition: "visible", text: "Task complete" },
            };
          }
          if (request.method === "agent") {
            if (!isRecord(request.params)) {
              throw new Error("Expected agent request parameters");
            }
            if (request.params.sessionKey === targetSessionKey) {
              await replaceSessionEntry(
                { agentId: "main", sessionKey: sourceKey },
                {
                  sessionId: "requester-session",
                  updatedAt: 2,
                  lifecycleRevision: "original-generation",
                  delivery: normalizeSessionDeliveryState({
                    context: { channel: "telegram", accountId: "other", to: "later-recipient" },
                  }),
                },
              );
              return { runId };
            }
            completion = request.params;
            return { runId: "completion-run" };
          }
          throw new Error(`Unexpected Gateway method: ${request.method}`);
        },
      );
      const gateway = vi
        .spyOn(inProcessGateway, "callAgentToolGatewayRequest")
        .mockImplementation(callGateway);
      // This routing fixture supplies a run-scoped Gateway, not a native task
      // receipt. Keep its real A2A/route assertions at that explicit boundary;
      // retained core authority and custody have separate owner/integration proof.
      const prepareFollowup = vi
        .spyOn(sessionsSendFollowup, "prepareSessionsSendFollowup")
        .mockResolvedValue(undefined);
      try {
        const tool = createOpenClawTools({
          agentSessionKey: sourceKey,
          sessionId: "requester-session",
          agentChannel: "telegram",
          agentAccountId: accountId,
          agentTo: "original-recipient",
          agentThreadId: threadId,
          ...(name === "current source over agent delivery fallback"
            ? {
                agentTo: "stale-recipient",
                agentThreadId: 99,
                currentMessagingTarget: "original-recipient",
                currentChannelId: "native-channel-id",
                currentThreadTs: "42",
              }
            : {}),
          config,
          disableMessageTool: true,
          disablePluginTools: true,
          wrapBeforeToolCallHook: false,
        }).find((candidate) => candidate.name === "sessions_send");
        expect(tool).toBeDefined();
        const result = await tool!.execute("send-routed-task", {
          sessionKey: targetSessionKey,
          message: "Complete this task",
          mode: "followup",
          timeoutSeconds: 0,
        });
        expect(result.details).toMatchObject({
          status: "accepted",
          delivery: { status: "pending" },
        });
        await settled.promise;
        expect(completion).toMatchObject({
          sessionKey: sourceKey,
          expectedExistingSessionId: "requester-session",
          expectedExistingSessionLifecycleRevision: "original-generation",
          channel: "telegram",
          accountId,
          to: "original-recipient",
          threadId: "42",
          deliver: false,
          sourceReplyDeliveryMode: "message_tool_only",
        });
      } finally {
        prepareFollowup.mockRestore();
        gateway.mockRestore();
      }
    },
  );

  it("keeps an opaque self-send on its admitted source route after a later inbound turn", async () => {
    const sessionKey = "agent:main:direct:identity-linked-person";
    const originalRoute = { channel: "telegram", accountId: "default", to: "original-recipient" };
    const laterRoute = { channel: "telegram", accountId: "other", to: "later-recipient" };
    const { runSessionsSendA2AFlow: runActualFlow } = await vi.importActual<
      typeof import("./sessions-send-tool.a2a.js")
    >("./sessions-send-tool.a2a.js");
    const settled = createDeferredCore();
    vi.mocked(runSessionsSendA2AFlow).mockImplementationOnce(async (params) => {
      try {
        await runActualFlow(params);
      } finally {
        settled.resolve();
      }
    });
    const entry = {
      sessionId: "self-session",
      updatedAt: 1,
      lifecycleRevision: "original-generation",
    };
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      { ...entry, delivery: normalizeSessionDeliveryState({ context: originalRoute }) },
    );
    const callGateway = vi.fn();
    callGateway.mockImplementation(
      async (request: Parameters<AgentToolGatewayRequestCaller>[0]) => {
        switch (request.method) {
          case "sessions.resolve":
            return { key: sessionKey, agentId: "main" };
          case "sessions.list":
            return {
              sessions: [{ key: sessionKey, agentId: "main", deliveryContext: laterRoute }],
            };
          case "agent":
            await replaceSessionEntry(
              { agentId: "main", sessionKey },
              {
                ...entry,
                updatedAt: 2,
                delivery: normalizeSessionDeliveryState({ context: laterRoute }),
              },
            );
            return { runId };
          case "agent.wait":
            return {
              status: "ok",
              terminalReply: { disposition: "visible", text: "Task complete" },
            };
          case "send":
            return { messageId: "final-reply" };
          default:
            throw new Error(`Unexpected Gateway method: ${request.method}`);
        }
      },
    );
    const gateway = vi
      .spyOn(inProcessGateway, "callAgentToolGatewayRequest")
      .mockImplementation(callGateway);
    try {
      const tool = createOpenClawTools({
        agentSessionKey: sessionKey,
        sessionId: entry.sessionId,
        agentChannel: originalRoute.channel,
        agentAccountId: originalRoute.accountId,
        currentMessagingTarget: originalRoute.to,
        config,
        disableMessageTool: true,
        disablePluginTools: true,
        wrapBeforeToolCallHook: false,
      }).find((candidate) => candidate.name === "sessions_send");
      expect(tool).toBeDefined();
      const result = await tool!.execute("self-followup", {
        sessionKey,
        message: "Complete this task",
        mode: "followup",
        timeoutSeconds: 0,
      });
      expect(result.details).toMatchObject({ status: "accepted", delivery: { status: "pending" } });
      await settled.promise;
      const requests = callGateway.mock.calls.map(([request]) => request);
      expect.soft(requests.filter((request) => request.method === "agent")).toEqual([
        expect.objectContaining({
          params: expect.objectContaining({
            ...originalRoute,
            sessionKey,
            deliver: false,
            sourceReplyDeliveryMode: "message_tool_only",
            inputProvenance: expect.objectContaining({
              kind: "inter_session",
              sourceSessionKey: sessionKey,
            }),
          }),
        }),
      ]);
      expect.soft(requests.filter((request) => request.method === "send")).toEqual([
        expect.objectContaining({
          params: expect.objectContaining({ ...originalRoute, message: "Task complete" }),
        }),
      ]);
      const sendParams = requests.find((request) => request.method === "send")?.params;
      expect(readInProcessSessionDeliveryGeneration(sendParams)).toMatchObject({
        agentId: "main",
        sessionKey,
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
      });
      expect(sendParams).toHaveProperty("idempotencyKey", `sessions-send:${runId}`);
      expect(sendParams).not.toHaveProperty("sessionGeneration");
    } finally {
      gateway.mockRestore();
    }
  });

  it.each([
    { admission: "rejected", timeoutSeconds: 0 },
    { admission: "rejected", timeoutSeconds: 1 },
    { admission: "pending", timeoutSeconds: 0 },
    { admission: "pending", timeoutSeconds: 1 },
  ] as const)(
    "does not install a watch or start A2A when admission is $admission (wait $timeoutSeconds)",
    async ({ admission, timeoutSeconds }) => {
      const requests: Parameters<AgentToolGatewayRequestCaller>[0][] = [];
      const callGateway = vi.fn();
      callGateway.mockImplementation(
        async (request: Parameters<AgentToolGatewayRequestCaller>[0]) => {
          requests.push(request);
          if (request.method === "sessions.resolve") {
            return { key: targetSessionKey, agentId: "main" };
          }
          if (request.method === "sessions.list") {
            return { sessions: [{ key: targetSessionKey, agentId: "main", kind: "direct" }] };
          }
          if (request.method === "agent") {
            if (admission === "rejected") {
              throw new Error("Task admission failed before dispatch");
            }
            return { runId, status: "in_flight", admissionPending: true };
          }
          if (request.method === "agent.wait") {
            return { status: "timeout" };
          }
          throw new Error(`Unexpected Gateway method: ${request.method}`);
        },
      );
      const tool = createSessionsSendTool({
        agentSessionKey: requesterSessionKey,
        config,
        callGateway,
        idempotencyKey: runId,
      });

      const result = await tool.execute("send-followup", {
        sessionKey: targetSessionKey,
        message: "Continue the requested task.",
        mode: "followup",
        watch: true,
        timeoutSeconds,
      });

      expect.soft(result.details).toMatchObject({
        status: "error",
        runId,
        sessionKey: targetSessionKey,
        error:
          admission === "rejected"
            ? "Task admission failed before dispatch"
            : expect.stringMatching(/admission|unconfirmed|pending/i),
      });
      if (admission === "pending") {
        expect.soft(result.details).toMatchObject({
          sentBeforeError: true,
          error: expect.stringMatching(/(?:inspect|check).*before.*retry/i),
        });
      } else {
        expect.soft(result.details).not.toHaveProperty("sentBeforeError");
      }
      expect.soft(registerWatch).not.toHaveBeenCalled();
      expect.soft(runSessionsSendA2AFlow).not.toHaveBeenCalled();
      expect.soft(requests.filter((request) => request.method === "agent")).toHaveLength(1);
      expect.soft(requests.some((request) => request.method === "agent.wait")).toBe(false);
    },
  );
});
