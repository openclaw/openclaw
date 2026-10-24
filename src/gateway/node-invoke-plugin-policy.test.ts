/**
 * Node invoke plugin-policy regression tests.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type TestContext,
} from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { ChannelApprovalKind } from "../infra/approval-types.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "../infra/plugin-approval-canonical-decisions.js";
import {
  MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
  type PluginApprovalRequestPayload,
} from "../infra/plugin-approvals.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type { OpenClawPluginNodeInvokePolicyContext } from "../plugins/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import {
  createTestApprovalFixture,
  createTestApprovalManager,
} from "./exec-approval-manager.test-support.js";
import {
  createApprovalRequestPolicy,
  createContext,
  createDemoPolicy,
  createNodeSession,
  createOperatorClient,
  createPolicyApprovalFixture,
  createRuntimeClient,
  DEMO_COMMAND,
  DEMO_PARAMS,
  DEMO_PLUGIN_ID,
  expectApprovalResolution,
  expectSinglePendingApproval,
  invokeDemoPolicy,
  nodeCommandsConfig,
  setDangerousDemoCommandRegistry,
} from "./node-invoke-plugin-policy.test-helpers.js";
import { listPendingOperatorApprovals } from "./operator-approval-store.js";
import {
  createApprovalClient,
  createApprovalClientLookup,
} from "./server-methods/approval-request.test-support.js";

function deliveryFixture(test: TestContext, delegated = false) {
  const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(test, {
    approvalKind: "plugin",
    ...(delegated ? { validateAgentRuntimeDelegatedAuthority: () => true } : {}),
  });
  setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
  const { context } = createContext({
    pluginApprovalManager: fixture.manager,
    getApprovalClientConnIds: vi.fn(() => new Set<string>()),
    hasExecApprovalClients: vi.fn(() => false),
  });
  const delivered = createDeferredCore();
  const handleRequested = vi.fn<
    NonNullable<NonNullable<typeof context.pluginApprovalIosPushDelivery>["handleRequested"]>
  >(async () => {
    delivered.resolve();
    return true;
  });
  return {
    ...fixture,
    context,
    handleRequested,
    async request(start = () => invokeDemoPolicy(context, createOperatorClient())) {
      const result = await expectSinglePendingApproval(fixture.manager, context, () =>
        fixture.track(start()),
      );
      await awaitGateBeforeSettlement(
        delivered.promise,
        result.pending,
        "Approval request ended before delivery",
      );
      return result;
    },
  };
}

const tempDirs: string[] = [];

const hasApprovalTurnSourceRouteMock = vi.hoisted(() =>
  vi.fn(
    (params: { turnSourceChannel?: string | null; approvalKind?: ChannelApprovalKind }) =>
      params.approvalKind === "plugin" && params.turnSourceChannel === "tui",
  ),
);

vi.mock("../infra/approval-turn-source.js", () => ({
  hasApprovalTurnSourceRoute: hasApprovalTurnSourceRouteMock,
}));

describe("applyPluginNodeInvokePolicy", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    hasApprovalTurnSourceRouteMock.mockClear();
  });

  afterEach(async () => {
    resetPluginRuntimeStateForTest();
    for (const dir of tempDirs.splice(0)) {
      await closeOpenClawStateDatabaseByPathAsync(path.join(dir, "state.sqlite"));
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("preserves one approval and session identity through streaming readiness recovery", async (testContext) => {
    const nodeSession = createNodeSession({ pairingGeneration: "paired-generation-1" });
    const fixture = createPolicyApprovalFixture(testContext, {}, { nodeSession });
    const { manager, invoke } = fixture;
    await fixture.run(async () => {
      const handle = vi.fn<Parameters<typeof createDemoPolicy>[0]>(async (policyContext) => {
        expect(policyContext.client?.scopes).toEqual(["operator.approvals"]);
        const approval = await policyContext.approvals?.request({
          title: "Open fixture duplex",
          description: "Approve the declared node command",
        });
        if (approval?.decision !== "allow-once") {
          return { ok: false, code: "APPROVAL_DENIED", message: "node command was not approved" };
        }
        return await policyContext.invokeNode();
      });
      setDangerousDemoCommandRegistry([createDemoPolicy(handle)]);
      let runtimeCurrent = true;
      const stream = {
        onProgress: vi.fn(),
        onDispatchReady: vi.fn(),
        idleTimeoutMs: 5_000,
        isRuntimeCurrent: () => runtimeCurrent,
      };
      invoke.mockImplementationOnce(async (params) => {
        params?.onDispatchReady?.("rejected-duplex-invoke");
        return {
          ok: false,
          error: { code: "NODE_NOT_READY", message: "Node lifecycle transition in progress" },
        };
      });
      invoke.mockImplementationOnce(async (params) => {
        params?.onDispatchReady?.("approved-duplex-invoke");
        params?.onProgress?.("approved-duplex-progress");
        return { ok: true, payload: { approved: true }, payloadJSON: null, error: null };
      });
      const { record: approval, pending: resultPromise } = await fixture.request(
        {
          ...createOperatorClient(),
          internal: {
            syntheticClient: true,
            pluginRuntimeOwnerId: DEMO_PLUGIN_ID,
            nodeInvokeApprovalSessionKey: "agent:main:paired",
            nodeInvokeStream: stream,
          },
        },
        { nodeSession, sessionKey: "agent:main:paired", nodeInvokeStream: stream },
      );
      expect(approval.request.sessionKey).toBe("agent:main:paired");
      expect(invoke).not.toHaveBeenCalled();
      expect(await manager.resolve(approval.id, "allow-once")).toBe(true);

      await expect(resultPromise).resolves.toMatchObject({ ok: true });
      expect(stream.onDispatchReady.mock.calls).toEqual([
        ["rejected-duplex-invoke"],
        ["approved-duplex-invoke"],
      ]);
      expect(stream.onProgress.mock.calls).toEqual([["approved-duplex-progress"]]);
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(handle).toHaveBeenCalledOnce();
      expect(await manager.listPendingRecords()).toHaveLength(0);
      expect((await manager.getSnapshot(approval.id))?.consumedDecision).toBe("allow-once");
      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedConnId: "conn-1",
          expectedPairingGeneration: "paired-generation-1",
          sessionKey: "agent:main:paired",
          idleTimeoutMs: 5_000,
        }),
      );

      runtimeCurrent = false;
      expect(invoke.mock.calls[0]?.[0]?.isDispatchAuthorized?.()).toBe(false);
    });
  });

  it("does not trust a plugin-owned invocation session without host attestation", async (testContext) => {
    const fixture = createPolicyApprovalFixture(testContext);
    const { manager } = fixture;
    await fixture.run(async () => {
      setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
      const { record: approval, pending: resultPromise } = await fixture.request(
        {
          ...createOperatorClient(),
          internal: {
            syntheticClient: true,
            pluginRuntimeOwnerId: DEMO_PLUGIN_ID,
          },
        },
        {
          sessionKey: "agent:main:plugin-asserted",
        },
      );
      expect(approval.request.sessionKey).toBeNull();
      expect(await manager.resolve(approval.id, "deny")).toBe(true);
      await expect(resultPromise).resolves.toMatchObject({ ok: true });
    });
  });

  it("fails closed when argument risk classification throws or returns invalid metadata", async () => {
    for (const classifyRisk of [
      () => {
        throw new Error("hostile argument text");
      },
      () => ({ level: "high" as const, family: "contains spaces" }),
    ]) {
      const policy = createDemoPolicy((ctx: OpenClawPluginNodeInvokePolicyContext) =>
        ctx.invokeNode(),
      );
      policy.policy.classifyRisk = classifyRisk;
      setDangerousDemoCommandRegistry([policy]);
      const { context, invoke } = createContext();

      await expect(invokeDemoPolicy(context)).resolves.toEqual({
        ok: false,
        code: "PLUGIN_POLICY_RISK_CLASSIFICATION_FAILED",
        message: `node.invoke ${DEMO_COMMAND} arguments could not be classified by plugin ${DEMO_PLUGIN_ID}`,
        details: { nodeCommandDispatched: false },
      });
      expect(invoke).not.toHaveBeenCalled();
      resetPluginRuntimeStateForTest();
    }
  });

  it.each([
    { overrideTimeoutMs: 0, expectedTimeoutMs: 250, expectedDeadlineAtMs: 1_250 },
    { overrideTimeoutMs: 80, expectedTimeoutMs: 80, expectedDeadlineAtMs: 1_080 },
  ])(
    "bounds plugin timeout override $overrideTimeoutMs by the original or earlier deadline",
    async ({ overrideTimeoutMs, expectedTimeoutMs, expectedDeadlineAtMs }) => {
      const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
      setDangerousDemoCommandRegistry([
        createDemoPolicy((ctx: OpenClawPluginNodeInvokePolicyContext) =>
          ctx.invokeNode({ timeoutMs: overrideTimeoutMs }),
        ),
      ]);
      const { context, invoke } = createContext();
      const controller = new AbortController();

      try {
        const result = await invokeDemoPolicy(context, null, {
          timeoutMs: 1_000,
          deadlineAtMs: 1_250,
          signal: controller.signal,
          resolveRemainingTimeoutMs: () => 250,
        });

        expect(result).toMatchObject({ ok: true });
        const request = invoke.mock.calls[0]?.[0];
        expect(request?.signal).toBe(controller.signal);
        expect(request?.timeoutMs).toBe(expectedTimeoutMs);
        expect(request?.deadlineAtMs).toBe(expectedDeadlineAtMs);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("marks plugin-owned work dispatched only after the node transport accepts it", async () => {
    setDangerousDemoCommandRegistry([
      createDemoPolicy((ctx: OpenClawPluginNodeInvokePolicyContext) => {
        expect(ctx.node?.caps).toEqual(["demo.allowed"]);
        return ctx.invokeNode();
      }),
    ]);
    const nodeSession = createNodeSession();
    nodeSession.declaredCaps = ["demo.allowed", "demo.unapproved"];
    nodeSession.caps = ["demo.allowed"];
    const { context, invoke } = createContext({ nodeSession });
    const dispatchOrder: string[] = [];
    invoke.mockImplementationOnce(async (params) => {
      dispatchOrder.push("node transport");
      params?.onDispatchReady?.("invoke-1");
      return {
        ok: true,
        payload: { ok: true, value: 1 },
        payloadJSON: null,
        error: null,
      };
    });

    const result = await invokeDemoPolicy(context, null, {
      nodeSession,
      onNodeCommandDispatched: () => dispatchOrder.push("dispatched"),
    });

    expect(result).toStrictEqual({ ok: true, payload: { ok: true, value: 1 }, payloadJSON: null });
    expect(dispatchOrder).toStrictEqual(["node transport", "dispatched"]);
    expect(invoke.mock.calls[0]?.[0]?.isDispatchAuthorized?.()).toBe(true);
    context.getRuntimeConfig = () => nodeCommandsConfig({ deny: [DEMO_COMMAND] });
    expect(invoke.mock.calls[0]?.[0]?.isDispatchAuthorized?.()).toBe(false);
  });

  it.each([
    { code: "TIMEOUT", options: { timeoutMs: 1_000, resolveRemainingTimeoutMs: () => 0 } },
    { code: "PAIRING_CHANGED", options: { isInvocationCurrent: async () => false } },
  ])("rejects plugin dispatch with $code before transport", async ({ code, options }) => {
    setDangerousDemoCommandRegistry([
      createDemoPolicy((ctx: OpenClawPluginNodeInvokePolicyContext) => ctx.invokeNode()),
    ]);
    const { context, invoke } = createContext();
    expect(await invokeDemoPolicy(context, null, options)).toMatchObject({
      ok: false,
      code,
      details: { nodeCommandDispatched: false },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["runtime", "bridged approval"] as const)(
    "rejects plugin dispatch when %s authority closes during pairing recheck",
    async (authority) => {
      setDangerousDemoCommandRegistry([createDemoPolicy((ctx) => ctx.invokeNode())]);
      let active = true;
      const { promise: pairingCheck, resolve: releasePairingCheck } = createDeferred();
      const { context, invoke } = createContext(
        authority === "runtime" ? { validateAgentRuntimeApprovalAuthority: () => active } : {},
      );
      const client =
        authority === "runtime"
          ? createRuntimeClient("run-node-policy-race")
          : createOperatorClient();
      const resultPromise = invokeDemoPolicy(context, client, {
        isInvocationCurrent: async () => {
          await pairingCheck;
          return true;
        },
        ...(authority === "bridged approval" ? { isApprovalAuthorityActive: () => active } : {}),
      });
      await vi.waitFor(() => expect(releasePairingCheck).toBeTypeOf("function"));
      active = false;
      releasePairingCheck?.();
      await expect(resultPromise).resolves.toMatchObject({
        ok: false,
        code: "APPROVAL_AUTHORITY_CLOSED",
        details: { nodeCommandDispatched: false },
      });
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("overrides plugin dispatch claims with the actual pre-dispatch state", async () => {
    setDangerousDemoCommandRegistry([
      createDemoPolicy(async () => ({
        ok: false,
        code: "POLICY_DENIED",
        message: "policy denied before dispatch",
        details: { nodeCommandDispatched: true, source: "policy" },
      })),
    ]);
    const { context, invoke } = createContext();

    const result = await invokeDemoPolicy(context);

    expect(result).toMatchObject({
      ok: false,
      details: { nodeCommandDispatched: false, source: "policy" },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("marks a policy failure after node dispatch as ambiguous", async () => {
    setDangerousDemoCommandRegistry([
      createDemoPolicy(async (ctx) => {
        await ctx.invokeNode();
        return {
          ok: false,
          code: "POST_DISPATCH_REJECTION",
          message: "policy rejected after dispatch",
        };
      }),
    ]);
    const { context, invoke } = createContext();

    const result = await invokeDemoPolicy(context);

    expect(result).toMatchObject({
      ok: false,
      details: { nodeCommandDispatched: true },
    });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it.for([true])("routes approvals for synthetic=%s", async (synthetic, testContext) => {
    // The carried connection is turn provenance, never this approval's
    // presenter, so it stays eligible as a reviewer for both provenance shapes.
    const visibleConnIds = new Set(["conn-owner-approval", "conn-requester"]);
    const getApprovalClientConnIds = createApprovalClientLookup([
      createOperatorClient(),
      createOperatorClient("conn-owner-approval"),
      createApprovalClient({
        connId: "conn-other-approval",
        clientId: "client-other",
        deviceId: "device-other",
      }),
    ]);
    setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
    const fixture = createPolicyApprovalFixture(
      testContext,
      {},
      {
        getApprovalClientConnIds,
      },
    );
    const { context, manager } = fixture;
    await fixture.run(async () => {
      const requester = createOperatorClient();
      requester.internal = synthetic ? { syntheticClient: true } : undefined;
      const { record, pending: resultPromise } = await fixture.request(requester);
      expect(record.requestedByConnId).toBe("conn-requester");
      expect(record.requestedByDeviceId).toBe("device-owner");
      expect(record.requestedByClientId).toBe("client-owner");
      expect(context.broadcast).not.toHaveBeenCalled();
      expect(context.broadcastToConnIds).toHaveBeenCalledWith(
        "plugin.approval.requested",
        expect.objectContaining({ id: record.id }),
        visibleConnIds,
        { dropIfSlow: true },
      );

      await expectApprovalResolution(resultPromise, manager, record);
    });
  });

  it.for([
    {
      name: "sanitizes reviewer-spoofing characters like the RPC ingress",
      input: {
        title: "Deploy‮yolped",
        description: "safe​text",
        toolName: "tool‮run",
        agentId: "agent​x",
      },
      expected: {
        title: "Deploy\\u{202E}yolped",
        description: "safe\\u{200B}text",
        toolName: "tool\\u{202E}run",
        agentId: "agent\\u{200B}x",
      },
    },
    {
      name: "keeps payload fields on UTF-16 boundaries",
      input: { title: `${"a".repeat(79)}🚀tail`, description: `${"b".repeat(255)}🚀tail` },
      expected: { title: "a".repeat(79), description: "b".repeat(255) },
    },
  ])("$name", async ({ input, expected }, testContext) => {
    const fixture = createPolicyApprovalFixture(testContext);
    const { manager } = fixture;
    await fixture.run(async () => {
      setDangerousDemoCommandRegistry([createApprovalRequestPolicy(input)]);
      const { record, pending: resultPromise } = await fixture.request();
      expect(record.request).toMatchObject(expected);

      await expectApprovalResolution(resultPromise, manager, record);
    });
  });

  it("limits explicitly one-shot node-policy approvals to allow-once or deny", async (testContext) => {
    const fixture = createPolicyApprovalFixture(testContext, {
      resolveAllowedDecisions: resolveCanonicalPluginApprovalRequestAllowedDecisions,
    });
    const { manager } = fixture;
    await fixture.run(async () => {
      setDangerousDemoCommandRegistry([
        createApprovalRequestPolicy({ allowedDecisions: ["allow-once"] }),
      ]);
      const { record, pending: resultPromise } = await fixture.request();
      expect(record.request.allowedDecisions).toEqual(["allow-once", "deny"]);
      expect(await manager.resolve(record.id, "allow-always")).toBe(false);
      expect(await manager.listPendingRecords()).toHaveLength(1);

      await expectApprovalResolution(resultPromise, manager, record);
    });
  });

  it("forwards plugin policy approvals to the originating turn source", async (testContext) => {
    const fixture = deliveryFixture(testContext, true);
    const { manager, context, handleRequested } = fixture;
    await fixture.run(async () => {
      context.forwardPluginApprovalRequest = handleRequested;
      context.validateAgentRuntimeApprovalAuthority = () => true;
      const { record, pending: resultPromise } = await fixture.request(() =>
        invokeDemoPolicy(
          context,
          createRuntimeClient("run-node-policy", "agent:main:telegram:direct:alice", {
            lifecycleGeneration: "test-generation",
            claimId: "test-claim",
          }),
          {
            sessionKey: "agent:main:spoofed",
            turnSource: { channel: "tui", to: "terminal", accountId: "default", threadId: 7 },
          },
        ),
      );
      expect(record.request).toMatchObject({
        turnSourceChannel: "tui",
        turnSourceTo: "terminal",
        turnSourceAccountId: "default",
        turnSourceThreadId: 7,
      });
      expect(context.broadcast).not.toHaveBeenCalled();
      expect(context.broadcastToConnIds).toHaveBeenCalledWith(
        "plugin.approval.requested",
        expect.objectContaining({ id: record.id }),
        new Set<string>(),
        { dropIfSlow: true },
      );
      expect(handleRequested).toHaveBeenCalledWith(
        expect.objectContaining({
          id: record.id,
          request: expect.objectContaining({
            turnSourceChannel: "tui",
            turnSourceTo: "terminal",
            turnSourceAccountId: "default",
            turnSourceThreadId: 7,
            agentId: "main",
            sessionKey: "agent:main:telegram:direct:alice",
          }),
        }),
      );

      await expectApprovalResolution(resultPromise, manager, record);
    });
  });

  it("delivers plugin policy approvals to visible iOS reviewers", async (testContext) => {
    const fixture = deliveryFixture(testContext);
    const { manager, context, handleRequested } = fixture;
    await fixture.run(async () => {
      context.pluginApprovalIosPushDelivery = { handleRequested };
      const { record, pending: resultPromise } = await fixture.request();

      expect(handleRequested).toHaveBeenCalledTimes(1);
      const deliveryOptions = handleRequested.mock.calls[0]?.[1];
      const visible = (deviceId: string) =>
        deliveryOptions?.isTargetVisible?.({
          deviceId,
          scopes: ["operator.approvals", "operator.read"],
        });
      expect([visible("device-owner"), visible("device-other")]).toEqual([true, false]);

      await expectApprovalResolution(resultPromise, manager, record);
    });
  });

  it("sends an iOS cleanup wake through the current delivery owner", async (testContext) => {
    const fixture = deliveryFixture(testContext);
    const { manager, context, handleRequested } = fixture;
    await fixture.run(async () => {
      const handleExpired = vi.fn(async () => {});
      context.pluginApprovalIosPushDelivery = { handleRequested, handleExpired };
      const { record, pending: resultPromise } = await fixture.request();
      const replacementExpired = vi.fn(async () => {});
      context.pluginApprovalIosPushDelivery = { handleExpired: replacementExpired };
      await manager.expire(record.id, "timeout");

      await expect(resultPromise).resolves.toStrictEqual({
        ok: true,
        payload: { id: record.id, decision: null },
      });
      expect(handleExpired).not.toHaveBeenCalled();
      expect(replacementExpired).toHaveBeenCalledWith(expect.objectContaining({ id: record.id }));
      expect(replacementExpired.mock.contexts).toEqual([context.pluginApprovalIosPushDelivery]);
    });
  });

  it("ignores approval routes from unsigned node.invoke clients", async (testContext) => {
    const manager = createTestApprovalManager<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
    });
    const forwardPluginApprovalRequest = vi.fn(async () => false);
    setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
    const { context } = createContext({
      pluginApprovalManager: manager,
      getApprovalClientConnIds: vi.fn(() => new Set<string>()),
      hasExecApprovalClients: vi.fn(() => false),
      forwardPluginApprovalRequest,
    });

    const result = await invokeDemoPolicy(context, createOperatorClient(), {
      sessionKey: "agent:main:spoofed",
      turnSource: {
        channel: "telegram",
        to: "chat:other",
        accountId: "work",
        threadId: 9,
      },
    });

    expect(result).toMatchObject({ ok: true, payload: { decision: null } });
    expect(forwardPluginApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          agentId: null,
          sessionKey: null,
          turnSourceChannel: null,
          turnSourceTo: null,
          turnSourceAccountId: null,
          turnSourceThreadId: null,
        }),
      }),
    );
  });

  it("caps plugin policy approval timeouts through the shared approval policy", async (testContext) => {
    const fixture = createPolicyApprovalFixture(testContext);
    const { manager } = fixture;
    await fixture.run(async () => {
      setDangerousDemoCommandRegistry([
        createApprovalRequestPolicy({ timeoutMs: Number.MAX_SAFE_INTEGER }),
      ]);
      const { record, pending: resultPromise } = await fixture.request();
      expect(record.expiresAtMs - record.createdAtMs).toBe(MAX_PLUGIN_APPROVAL_TIMEOUT_MS);

      await expectApprovalResolution(resultPromise, manager, record);
    });
  });

  it("fails closed when the allow-once claim cannot be consumed", async (testContext) => {
    const fixture = createPolicyApprovalFixture(testContext);
    const { manager } = fixture;
    await fixture.run(async () => {
      vi.spyOn(manager, "consumeAllowOnce").mockResolvedValue(false);
      setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
      const { record, pending: resultPromise } = await fixture.request();
      expect(await manager.resolve(record.id, "allow-once")).toBe(true);

      await expect(resultPromise).resolves.toStrictEqual({
        ok: true,
        payload: { id: record.id, decision: null },
      });
    });
  });

  it("fails closed before routing an unrenderable persistent policy approval", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-node-policy-approval-"));
    tempDirs.push(stateDir);
    const databaseOptions = { path: path.join(stateDir, "state.sqlite") };
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>({
      scheduler: createTestGatewayScheduler(),
      approvalKind: "plugin",
      persistence: { runtimeEpoch: "node-policy-test", databaseOptions },
      resolveAllowedDecisions: resolveCanonicalPluginApprovalRequestAllowedDecisions,
    });
    setDangerousDemoCommandRegistry([
      createApprovalRequestPolicy({ title: " \t ", description: "Needs approval" }),
    ]);
    const { context, invoke } = createContext({
      pluginApprovalManager: manager,
      getApprovalClientConnIds: createApprovalClientLookup([
        createOperatorClient("conn-owner-approval"),
      ]),
    });

    await expect(invokeDemoPolicy(context, createOperatorClient())).rejects.toThrow(
      "approval cannot be persisted without a valid reviewer presentation",
    );
    expect(await manager.listPendingRecords()).toEqual([]);
    expect(await listPendingOperatorApprovals({ databaseOptions })).toEqual([]);
    expect(context.broadcast).not.toHaveBeenCalled();
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("leaves commands without a dangerous plugin registration to normal allowlist handling", async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    const { context } = createContext();

    const result = await invokeDemoPolicy(context, null, {
      command: "safe.echo",
      params: { value: "hello" },
    });

    expect(result).toBeNull();
  });
});

it.each([true, false])(
  "plugin dispatch snapshots only bound turn source (bound=%s)",
  async (bound) => {
    onTestFinished(() => resetPluginRuntimeStateForTest());
    const source = {
      channel: "telegram",
      to: "-100123:topic:42",
      accountId: "work",
      threadId: "42",
    };
    setDangerousDemoCommandRegistry([
      createDemoPolicy(async (ctx) => {
        source.to = "mutated-owner";
        return ctx.invokeNode({
          params: { ...DEMO_PARAMS, turnSourceTo: "payload-selected-owner" },
        });
      }),
    ]);
    const { context, invoke } = createContext({
      validateAgentRuntimeApprovalAuthority: () => true,
    });
    const client = bound
      ? createRuntimeClient("source-policy-run", "agent:main:main")
      : createOperatorClient();
    const result = await invokeDemoPolicy(context, client, {
      turnSource: source,
    });
    expect(result?.ok).toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
    if (bound) {
      expect(invoke.mock.calls[0]?.[0]?.turnSource).toEqual({
        channel: "telegram",
        to: "-100123:topic:42",
        accountId: "work",
        threadId: "42",
      });
    } else {
      expect(invoke.mock.calls[0]?.[0]?.turnSource).toBeUndefined();
    }
    resetPluginRuntimeStateForTest();
  },
);
