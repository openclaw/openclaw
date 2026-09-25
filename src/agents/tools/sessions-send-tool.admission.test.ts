import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  drainFormattedDelegatedSystemEvents,
  drainFormattedSystemEvents,
} from "../../auto-reply/reply/session-system-events.js";
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
import * as execApprovalsStore from "../../infra/exec-approvals-store.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "../../infra/system-events.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import * as sessionStateEvents from "../../sessions/session-state-events.js";
import { readUserTurnDelegatedInputPolicy } from "../../sessions/user-turn-transcript.metadata.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { createOpenClawCodingToolsInternal } from "../agent-tools.js";
import { captureDelegatedExecRestriction } from "../delegated-exec-policy.js";
import { setActiveEmbeddedRun } from "../embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing as embeddedRunsTesting,
} from "../embedded-agent-runner/runs.test-support.js";
import { emptyDelegatedToolParameterPolicy } from "../inherited-tool-parameters.js";
import * as inheritedToolPolicy from "../inherited-tool-policy.js";
import { captureInheritedToolPolicy } from "../inherited-tool-policy.js";
import type {
  InheritedToolPolicyRef,
  InheritedToolPolicyV2,
} from "../inherited-tool-policy.schema.js";
import { createOpenClawTools } from "../openclaw-tools.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import "../test-helpers/fast-openclaw-tools-sessions.js";
import * as inProcessGateway from "./in-process-gateway.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
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
    embeddedRunsTesting.resetActiveEmbeddedRuns();
    resetSystemEventsForTest();
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
    embeddedRunsTesting.resetActiveEmbeddedRuns();
    resetSystemEventsForTest();
    resetGatewayWorkAdmission();
    await state.cleanup();
  });

  const policy = (...executionAllow: string[]) =>
    captureInheritedToolPolicy({
      policies: [],
      executionAllow,
      parameters: emptyDelegatedToolParameterPolicy(),
    });
  const sourcePolicy = () => policy("read", "sessions_send");
  const callAsSource = <T>(run: () => Promise<T>, isCurrent = () => true) =>
    withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: requesterSessionKey,
        operationalRunInstance: { runId: "source-run", instanceId: "source-instance" },
        receiptAuthority: isCurrent,
      },
      run,
    );
  const resolveTarget = vi
    .fn()
    .mockImplementation(async (request: Parameters<AgentToolGatewayRequestCaller>[0]) => {
      if (request.method === "sessions.resolve") {
        return { key: targetSessionKey, agentId: "main" };
      }
      if (request.method === "sessions.list") {
        return { sessions: [{ key: targetSessionKey, agentId: "main", kind: "direct" }] };
      }
      throw new Error(`Unexpected Gateway method: ${request.method}`);
    });

  it.each([
    { receiver: "compatible names", broader: false, commandPolicy: undefined },
    { receiver: "broader names", broader: true, commandPolicy: undefined },
    { receiver: "configured allowlist only", broader: false, commandPolicy: "configured" },
    { receiver: "installed inherited allowlist", broader: false, commandPolicy: "installed" },
    { receiver: "exec denied", broader: false, commandPolicy: "denied" },
  ] as const)(
    "checks the actual active receiver before steering ($receiver)",
    async ({ broader, commandPolicy }) => {
      const source = commandPolicy ? policy("exec", "sessions_send") : sourcePolicy();
      const receiving = commandPolicy
        ? policy("exec")
        : broader
          ? policy("read", "exec")
          : policy("read");
      if (commandPolicy) {
        source.parameters.exec = [
          captureDelegatedExecRestriction({
            host: "gateway",
            security: "allowlist",
            ask: "off",
            safeBins: ["cat"],
          }).restriction,
        ];
        receiving.parameters.exec =
          commandPolicy === "denied"
            ? [captureDelegatedExecRestriction({ host: "gateway", security: "deny" }).restriction]
            : source.parameters.exec;
      }
      const rejected = broader || commandPolicy === "configured";
      let sourceAlive = true;
      const release = vi.fn();
      const addPolicies = vi.fn((_policies: readonly InheritedToolPolicyV2[]) => release);
      const queued = vi.fn<
        NonNullable<
          ReturnType<typeof createEmbeddedRunHandle>["messageInjectionV2"]
        >["queueMessage"]
      >(async (_text, options, assertCurrent) => {
        assertCurrent();
        expect(addPolicies).toHaveBeenCalledExactlyOnceWith([source]);
        expect(
          readUserTurnDelegatedInputPolicy(
            await options?.userTurnTranscriptRecorder?.resolveMessage(),
          ),
        ).toEqual(source);
        options?.onQueueAccepted?.(true);
        sourceAlive = false;
        assertCurrent();
      });
      const handle = createEmbeddedRunHandle({
        runId: "target-run",
        supportsTranscriptCommitWait: true,
      });
      handle.messageInjectionV2 = { version: 2, isAvailable: () => true, queueMessage: queued };
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: targetSessionKey,
          embeddedRunToolAuthorityBinding: () => ({
            source: "attempt",
            assertActive: () => {},
            project: () => undefined,
            getInheritedToolPolicy: () => receiving,
            getEnforcedDelegatedToolParameterPolicy: () =>
              commandPolicy === "installed" ? source.parameters : undefined,
            addDelegatedInputPolicies: addPolicies,
          }),
        },
        () => setActiveEmbeddedRun("target-session", handle, targetSessionKey),
      );
      const result = await callAsSource(
        () =>
          createSessionsSendTool({
            agentSessionKey: requesterSessionKey,
            config,
            callGateway: resolveTarget,
            captureInheritedToolPolicyForDelegation: async () => {
              const captured = source;
              return {
                policy: captured,
                assertCurrent: () => {
                  if (source !== captured) {
                    throw new Error("Session send source policy changed");
                  }
                },
              };
            },
          }).execute("delegated-steer", {
            sessionKey: targetSessionKey,
            message: "Assess this task",
            mode: "steer",
            timeoutSeconds: 0,
          }),
        () => sourceAlive,
      );
      expect(result.details).toMatchObject({ status: rejected ? "error" : "accepted" });
      expect(queued).toHaveBeenCalledTimes(rejected ? 0 : 1);
      expect(addPolicies).toHaveBeenCalledTimes(rejected ? 0 : 1);
      expect(release).not.toHaveBeenCalled();
    },
  );

  async function prepareNativeDelegation(security: "deny" | "full", ask: "off" | "always") {
    const receiverKey = "agent:helper:dashboard:native-floor-target";
    const nativeConfig = {
      ...config,
      agents: { ownership: "explicit", entries: { main: {}, helper: {} } },
      tools: { ...config.tools, profile: "full", exec: { host: "gateway", mode: "full" } },
    } satisfies OpenClawConfig;
    setRuntimeConfigSnapshot(nativeConfig);
    execApprovalsStore.saveExecApprovals({
      version: 1,
      defaults: { security: "full", ask: "off", askFallback: "deny" },
      agents: { main: { security, ask }, helper: { security: "full", ask: "off" } },
    });
    await replaceSessionEntry(
      { agentId: "helper", sessionKey: receiverKey },
      { sessionId: "native-receiver-session", updatedAt: 1 },
    );
    const makeTools = (
      agentId: "main" | "helper",
      ref: InheritedToolPolicyRef,
      signal?: AbortSignal,
    ) =>
      createOpenClawCodingToolsInternal({
        config: nativeConfig,
        agentId,
        sessionKey: agentId === "main" ? requesterSessionKey : receiverKey,
        sessionId: agentId === "main" ? "requester-session" : "native-receiver-session",
        workspaceDir: state.workspaceDir,
        agentDir: state.agentDir(agentId),
        senderIsOwner: true,
        inheritedToolPolicyRef: ref,
        abortSignal: signal,
        wrapBeforeToolCallHook: false,
      }).find((tool) => tool.name === "sessions_send")!;
    const receiverRef: InheritedToolPolicyRef = {};
    const receiverTool = makeTools("helper", receiverRef);
    const queued = vi.fn<
      NonNullable<ReturnType<typeof createEmbeddedRunHandle>["messageInjectionV2"]>["queueMessage"]
    >(async (_text, options, assertCurrent) => {
      assertCurrent();
      await options?.userTurnTranscriptRecorder?.resolveMessage();
      options?.onQueueAccepted?.(true);
    });
    const acceptedPolicies = vi.fn((_policies: readonly InheritedToolPolicyV2[]) => () => {});
    const handle = createEmbeddedRunHandle({
      runId: "native-receiver-run",
      supportsTranscriptCommitWait: true,
    });
    handle.messageInjectionV2 = { version: 2, isAvailable: () => true, queueMessage: queued };
    await withGatewayToolCallerIdentity(
      {
        agentId: "helper",
        sessionKey: receiverKey,
        embeddedRunToolAuthorityBinding: () => ({
          source: "attempt",
          assertActive: () => {},
          project: () => undefined,
          getInheritedToolPolicy: () => receiverRef.current!,
          addDelegatedInputPolicies: acceptedPolicies,
        }),
      },
      () => setActiveEmbeddedRun("native-receiver-session", handle, receiverKey),
    );
    const gateway = vi
      .spyOn(inProcessGateway, "callAgentToolGatewayRequest")
      .mockImplementation(async (request) => {
        if (request.method === "sessions.resolve") {
          return { key: receiverKey, agentId: "helper" };
        }
        if (request.method === "sessions.list") {
          return { sessions: [{ key: receiverKey, agentId: "helper", kind: "direct" }] };
        }
        throw new Error(`Unexpected Gateway method: ${request.method}`);
      });
    const send = (tool: typeof receiverTool, agentId: "main" | "helper" = "main") =>
      withGatewayToolCallerIdentity(
        {
          agentId,
          sessionKey: agentId === "main" ? requesterSessionKey : receiverKey,
          operationalRunInstance: { runId: `native-${agentId}`, instanceId: `native-${agentId}` },
          receiptAuthority: () => true,
        },
        () =>
          tool.execute("native-source-delegation", {
            sessionKey: receiverKey,
            message: "Assess this task",
            mode: "steer",
            timeoutSeconds: 0,
          }),
      );
    return { makeTools, receiverTool, queued, acceptedPolicies, gateway, send };
  }

  it.each([
    { security: "deny", ask: "off", rejected: true },
    { security: "full", ask: "always", rejected: true },
    { security: "full", ask: "off", rejected: false },
  ] as const)(
    "checks native source agent approval floors before registered steering ($security/$ask)",
    async ({ security, ask, rejected }) => {
      const native = await prepareNativeDelegation(security, ask);
      try {
        const source = native.makeTools("main", {});
        expect(source).toBeDefined();
        const result = await native.send(source);
        expect(result.details).toMatchObject({ status: rejected ? "error" : "accepted" });
        if (rejected) {
          expect(result.details).toMatchObject({
            error: "receiver exec policy does not retain the source restriction",
          });
        }
        expect(native.queued).toHaveBeenCalledTimes(rejected ? 0 : 1);
        expect(native.acceptedPolicies).toHaveBeenCalledTimes(rejected ? 0 : 1);
        // The receiver's own ordinary work keeps its full policy after a rejected source input.
        const control = await native.send(native.receiverTool, "helper");
        expect(control.details).toMatchObject({ status: "accepted" });
        expect(native.queued).toHaveBeenCalledTimes(rejected ? 1 : 2);
      } finally {
        native.gateway.mockRestore();
      }
    },
  );

  it.each(["aborted", "replaced"] as const)(
    "rejects a native source generation %s during its readonly approval capture",
    async (retirement) => {
      const native = await prepareNativeDelegation("full", "off");
      const sourceRef: InheritedToolPolicyRef = {};
      const abort = new AbortController();
      const source = native.makeTools("main", sourceRef, abort.signal);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const captureSettled = createDeferredCore();
      const capture = inheritedToolPolicy.captureDelegatedSourceToolPolicy;
      const captureOwner = vi
        .spyOn(inheritedToolPolicy, "captureDelegatedSourceToolPolicy")
        .mockImplementationOnce(async (params) => {
          try {
            return await capture(params);
          } finally {
            captureSettled.resolve();
          }
        });
      const load = execApprovalsStore.loadExecApprovalsReadOnlyAsync;
      const reader = vi
        .spyOn(execApprovalsStore, "loadExecApprovalsReadOnlyAsync")
        .mockImplementationOnce(async (options) => {
          const approvals = await load(options);
          entered.resolve();
          await release.promise;
          return approvals;
        });
      const attempt = native.send(source);
      try {
        expect(
          await Promise.race([entered.promise.then(() => true), attempt.then(() => false)]),
        ).toBe(true);
        const replacement =
          retirement === "replaced" ? native.makeTools("main", sourceRef) : undefined;
        if (retirement === "aborted") {
          abort.abort(new Error("Native source retired"));
        }
        release.resolve();
        if (retirement === "aborted") {
          await expect(attempt).rejects.toThrow("Aborted");
        } else {
          expect((await attempt).details).toMatchObject({ status: "forbidden" });
        }
        await captureSettled.promise;
        expect(native.gateway).not.toHaveBeenCalled();
        expect(native.queued).not.toHaveBeenCalled();
        expect(native.acceptedPolicies).not.toHaveBeenCalled();
        const control = await native.send(
          replacement ?? native.receiverTool,
          replacement ? "main" : "helper",
        );
        expect(control.details).toMatchObject({ status: "accepted" });
        expect(native.queued).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await attempt.catch(() => {});
        if (captureOwner.mock.calls.length) {
          await captureSettled.promise;
        }
        captureOwner.mockRestore();
        reader.mockRestore();
        native.gateway.mockRestore();
      }
    },
  );

  it("rejects a source policy change during target lookup before starting any turn", async () => {
    let source = sourcePolicy();
    const callGateway = vi.fn();
    callGateway.mockImplementation(
      async (request: Parameters<AgentToolGatewayRequestCaller>[0]) => {
        const result = await resolveTarget(request);
        source = policy("read");
        return result;
      },
    );
    const result = await callAsSource(() =>
      createSessionsSendTool({
        agentSessionKey: requesterSessionKey,
        config,
        callGateway,
        captureInheritedToolPolicyForDelegation: async () => {
          const captured = source;
          return {
            policy: captured,
            assertCurrent: () => {
              if (source !== captured) {
                throw new Error("Session send source policy changed");
              }
            },
          };
        },
      }).execute("changed-source", {
        sessionKey: targetSessionKey,
        message: "Assess this task",
        mode: "followup",
        timeoutSeconds: 0,
      }),
    );
    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("source policy changed"),
    });
    expect(callGateway.mock.calls.map(([request]) => request.method)).not.toContain("agent");
  });

  it("preserves delegated notification order without blocking an ordinary event", async () => {
    const sources = [sourcePolicy(), policy("read", "exec", "sessions_send")];
    for (const [index, source] of sources.entries()) {
      const result = await callAsSource(() =>
        createSessionsSendTool({
          agentSessionKey: requesterSessionKey,
          config,
          callGateway: resolveTarget,
          captureInheritedToolPolicyForDelegation: async () => {
            const captured = source;
            return {
              policy: captured,
              assertCurrent: () => {
                if (source !== captured) {
                  throw new Error("Session send source policy changed");
                }
              },
            };
          },
        }).execute("delegated-notify", {
          sessionKey: targetSessionKey,
          message: index === 0 ? "Delegated assessment ready" : "Later compatible assessment",
          mode: "notify",
        }),
      );
      expect(result.details).toMatchObject({ status: "queued" });
    }
    enqueueSystemEvent("Ordinary progress", { sessionKey: targetSessionKey });
    const ordinary = await drainFormattedSystemEvents({
      cfg: config,
      agentId: "main",
      sessionKey: targetSessionKey,
      isMainSession: false,
      isNewSession: false,
    });
    expect(ordinary).toContain("Ordinary progress");
    expect(ordinary).not.toContain("Delegated assessment ready");
    const deferred = drainFormattedDelegatedSystemEvents({
      cfg: config,
      agentId: "main",
      sessionKey: targetSessionKey,
      policy: policy("read", "exec"),
      accept: () => true,
    });
    expect(deferred).toEqual({ text: undefined, policies: [], deferred: 2 });
    const unavailable = drainFormattedDelegatedSystemEvents({
      cfg: config,
      agentId: "main",
      sessionKey: targetSessionKey,
      policy: policy("read"),
      accept: () => false,
    });
    expect(unavailable).toEqual({ text: undefined, policies: [], deferred: 2 });
    const consumed = drainFormattedDelegatedSystemEvents({
      cfg: config,
      agentId: "main",
      sessionKey: targetSessionKey,
      policy: policy("read"),
      accept: () => true,
    });
    expect(consumed.text).toMatch(/Delegated assessment ready[\s\S]*Later compatible assessment/);
    expect(consumed.policies).toEqual(sources);
    expect(consumed.deferred).toBe(0);
  });

  it("keeps the accepted reply source until the detached flow actually settles", async () => {
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
              createSessionsSendTool({
                agentSessionKey: requesterSessionKey,
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
      );
      expect(result.details).toMatchObject({ status: "accepted", delivery: { status: "pending" } });
      expect(runSessionsSendA2AFlow).toHaveBeenCalledOnce();
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
