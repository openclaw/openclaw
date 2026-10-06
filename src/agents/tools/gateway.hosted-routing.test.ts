import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../gateway/agent-runtime-approval-authority.js";
import { withAgentRuntimeExecutionLineage } from "../../gateway/agent-runtime-execution-lineage.js";
import {
  mintAgentRuntimeIdentityToken,
  verifyAgentRuntimeIdentityToken,
} from "../../gateway/agent-runtime-identity-token.js";
import { resolveExecutionIdentitySpawnFacts } from "../../gateway/agent-turn/agent-run-execution-lineage.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import {
  createTestApprovalManager,
  createPreparedTestApprovalManager,
} from "../../gateway/exec-approval-manager.test-support.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { sanitizeSystemRunParamsForForwarding } from "../../gateway/node-invoke-system-run-approval.js";
import { bindApprovalRequesterMetadata } from "../../gateway/server-methods/approval-shared.js";
import {
  readCronCallerScope,
  resolveCronScheduledToolPolicyForCaller,
} from "../../gateway/server-methods/cron-caller-scope.js";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../gateway/server-methods/types.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { buildSystemRunApprovalBinding } from "../../infra/system-run-approval-binding.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { resolveSkillWorkshopApprovalForFinalParams } from "../agent-tools.before-tool-call.approval.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { runWithGatewaySessionSpawnContext } from "./gateway-session-spawn-context.js";
import { runWithGatewaySessionSpawnParentExecutionIdentity } from "./gateway-session-spawn-execution-identity.js";
import { callGatewayTool, resolveMessageActionAgentRuntimeIdentityToken } from "./gateway.js";
import { bindAgentToolGatewayRequest } from "./in-process-gateway.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn<(options: CallGatewayOptions) => Promise<unknown>>(),
  handleGatewayRequest: vi.fn<(options: GatewayRequestOptions) => Promise<void>>(),
}));
vi.mock("../../gateway/call.js", () => ({ callGateway: mocks.callGateway }));
vi.mock("../../gateway/server-methods.js", () => ({
  handleGatewayRequest: mocks.handleGatewayRequest,
}));
type Caller = NonNullable<Parameters<typeof withGatewayToolCallerIdentity>[0]>;
type ActiveCaller = Caller & {
  operationalRunInstance: NonNullable<Caller["operationalRunInstance"]>;
};
async function withCaller<T>(
  overrides: Partial<Caller>,
  run: (caller: ActiveCaller, authority: AgentRunDelegatedAuthority) => Promise<T>,
) {
  const caller = {
    agentId: "ops",
    sessionKey: "agent:ops:main",
    ...overrides,
    operationalRunInstance:
      overrides.operationalRunInstance ?? createOperationalRunInstanceRef("run-1"),
  };
  const authority = claimAgentRunDelegatedAuthority(caller.operationalRunInstance);
  onTestFinished(() => void releaseAgentRunDelegatedAuthority(authority));
  try {
    return await withGatewayToolCallerIdentity(
      {
        ...caller,
        receiptAuthority: () =>
          validateAgentRunDelegatedAuthority(authority) && caller.receiptAuthority?.() !== false,
      },
      () => run(caller, authority),
    );
  } finally {
    releaseAgentRunDelegatedAuthority(authority);
  }
}
function capturedGatewayCall() {
  expect(mocks.callGateway).toHaveBeenCalledTimes(1);
  return expectDefined(mocks.callGateway.mock.calls[0]?.[0], "Gateway request");
}
const gatewayUiCommandTarget = { connId: "requesting-ui", profileId: "requester" };
const screenCommand = { command: { kind: "navigate", sessionKey: "agent:ops:dashboard:selected" } };
function hostedRequest() {
  expect(mocks.callGateway).not.toHaveBeenCalled();
  expect(mocks.handleGatewayRequest).toHaveBeenCalledOnce();
  return expectDefined(mocks.handleGatewayRequest.mock.calls[0]?.[0], "hosted request");
}
const verifyCallIdentity = () =>
  verifyAgentRuntimeIdentityToken(capturedGatewayCall().agentRuntimeIdentityToken);
const parent = createExecutionIdentityAdmissionToken("run-1", {
  contextId: "private-parent-context",
  executionId: "private-parent-execution",
});
const spawnContext = {
  completionOwnerSessionKey: "agent:ops:discord:direct:alice",
  inheritedToolPolicy: { version: 1 as const, allow: ["read"], deny: ["exec"] },
};
const lineageContext = withAgentRuntimeExecutionLineage(spawnContext, {
  relation: "sessions_spawn",
  requesterRef: "private-requester-ref",
  controllerRef: "private-controller-ref",
  depth: 2,
  applicableGrantRefs: ["tool:sessions_spawn"],
  localPolicyRefs: ["private-local-policy"],
  runtimeAssuranceRefs: ["spawn-runtime:subagent"],
  targetPolicyRefs: ["private-target-policy"],
  externalNativeActions: "observable",
});
const requiredIdentity = { requireAgentRuntimeIdentity: true };
const createSession = () =>
  callGatewayTool(
    "sessions.create",
    {},
    {
      parentSessionKey: "agent:ops:main",
      spawnDepth: 1,
    },
    requiredIdentity,
  );
const capabilities: string[] = [];
type TurnInput = Parameters<typeof mintMessageActionTurnCapability>[0];
function mintCapability(input: TurnInput) {
  const token = mintMessageActionTurnCapability(input);
  capabilities.push(token);
  return token;
}
function messageFixture(overrides: Partial<TurnInput> = {}) {
  const input: TurnInput = {
    agentId: "ops",
    runId: "run-1",
    sessionKey: "agent:ops:telegram:group:room-1",
    sessionId: "session-1",
    requesterAccountId: "default",
    toolContext: {
      currentChannelProvider: "telegram",
      currentChannelId: "room-1",
      currentChatType: "group",
      currentSourceTurnId: "source-turn-1",
    },
    ...overrides,
  };
  const params = {
    opts: {},
    target: "local" as const,
    runId: input.runId,
    sessionId: input.sessionId,
    turnCapability: mintCapability(input),
    sourceReplyFinal: true,
    sourceReplyToolCallId: "message-call-1",
  };
  return {
    input,
    params,
    resolve: (
      changes: Partial<Parameters<typeof resolveMessageActionAgentRuntimeIdentityToken>[0]> = {},
    ) => resolveMessageActionAgentRuntimeIdentityToken({ ...params, ...changes }),
    caller: {
      agentId: input.agentId,
      sessionKey: input.sourceReplySessionKey ?? input.sessionKey,
      operationalRunInstance: createOperationalRunInstanceRef(input.runId),
    },
  };
}

let context: GatewayRequestContext;
let currentContext: GatewayRequestContext | undefined;
let callerActive: boolean;
const hostedSource = {
  turnSourceChannel: "telegram",
  turnSourceTo: "alice",
  turnSourceAccountId: "work",
  turnSourceThreadId: "topic",
};
function deferHostedResponse(result: unknown, accepted?: unknown) {
  const entered = createDeferred(),
    release = createDeferred();
  mocks.handleGatewayRequest.mockImplementationOnce(async ({ respond }) => {
    if (accepted !== undefined) {
      respond(true, accepted);
    }
    entered.resolve();
    await release.promise;
    respond(true, result);
  });
  return { entered, release };
}

function runHosted<T>(
  run: (caller: ActiveCaller, authority: AgentRunDelegatedAuthority) => Promise<T>,
) {
  return withCaller(
    {
      sessionKey: "agent:ops:telegram:direct:alice",
      ...hostedSource,
      gatewayUiCommandTarget,
      gatewayContextResolver: () => currentContext,
      receiptAuthority: () => callerActive,
      cronSelfManagementJobId: "current-job",
      cronToolsAllowCapture: "final-executable-surface",
      cronExecToolTarget: { host: "gateway", ask: "always" },
    },
    run,
  );
}

describe("Gateway tool identity and hosted routing", () => {
  beforeEach(() => {
    setRuntimeConfigSnapshot({ gateway: { mode: "local", port: 18789 } });
    context = {
      trackExecution: (run) => run(),
      getRuntimeConfig: () => ({ gateway: { mode: "local" } }),
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    } as GatewayRequestContext;
    currentContext = context;
    callerActive = true;
    mocks.callGateway.mockReset().mockResolvedValue({ ok: true });
    mocks.handleGatewayRequest
      .mockReset()
      .mockImplementation(async ({ respond }) => respond(true, { ok: true }));
  });
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    for (const token of capabilities.splice(0)) {
      revokeMessageActionTurnCapability(token);
    }
  });

  it("dispatches hosted screen commands with the admitted UI identity", async () => {
    await runHosted(async (caller) => {
      await expect(callGatewayTool("ui.command", {}, screenCommand)).resolves.toEqual({ ok: true });
      const call = hostedRequest();
      expect(call.context).toBe(context);
      expect(call.req.method).toBe("ui.command");
      expect(call.req.params).toEqual(screenCommand);
      expect(call.client?.internal?.agentRuntimeIdentity).toMatchObject({
        kind: "agentRuntime",
        agentId: "ops",
        sessionKey: caller.sessionKey,
        operationalRunInstance: caller.operationalRunInstance,
        gatewayUiCommandTarget,
      });
    });
  });

  it("uses the host-signed requesting UI for worker screen commands", async () => {
    await withCaller({}, async (caller) => {
      const token = await mintAgentRuntimeIdentityToken({ ...caller, gatewayUiCommandTarget });
      await withGatewayToolCallerIdentity(
        {
          ...caller,
          signedAgentRuntimeIdentityToken: token,
          gatewayUiCommandTarget: { connId: "other-ui", profileId: "other-profile" },
        },
        () => callGatewayTool("ui.command", {}, screenCommand),
      );
      expect(capturedGatewayCall().params).toEqual(screenCommand);
      expect(capturedGatewayCall().agentRuntimeIdentityToken).toBe(token);
      await expect(verifyCallIdentity()).resolves.toMatchObject({ gatewayUiCommandTarget });
    });
  });

  it("omits local identity for independent node callers with ambient context", async () => {
    await withCaller({}, () =>
      withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, () =>
        callGatewayTool("node.invoke", {}, {}),
      ),
    );
    expect(capturedGatewayCall()).not.toHaveProperty("agentRuntimeIdentityToken");
  });

  it.each(["during preparation", "before wire retry"])(
    "rejects a retired Gateway binding %s",
    async (closure) => {
      const wireRetry = closure === "before wire retry";
      let boundContext: GatewayRequestContext | undefined = {
        ...(wireRetry ? { localEmbedded: true } : {}),
        trackExecution: (run: () => Promise<void>) => run(),
      } as GatewayRequestContext;
      await withCaller({ gatewayContextResolver: () => boundContext }, async () => {
        if (wireRetry) {
          mocks.callGateway.mockImplementationOnce(async () => {
            boundContext = undefined;
            throw new GatewayClientRequestError({
              message: "invalid node.invoke params: unexpected property 'turnSourceChannel'",
              code: "INVALID_REQUEST",
              details: { nodeCommandDispatched: false },
            });
          });
        } else {
          queueMicrotask(() => {
            boundContext = undefined;
          });
        }
        await expect(
          callGatewayTool(wireRetry ? "node.invoke" : "question.request", {}, {}),
        ).rejects.toThrow(
          wireRetry
            ? "admitting Gateway is no longer available"
            : /Gateway instance unavailable|admitting Gateway is no longer available/,
        );
      });
      expect(mocks.callGateway).toHaveBeenCalledTimes(wireRetry ? 1 : 0);
      expect(mocks.handleGatewayRequest).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "requires explicit forwarded spawn-parent evidence (forwarded=%s)",
    async (forwarded) => {
      const identity = await withCaller(
        {
          executionIdentityToken: forwarded
            ? parent
            : createExecutionIdentityAdmissionToken("run-1"),
        },
        async () => {
          await runWithGatewaySessionSpawnContext(forwarded ? spawnContext : lineageContext, () =>
            forwarded
              ? runWithGatewaySessionSpawnParentExecutionIdentity(parent, createSession)
              : createSession(),
          );
          return forwarded ? undefined : await verifyCallIdentity();
        },
      );
      if (forwarded) {
        await expect(verifyCallIdentity()).resolves.toMatchObject({
          executionIdentity: parent,
          sessionSpawnContext: spawnContext,
        });
      } else {
        expect(identity).toBeDefined();
        expect(identity).not.toHaveProperty("executionIdentity");
        await expect(verifyCallIdentity()).resolves.toBeUndefined();
      }
    },
  );

  it("redeems private spawn lineage once", async () => {
    const result = await withCaller({ executionIdentityToken: parent }, async () => {
      await runWithGatewaySessionSpawnContext(lineageContext, () =>
        runWithGatewaySessionSpawnParentExecutionIdentity(parent, () =>
          callGatewayTool(
            "agent",
            {},
            { sessionKey: "agent:child:main", message: "test", idempotencyKey: "child-run" },
            requiredIdentity,
          ),
        ),
      );
      const token = capturedGatewayCall().agentRuntimeIdentityToken ?? "";
      const payload: unknown = JSON.parse(
        Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"),
      );
      expect(payload).toHaveProperty("executionLineageHandoffId", expect.any(String));
      expect(payload).not.toHaveProperty("executionIdentity");
      expect(payload).not.toHaveProperty("sessionSpawnContext");
      expect(JSON.stringify(payload)).not.toMatch(
        /private-parent|private-requester|private-controller|private-local|private-target/,
      );
      const identity = await verifyAgentRuntimeIdentityToken(token);
      return {
        identity,
        facts: resolveExecutionIdentitySpawnFacts(identity ? { ...identity } : undefined),
        replayFacts: resolveExecutionIdentitySpawnFacts(identity),
      };
    });
    expect(result.identity).toBeDefined();
    expect(result.facts?.spawnAdmission).toEqual(expect.any(String));
    expect(result.replayFacts).toBeUndefined();
    await expect(verifyCallIdentity()).resolves.toBeUndefined();
  });

  it("requires exact terminal reply correlation", async () => {
    const { input, caller, resolve } = messageFixture();
    const expectRefusal = (changes: Parameters<typeof resolve>[0], reason: string) =>
      expect(resolve(changes)).rejects.toThrow("terminal source reply requires " + reason);
    const sourceLess = mintCapability({
      ...input,
      toolContext: { ...input.toolContext, currentSourceTurnId: undefined },
    });
    await withCaller(caller, async () => {
      const token = await resolve();
      await expect(verifyAgentRuntimeIdentityToken(token)).resolves.toMatchObject({
        messageActionContext: {
          sessionId: "session-1",
          sourceReplyFinal: true,
          sourceReplyToolCallId: "message-call-1",
          requesterAccountId: "default",
          toolContext: { currentSourceTurnId: "source-turn-1" },
        },
      });
      await expectRefusal({ sourceReplyToolCallId: undefined }, "tool-call correlation");
      await expectRefusal({ turnCapability: "missing-capability" }, "an active turn capability");
      await expectRefusal({ turnCapability: sourceLess }, "source-turn correlation");
      await expectRefusal({ target: "remote" }, "the trusted local gateway context");
      await expect(
        resolve({ target: "remote", callerOwnsTerminalReceipt: true }),
      ).resolves.toBeUndefined();
      await expect(
        resolveMessageActionAgentRuntimeIdentityToken({ opts: {}, target: "local" }),
      ).resolves.toBeUndefined();
    });
    await expectRefusal({}, "trusted agent runtime identity");
  });

  it("fences message identity with its turn capability", async () => {
    const { caller, params, resolve } = messageFixture({
      toolContext: undefined,
      requesterAccountId: undefined,
    });
    const generation = new AbortController();
    await withCaller({ ...caller, approvalSignals: [generation.signal] }, async () => {
      const token = await resolve({
        sourceReplyFinal: undefined,
        sourceReplyToolCallId: undefined,
      });
      const identity = expectDefined(
        await verifyAgentRuntimeIdentityToken(token),
        "message identity",
      );
      expect(identity).toMatchObject({
        messageActionContext: { turnCapability: params.turnCapability },
      });
      const validate = createAgentRuntimeApprovalAuthorityValidator();
      expect(validate(identity)).toBe(true);
      generation.abort();
      expect(validate(identity)).toBe(true);
      expect(revokeMessageActionTurnCapability(params.turnCapability)).toBe(true);
      expect(validate(identity)).toBe(false);
    });
  });

  it("binds split-session message identity to its policy session", async () => {
    const policySessionKey = "agent:ops:telegram:default:direct:alice";
    const runSessionKey = "agent:ops:main";
    const { caller, resolve } = messageFixture({
      sessionKey: policySessionKey,
      sourceReplySessionKey: runSessionKey,
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "alice",
        currentChatType: "direct",
        currentSourceTurnId: "source-turn-split-session",
      },
    });
    await withCaller(caller, async () => {
      await expect(
        resolve({ turnCapabilitySessionKey: "agent:ops:telegram:default:direct:mallory" }),
      ).rejects.toThrow("terminal source reply requires an active turn capability");
      const token = await resolve({ turnCapabilitySessionKey: policySessionKey });
      await expect(verifyAgentRuntimeIdentityToken(token)).resolves.toMatchObject({
        sessionKey: policySessionKey,
        operationalRunInstance: caller.operationalRunInstance,
        messageActionContext: {
          sourceReplySessionKey: runSessionKey,
          sourceReplyFinal: true,
          sourceReplyToolCallId: "message-call-1",
        },
      });
    });
  });

  it.each([
    ["apply", "allow-once"],
    ["reject", "deny"],
  ] as const)("signs Workshop %s approvals (%s)", async (action, decision) => {
    mocks.callGateway.mockResolvedValueOnce({ id: "workshop-approval", decision });
    await withCaller(
      {
        sessionKey: "agent:ops:telegram:group:-1001234567890",
        turnSourceChannel: "telegram",
        turnSourceTo: "-1001234567890",
        turnSourceAccountId: "default",
      },
      async (caller) => {
        const result = await resolveSkillWorkshopApprovalForFinalParams({
          toolName: "skill_workshop",
          params: { action },
          ctx: { config: { skills: { workshop: { approvalPolicy: "pending" } } } },
        });
        expect(result?.blocked).toBe(decision === "deny");
        expect(capturedGatewayCall().method).toBe("plugin.approval.request");
        expect(capturedGatewayCall().params).not.toHaveProperty("pluginId");
        await expect(verifyCallIdentity()).resolves.toMatchObject({
          ...caller,
          approvalOwnerPluginId: "workspace-skills",
        });
      },
    );
  });

  it("rejects approval registration after permission changes", async (test) => {
    const { manager, run, track } = await createPreparedTestApprovalManager(test, {
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const outer = new AbortController(),
      oldGeneration = new AbortController(),
      nextGeneration = new AbortController();
    await run(() =>
      withCaller({ approvalSignals: [outer.signal] }, async () => {
        await callGatewayTool("exec.approval.request", {}, {}, { signal: oldGeneration.signal });
        const oldIdentity = expectDefined(await verifyCallIdentity(), "signed approval identity");
        const oldRecord = manager.create({ command: "echo old" }, 2_000, "old-generation");
        oldRecord.agentRuntimeDelegatedAuthority = oldIdentity.delegatedAuthority;
        oldGeneration.abort(new Error("Permission change"));
        await expect(manager.register(oldRecord, 2_000)).rejects.toThrow("no longer active");
        expect(await manager.listPendingRecords()).toHaveLength(0);
        await callGatewayTool("exec.approval.request", {}, {}, { signal: nextGeneration.signal });
        const nextIdentity = expectDefined(
          await verifyAgentRuntimeIdentityToken(
            mocks.callGateway.mock.calls.at(-1)?.[0].agentRuntimeIdentityToken,
          ),
          "replacement approval identity",
        );
        const nextRecord = manager.create({ command: "echo new" }, 2_000, "next-generation");
        nextRecord.agentRuntimeDelegatedAuthority = nextIdentity.delegatedAuthority;
        const decision = track((await manager.register(nextRecord, 2_000)).decision);
        const waiter = track(Promise.resolve(manager.awaitDecision(nextRecord.id)));
        expect(await manager.listPendingRecords()).toHaveLength(1);
        await manager.resolve(nextRecord.id, "allow-once");
        await expect(decision).resolves.toBe("allow-once");
        expect(manager.projectDecisionIfActive(nextRecord.id, await waiter)).toBe("allow-once");
      }),
    );
  });

  it("rejects required approval identity outside signed local admission", async () => {
    await expect(
      callGatewayTool("exec.approval.request", {}, { command: "echo unsigned" }, requiredIdentity),
    ).rejects.toThrow("trusted agent runtime identity required");
    await withCaller({}, async () => {
      await expect(
        callGatewayTool(
          "exec.approval.request",
          { gatewayToken: "remote-override" },
          { command: "echo remote" },
          requiredIdentity,
        ),
      ).rejects.toThrow("trusted local gateway context");
    });
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("retains account scheduling authority through the cron owner", async () => {
    mocks.handleGatewayRequest.mockImplementationOnce(async ({ client, respond }) => {
      const caller = readCronCallerScope(client);
      respond(true, { caller, policy: resolveCronScheduledToolPolicyForCaller(caller) });
    });
    await expect(runHosted(() => callGatewayTool("cron.add", {}, {}))).resolves.toMatchObject({
      caller: {
        agentId: "ops",
        accountId: "work",
        currentJobId: "current-job",
        toolsAllowProvenance: {
          source: "final-executable-surface",
          callerOrigin: { kind: "external", channel: "telegram" },
        },
        toolsAllowExecTarget: { version: 1, host: "gateway", ask: "always" },
      },
      policy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:ops:telegram:direct:alice",
        ownerAccountId: "work",
      },
    });
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it.each(["final result", "cancellation"])(
    "keeps approval request authority until %s",
    async (outcome) => {
      const cancelled = outcome === "cancellation";
      const result = cancelled ? { id: "approval" } : { id: "approval", decision: "allow-once" };
      const { entered, release } = deferHostedResponse(
        result,
        cancelled ? undefined : { status: "accepted", id: "approval" },
      );
      const controller = new AbortController();
      const observed: unknown[] = [];
      const pending = runHosted(() =>
        callGatewayTool(
          "exec.approval.request",
          {},
          {},
          cancelled ? { signal: controller.signal } : { expectFinal: true },
        ),
      ).then((value) => {
        observed.push(value);
        return value;
      });
      const settled = cancelled
        ? expect(pending).rejects.toThrow("approval cancelled")
        : expect(pending).resolves.toEqual(result);
      await entered.promise;
      expect(observed).toEqual([]);
      if (cancelled) {
        const identity = hostedRequest().client?.internal?.agentRuntimeIdentity;
        expect(identity && context.validateAgentRuntimeApprovalAuthority?.(identity)).toBe(true);
        controller.abort(new Error("approval cancelled"));
        expect(identity && context.validateAgentRuntimeApprovalAuthority?.(identity)).toBe(false);
      }
      release.resolve();
      await settled;
      expect(mocks.callGateway).not.toHaveBeenCalled();
    },
  );

  it("binds one-shot node approval replay to its requester", async (test) => {
    const manager = createTestApprovalManager(test, {
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const command = ["echo", "synthetic"];
    await runHosted(async (caller) => {
      const { agentId, sessionKey } = caller;
      mocks.handleGatewayRequest.mockImplementationOnce(async ({ client, respond }) => {
        const record = manager.create(
          {
            host: "node",
            nodeId: "node",
            command: "echo synthetic",
            commandArgv: command,
            systemRunBinding: buildSystemRunApprovalBinding({ argv: command, agentId, sessionKey })
              .binding,
            agentId,
            sessionKey,
            ...hostedSource,
          },
          60_000,
        );
        bindApprovalRequesterMetadata({ record, client });
        record.agentRuntimeDelegatedAuthority =
          client?.internal?.agentRuntimeIdentity?.delegatedAuthority;
        const decision = (await manager.register(record, 60_000)).decision;
        expect(await manager.resolve(record.id, "allow-once")).toBe(true);
        await decision;
        respond(true, { id: record.id });
      });
      const registration = await callGatewayTool<{ id: string }>("exec.approval.request", {}, {});
      mocks.handleGatewayRequest.mockImplementation(async ({ client, req, respond }) => {
        const invoke = req.params as { params: Record<string, unknown> } & typeof hostedSource;
        respond(
          true,
          sanitizeSystemRunParamsForForwarding({
            rawParams: {
              ...invoke.params,
              turnSourceChannel: invoke.turnSourceChannel,
              turnSourceTo: invoke.turnSourceTo,
              turnSourceAccountId: invoke.turnSourceAccountId,
              turnSourceThreadId: invoke.turnSourceThreadId,
            },
            nodeId: "node",
            client,
            execApprovalManager: manager,
          }),
        );
      });
      const replay = (bridge = false) =>
        callGatewayTool(
          "node.invoke",
          {},
          {
            nodeId: "node",
            command: "system.run",
            params: {
              command,
              agentId,
              sessionKey,
              runId: registration.id,
              approved: true,
              approvalDecision: "allow-once",
            },
          },
          { scopes: bridge ? ["operator.write", "operator.approvals"] : ["operator.write"] },
        );
      for (const [turnSourceTo, bridge] of [
        ["other-recipient", true],
        ["alice", false],
      ] as const) {
        await expect(
          withCaller(
            {
              ...caller,
              turnSourceTo,
              operationalRunInstance: createOperationalRunInstanceRef("another-hosted-run"),
            },
            () => replay(bridge),
          ),
        ).resolves.toMatchObject({ ok: false });
      }
      await expect(replay()).resolves.toMatchObject({ ok: true });
      await expect(replay()).resolves.toMatchObject({ ok: false });
      expect(mocks.callGateway).not.toHaveBeenCalled();
    });
  });

  it.each([
    { owner: "run", pending: false },
    { owner: "caller", pending: false },
    { owner: "run", pending: true },
    { owner: "gateway", pending: true },
  ])("rejects retired $owner authority (pending=$pending)", async ({ owner, pending }) => {
    const deferred = pending ? deferHostedResponse({ ok: true }) : undefined;
    await runHosted(async (_caller, authority) => {
      const request = deferred ? callGatewayTool("node.list", {}, {}) : undefined;
      await deferred?.entered.promise;
      if (owner === "run") {
        releaseAgentRunDelegatedAuthority(authority);
      } else if (owner === "caller") {
        callerActive = false;
      } else {
        currentContext = { ...context };
      }
      const rejected = expect(request ?? callGatewayTool("cron.list", {}, {})).rejects.toThrow(
        pending
          ? /authority.*no longer active|Gateway instance unavailable/
          : /authority.*no longer active|active delegated run authority/,
      );
      deferred?.release.resolve();
      await rejected;
    });
    expect(mocks.callGateway).not.toHaveBeenCalled();
    if (!pending) {
      expect(mocks.handleGatewayRequest).not.toHaveBeenCalled();
    }
  });

  it("retains operator scopes and expiry across a bound operation", async (test) => {
    const state = await createOpenClawTestState({ prefix: "gateway-", layout: "state-only" });
    test.onTestFinished(() => state.cleanup());
    const profileId = ensureProfileForEmail("operator@example.test").id;
    const profile = { profileId, displayName: "operator", hasAvatar: false, updatedAt: 1 };
    const request = await withPluginRuntimeGatewayRequestScope(
      { context, isWebchatConnect: () => false },
      () =>
        withOperatorToolGatewayAuthority(
          { authenticatedUserProfile: profile, scopes: ["operator.read"] },
          async () => {
            const bound = bindAgentToolGatewayRequest();
            await bound({ method: "config.get", scopes: ["operator.read", "operator.write"] });
            return bound;
          },
        ),
    );
    await expect(request({ method: "config.get" })).rejects.toThrow(
      "operator tool invocation authority expired",
    );
    expect(hostedRequest().client?.connect.scopes).toEqual(["operator.read"]);
  });
});
