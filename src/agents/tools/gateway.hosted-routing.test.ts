import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../gateway/agent-runtime-identity-token.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { createTestApprovalManager } from "../../gateway/exec-approval-manager.test-support.js";
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
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callGatewayTool } from "./gateway.js";
import { bindAgentToolGatewayRequest } from "./in-process-gateway.js";

const { callGateway, handleGatewayRequest } = vi.hoisted(() => ({
  callGateway: vi.fn<(options: CallGatewayOptions) => Promise<unknown>>(),
  handleGatewayRequest: vi.fn<(options: GatewayRequestOptions) => Promise<void>>(),
}));

vi.mock("../../gateway/call.js", () => ({ callGateway }));
vi.mock("../../gateway/server-methods.js", () => ({ handleGatewayRequest }));

describe("hosted Gateway tool routing", () => {
  let context: GatewayRequestContext;
  let currentContext: GatewayRequestContext | undefined;
  let authority: AgentRunDelegatedAuthority;
  let callerActive: boolean;

  const runAsCaller = <T>(run: () => Promise<T>) =>
    withGatewayToolCallerIdentity(
      {
        agentId: "ops",
        sessionKey: "agent:ops:telegram:direct:alice",
        operationalRunInstance: authority.operationalRunInstance,
        receiptAuthority: () => callerActive && validateAgentRunDelegatedAuthority(authority),
        gatewayContextResolver: () => currentContext,
        turnSourceChannel: "telegram",
        turnSourceTo: "alice",
        turnSourceAccountId: "work",
        turnSourceThreadId: "topic",
        cronSelfManagementJobId: "current-job",
        cronToolsAllowCapture: "final-executable-surface",
        cronExecToolTarget: { host: "gateway", ask: "always" },
      },
      run,
    );

  beforeEach(() => {
    setRuntimeConfigSnapshot({ gateway: { mode: "local", port: 18789 } });
    context = {
      trackExecution: (run) => run(),
      getRuntimeConfig: () => ({ gateway: { mode: "local" } }),
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    } as GatewayRequestContext;
    currentContext = context;
    callerActive = true;
    authority = claimAgentRunDelegatedAuthority(createOperationalRunInstanceRef("hosted-tool-run"));
    callGateway.mockReset().mockResolvedValue({ ok: true });
    handleGatewayRequest.mockReset().mockImplementation(async ({ respond }) => {
      respond(true, { ok: true });
    });
  });

  afterEach(() => {
    releaseAgentRunDelegatedAuthority(authority);
    clearRuntimeConfigSnapshot();
  });

  it.each([
    ["cron.list", {}, "operator.read"],
    ["node.invoke", { nodeId: "node", command: "system.run", params: {} }, "operator.write"],
    ["question.request", { questions: [] }, "operator.questions"],
    ["exec.approval.request", { command: "echo synthetic" }, "operator.approvals"],
  ] as const)(
    "dispatches hosted %s with current agent authority and least privilege",
    async (method, params, scope) => {
      await expect(runAsCaller(() => callGatewayTool(method, {}, params))).resolves.toEqual({
        ok: true,
      });

      expect(callGateway).not.toHaveBeenCalled();
      expect(handleGatewayRequest).toHaveBeenCalledOnce();
      const request = handleGatewayRequest.mock.calls[0]![0];
      expect(request.context).toBe(context);
      expect(request.req.method).toBe(method);
      expect(request.client?.connect.scopes).toEqual([scope]);
      const identity = request.client?.internal?.agentRuntimeIdentity;
      expect(identity).toMatchObject({
        agentId: "ops",
        sessionKey: "agent:ops:telegram:direct:alice",
        operationalRunInstance: authority.operationalRunInstance,
        turnSourceChannel: "telegram",
        turnSourceTo: "alice",
        turnSourceAccountId: "work",
        turnSourceThreadId: "topic",
      });
      expect(identity && context.validateAgentRuntimeApprovalAuthority?.(identity)).toBe(true);
      releaseAgentRunDelegatedAuthority(authority);
      expect(identity && context.validateAgentRuntimeApprovalAuthority?.(identity)).toBe(false);
    },
  );

  it("retains account scheduling authority when the cron owner consumes a hosted caller", async () => {
    handleGatewayRequest.mockImplementationOnce(async ({ client, respond }) => {
      const caller = readCronCallerScope(client);
      respond(true, { caller, policy: resolveCronScheduledToolPolicyForCaller(caller) });
    });

    await expect(runAsCaller(() => callGatewayTool("cron.add", {}, {}))).resolves.toMatchObject({
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
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("takes node turn provenance from the host instead of tool arguments", async () => {
    await runAsCaller(() =>
      callGatewayTool(
        "node.invoke",
        {},
        {
          nodeId: "node",
          command: "system.run",
          params: { command: ["echo", "synthetic"] },
          turnSourceChannel: "discord",
          turnSourceTo: "other-recipient",
          turnSourceAccountId: "other-account",
          turnSourceThreadId: "other-topic",
        },
      ),
    );
    expect(handleGatewayRequest.mock.calls[0]?.[0].req.params).toMatchObject({
      turnSourceChannel: "telegram",
      turnSourceTo: "alice",
      turnSourceAccountId: "work",
      turnSourceThreadId: "topic",
    });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("waits past acceptance for the requested final result", async () => {
    const accepted = createDeferred();
    const release = createDeferred();
    const observed: unknown[] = [];
    handleGatewayRequest.mockImplementationOnce(async ({ respond }) => {
      respond(true, { status: "accepted", id: "approval" });
      accepted.resolve();
      await release.promise;
      respond(true, { id: "approval", decision: "allow-once" });
    });
    const pending = runAsCaller(() =>
      callGatewayTool("exec.approval.request", {}, {}, { expectFinal: true }),
    );
    void pending.then((result) => observed.push(result));
    await accepted.promise;
    expect(observed).toEqual([]);
    release.resolve();
    await expect(pending).resolves.toEqual({ id: "approval", decision: "allow-once" });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("preserves node approval requester binding across hosted calls", async (test) => {
    const manager = createTestApprovalManager(test, {
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const command = ["echo", "synthetic"];
    const agentId = "ops";
    const sessionKey = "agent:ops:telegram:direct:alice";
    const source = {
      turnSourceChannel: "telegram",
      turnSourceTo: "alice",
      turnSourceAccountId: "work",
      turnSourceThreadId: "topic",
    };
    handleGatewayRequest.mockImplementationOnce(async ({ client, respond }) => {
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
          ...source,
        },
        60_000,
      );
      bindApprovalRequesterMetadata({ record, client });
      record.agentRuntimeDelegatedAuthority =
        client?.internal?.agentRuntimeIdentity?.delegatedAuthority;
      const decision = manager.register(record, 60_000);
      expect(manager.resolve(record.id, "allow-once")).toBe(true);
      await decision;
      respond(true, { id: record.id });
    });
    const registration = await runAsCaller(() =>
      callGatewayTool<{ id: string }>("exec.approval.request", {}, {}),
    );
    handleGatewayRequest.mockImplementation(async ({ client, req, respond }) => {
      const invoke = req.params as { params: Record<string, unknown> } & typeof source;
      const result = sanitizeSystemRunParamsForForwarding({
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
      });
      respond(true, result);
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
    const otherAuthority = claimAgentRunDelegatedAuthority(
      createOperationalRunInstanceRef("another-hosted-run"),
    );
    try {
      for (const [turnSourceTo, bridge] of [
        ["other-recipient", true],
        ["alice", false],
      ] as const) {
        await expect(
          withGatewayToolCallerIdentity(
            {
              agentId,
              sessionKey,
              ...source,
              turnSourceTo,
              operationalRunInstance: otherAuthority.operationalRunInstance,
              receiptAuthority: () => validateAgentRunDelegatedAuthority(otherAuthority),
              gatewayContextResolver: () => currentContext,
            },
            () => replay(bridge),
          ),
        ).resolves.toMatchObject({ ok: false });
      }
      await expect(runAsCaller(replay)).resolves.toMatchObject({ ok: true });
      await expect(runAsCaller(replay)).resolves.toMatchObject({ ok: false });
      expect(callGateway).not.toHaveBeenCalled();
    } finally {
      releaseAgentRunDelegatedAuthority(otherAuthority);
    }
  });

  it.each(["run", "caller", "gateway"] as const)(
    "rejects a retired %s before dispatch",
    async (owner) => {
      await expect(
        runAsCaller(async () => {
          if (owner === "run") {
            releaseAgentRunDelegatedAuthority(authority);
          } else if (owner === "caller") {
            callerActive = false;
          } else {
            currentContext = undefined;
          }
          return await callGatewayTool("cron.list", {}, {});
        }),
      ).rejects.toThrow(
        /authority.*no longer active|active delegated run authority|Gateway.*(unavailable|no longer available)/,
      );
      expect(callGateway).not.toHaveBeenCalled();
      expect(handleGatewayRequest).not.toHaveBeenCalled();
    },
  );

  it.each(["run", "gateway"] as const)(
    "rejects pending results after the admitting %s is replaced",
    async (owner) => {
      const entered = createDeferred();
      const release = createDeferred();
      handleGatewayRequest.mockImplementationOnce(async ({ respond }) => {
        entered.resolve();
        await release.promise;
        respond(true, { ok: true });
      });
      const pending = runAsCaller(() => callGatewayTool("node.list", {}, {}));
      const rejection = expect(pending).rejects.toThrow(
        /authority.*no longer active|Gateway instance unavailable/,
      );
      await entered.promise;
      if (owner === "run") {
        releaseAgentRunDelegatedAuthority(authority);
      } else {
        currentContext = { ...context };
      }
      release.resolve();
      await rejection;
      expect(callGateway).not.toHaveBeenCalled();
    },
  );

  it("cancels an outstanding approval and retires its request authority", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const controller = new AbortController();
    handleGatewayRequest.mockImplementationOnce(async ({ respond }) => {
      entered.resolve();
      await release.promise;
      respond(true, { id: "approval" });
    });
    const pending = runAsCaller(() =>
      callGatewayTool("exec.approval.request", {}, {}, { signal: controller.signal }),
    );
    const rejection = expect(pending).rejects.toThrow("approval cancelled");
    await entered.promise;
    const identity = handleGatewayRequest.mock.calls[0]?.[0].client?.internal?.agentRuntimeIdentity;
    expect(identity && context.validateAgentRuntimeApprovalAuthority?.(identity)).toBe(true);
    controller.abort(new Error("approval cancelled"));
    release.resolve();
    await rejection;
    expect(identity && context.validateAgentRuntimeApprovalAuthority?.(identity)).toBe(false);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("does not dispatch an already cancelled call", async () => {
    const controller = new AbortController();
    controller.abort(new Error("node lookup cancelled"));
    await expect(
      runAsCaller(() => callGatewayTool("node.list", {}, {}, { signal: controller.signal })),
    ).rejects.toThrow("node lookup cancelled");
    expect(handleGatewayRequest).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("retains an operator's scope and expiry across a bound multi-request operation", async () => {
    let request: ReturnType<typeof bindAgentToolGatewayRequest> | undefined;
    await withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, () =>
      withOperatorToolGatewayAuthority(
        {
          authenticatedUserProfile: {
            profileId: "operator",
            displayName: "operator",
            hasAvatar: false,
            updatedAt: 1,
          },
          scopes: ["operator.read"],
        },
        async () => {
          request = bindAgentToolGatewayRequest();
          await request({ method: "config.get", scopes: ["operator.read", "operator.write"] });
        },
      ),
    );
    expect(handleGatewayRequest.mock.calls[0]?.[0].client?.connect.scopes).toEqual([
      "operator.read",
    ]);
    if (!request) {
      throw new Error("operation not bound");
    }
    await expect(request({ method: "config.get" })).rejects.toThrow(
      "operator tool invocation authority expired",
    );
    expect(handleGatewayRequest).toHaveBeenCalledOnce();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("honors the caller deadline while a local handler is pending", async () => {
    const release = createDeferred();
    handleGatewayRequest.mockImplementationOnce(async ({ respond }) => {
      await release.promise;
      respond(true, { ok: true });
    });
    try {
      await expect(
        runAsCaller(() => callGatewayTool("node.list", { timeoutMs: 10 }, {})),
      ).rejects.toMatchObject({
        name: "GatewayProtocolRequestTimeoutError",
        code: "CLIENT_TIMEOUT",
        method: "node.list",
        timeoutMs: 10,
        requestSent: true,
      });
    } finally {
      release.resolve();
    }
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([{ gatewayUrl: "ws://127.0.0.1:18789" }, { gatewayToken: "explicit-test-token" }])(
    "retains explicit transport selection %j",
    async (overrides) => {
      await runAsCaller(() => callGatewayTool("node.list", { ...overrides, timeoutMs: 2345 }, {}));
      expect(callGateway).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          url: overrides.gatewayUrl,
          token: overrides.gatewayToken,
          timeoutMs: 2345,
          scopes: ["operator.read"],
        }),
      );
      expect(handleGatewayRequest).not.toHaveBeenCalled();
    },
  );

  it.each(["standalone", "localEmbedded"] as const)(
    "retains %s transport routing",
    async (kind) => {
      if (kind === "localEmbedded") {
        context.localEmbedded = true;
        await runAsCaller(() => callGatewayTool("node.list", {}, {}));
      } else {
        await callGatewayTool("node.list", {}, {});
      }
      expect(callGateway).toHaveBeenCalledOnce();
      expect(handleGatewayRequest).not.toHaveBeenCalled();
    },
  );
});
