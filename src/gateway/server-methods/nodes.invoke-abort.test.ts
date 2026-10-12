/** Ensures caller cancellation composes with, but never replaces, node pairing ownership. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { onAgentEvent, type AgentEventPayload } from "../../infra/agent-events.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { NODE_WORKER_SUPERVISOR_STATUS_COMMAND } from "../../infra/node-commands.js";
import type { NodeRegistry } from "../node-registry.js";
import { isNodeWakeLifecycleCurrent } from "../node-wake-state.js";
import { resetNodeWakeStateForTest } from "../node-wake-state.test-support.js";
import { nodeInvokeHandlers } from "./nodes.invoke.js";
import type { GatewayNodeInvokeStream, GatewayRequestHandlerOptions } from "./shared-types.js";

const mocks = vi.hoisted(() => ({
  captureNodePairingGeneration: vi.fn(async (nodeId: string) => ({
    nodeId,
    key: `generation:${nodeId}:1`,
  })),
  isNodePairingGenerationCurrent: vi.fn(async () => true),
  isNodeCommandAllowed: vi.fn((): { ok: true } | { ok: false; reason: string } => ({ ok: true })),
  resolveNodeCommandAllowlist: vi.fn(() => new Set<string>()),
  applyPluginNodeInvokePolicy: vi.fn(async () => undefined),
  sanitizeNodeInvokeParamsForForwarding: vi.fn(
    ({
      rawParams,
    }: {
      rawParams: unknown;
    }): { ok: true; params: unknown } | { ok: false; message: string } => ({
      ok: true,
      params: rawParams,
    }),
  ),
}));

vi.mock("../../infra/device-pairing-node-state.js", () => ({
  captureNodePairingGeneration: mocks.captureNodePairingGeneration,
  isNodePairingGenerationCurrent: mocks.isNodePairingGenerationCurrent,
}));

vi.mock("../node-command-policy.js", () => ({
  DEFAULT_DANGEROUS_NODE_COMMANDS: [],
  isForegroundRestrictedPluginNodeCommand: () => false,
  isNodeCommandAllowed: mocks.isNodeCommandAllowed,
  resolveNodeCommandAllowlist: mocks.resolveNodeCommandAllowlist,
}));

vi.mock("../node-invoke-plugin-policy.js", () => ({
  applyPluginNodeInvokePolicy: mocks.applyPluginNodeInvokePolicy,
}));

vi.mock("../node-invoke-sanitize.js", () => ({
  sanitizeNodeInvokeParamsForForwarding: mocks.sanitizeNodeInvokeParamsForForwarding,
}));

const session = {
  nodeId: "paired-node",
  connId: "paired-node-connection",
  pairingGeneration: "generation:paired-node:1",
  commands: ["ollama.chat"],
  client: { invalidated: false },
};

beforeEach(() => {
  resetNodeWakeStateForTest();
  vi.clearAllMocks();
});

afterEach(() => {
  resetNodeWakeStateForTest();
});

function startNodeInvoke(options: {
  invoke: ReturnType<typeof vi.fn>;
  signal?: AbortSignal;
  command?: string;
  config?: Record<string, unknown>;
  commands?: string[];
  client?: GatewayRequestHandlerOptions["client"];
  requestParams?: Record<string, unknown>;
  validateAgentRuntimeApprovalAuthority?: () => boolean;
}) {
  const respond = vi.fn();
  const handler = nodeInvokeHandlers["node.invoke"];
  if (!handler) {
    throw new Error("node.invoke handler is not registered");
  }
  const invocation = handler({
    req: { type: "req", id: "paired-inference-request", method: "node.invoke" },
    params: {
      nodeId: "paired-node",
      command: options.command ?? "ollama.chat",
      params: { model: "node-local:small", prompt: "answer locally" },
      timeoutMs: 10_000,
      idempotencyKey: "paired-inference-idempotency-key",
      ...options.requestParams,
    },
    client: options.client ?? null,
    isWebchatConnect: () => false,
    respond,
    context: {
      nodeRegistry: {
        get: () => ({ ...session, commands: options.commands ?? session.commands }),
        getForPairingGeneration: () => ({
          ...session,
          commands: options.commands ?? session.commands,
        }),
        invoke: options.invoke,
      },
      getRuntimeConfig: () => options.config ?? {},
      validateAgentRuntimeApprovalAuthority: options.validateAgentRuntimeApprovalAuthority,
      logGateway: { info: vi.fn(), warn: vi.fn() },
    } as unknown as GatewayRequestHandlerOptions["context"],
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { invocation, respond };
}

function createNodeInvokeStreamClient(
  stream: GatewayNodeInvokeStream,
  options?: { synthetic?: boolean; owner?: boolean },
): NonNullable<GatewayRequestHandlerOptions["client"]> {
  return {
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: "gateway-client", version: "internal", platform: "node", mode: "backend" },
      role: "operator",
      scopes: ["operator.write"],
    },
    internal: {
      ...(options?.synthetic === false ? {} : { syntheticClient: true }),
      ...(options?.owner === false ? {} : { pluginRuntimeOwnerId: "duplex-fixture" }),
      nodeInvokeStream: stream,
    },
  };
}

describe("node.invoke caller cancellation", () => {
  it.each([true, false])(
    "projects native permissions only into the authenticated session (bound=%s)",
    async (bound) => {
      const nativeDetails = {
        capabilities: ["accessibility", "eventPosting", "screenRecording", "computerControl"],
        state: "denied",
      };
      const invoke = vi.fn<NodeRegistry["invoke"]>(async () => ({
        ok: false,
        error: {
          code: "PERMISSION_MISSING",
          message: "Native permissions missing",
          details: nativeDetails,
        },
      }));
      const run = createOperationalRunInstanceRef("permission-run");
      const authority = claimAgentRunDelegatedAuthority(run);
      const events: AgentEventPayload[] = [];
      const stop = onAgentEvent((event) => events.push(event));
      try {
        const client: NonNullable<GatewayRequestHandlerOptions["client"]> = {
          connect: {
            minProtocol: 3,
            maxProtocol: 3,
            role: "operator",
            scopes: ["operator.admin"],
            client: { id: "gateway-client", version: "test", platform: "node", mode: "backend" },
          },
          ...(bound
            ? {
                internal: {
                  agentRuntimeIdentity: {
                    kind: "agentRuntime",
                    agentId: "main",
                    sessionKey: "agent:main:permission",
                    operationalRunInstance: run,
                    delegatedAuthority: { ...authority, kind: "local" },
                  },
                },
              }
            : {}),
        };
        const { invocation, respond } = startNodeInvoke({
          invoke,
          client,
          command: "computer.act",
          commands: ["computer.act"],
          requestParams: { sessionKey: "agent:other:spoofed" },
          validateAgentRuntimeApprovalAuthority: () => true,
        });
        await invocation;
        const permissionMissing = {
          nodeId: "paired-node",
          command: "computer.act",
          ...nativeDetails,
        };
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            message: expect.stringContaining(
              "Accessibility, Event Posting, Screen Recording, Computer Control required on node paired-node",
            ),
            details: expect.objectContaining({
              nodeError: {
                code: "PERMISSION_MISSING",
                message: "Native permissions missing",
                details: nativeDetails,
              },
              permissionMissing,
            }),
          }),
        );
        const error = respond.mock.calls[0]?.[2];
        expect(error.message).toContain("Do not retry until the user confirms");
        expect(error.message.includes("shown a Grant card")).toBe(bound);
        expect(events).toEqual(
          bound
            ? [
                expect.objectContaining({
                  runId: run.runId,
                  sessionKey: "agent:main:permission",
                  stream: "notice",
                  data: { phase: "warning", kind: "permission_missing", permissionMissing },
                }),
              ]
            : [],
        );
        expect(invoke).toHaveBeenCalledOnce();
      } finally {
        stop();
        releaseAgentRunDelegatedAuthority(authority);
      }
    },
  );

  it("carries trusted plugin duplex hooks through the canonical paired dispatch", async () => {
    let runtimeCurrent = true;
    const stream = {
      onProgress: vi.fn(),
      onDispatchReady: vi.fn(),
      idleTimeoutMs: 5_000,
      isRuntimeCurrent: () => runtimeCurrent,
    };
    const invoke = vi.fn(
      async (params: {
        onProgress?: (chunk: string) => void;
        onDispatchReady?: (invokeId: string) => void;
        isDispatchAuthorized?: () => boolean;
        signal?: AbortSignal;
      }) => {
        expect(
          params.signal &&
            isNodeWakeLifecycleCurrent("paired-node", params.signal, "generation:paired-node:1"),
        ).toBe(true);
        params.onDispatchReady?.("paired-stream-invoke");
        params.onProgress?.("paired-stream-progress");
        return { ok: true, payload: { delivered: true } };
      },
    );

    const { invocation, respond } = startNodeInvoke({
      invoke,
      client: createNodeInvokeStreamClient(stream),
    });
    await invocation;

    expect(stream.onDispatchReady).toHaveBeenCalledWith("paired-stream-invoke");
    expect(stream.onProgress).toHaveBeenCalledWith("paired-stream-progress");
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedConnId: "paired-node-connection",
        expectedPairingGeneration: "generation:paired-node:1",
        idleTimeoutMs: 5_000,
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ nodeId: "paired-node", command: "ollama.chat" }),
      undefined,
    );

    runtimeCurrent = false;
    expect(invoke.mock.calls[0]?.[0].isDispatchAuthorized?.()).toBe(false);
  });

  it.each([
    { name: "network client", synthetic: false },
    { name: "ownerless synthetic client", owner: false },
  ])("ignores duplex hooks on an untrusted $name", async (clientOptions) => {
    const stream = {
      onProgress: vi.fn(),
      onDispatchReady: vi.fn(),
      isRuntimeCurrent: () => false,
    };
    const invoke = vi.fn(
      async (params: {
        onProgress?: (chunk: string) => void;
        onDispatchReady?: (invokeId: string) => void;
        isDispatchAuthorized?: () => boolean;
      }) => {
        params.onDispatchReady?.("untrusted-stream-invoke");
        params.onProgress?.("untrusted-stream-progress");
        return { ok: true, payload: {} };
      },
    );

    const { invocation } = startNodeInvoke({
      invoke,
      client: createNodeInvokeStreamClient(stream, clientOptions),
    });
    await invocation;

    expect(stream.onDispatchReady).not.toHaveBeenCalled();
    expect(stream.onProgress).not.toHaveBeenCalled();
    expect(invoke.mock.calls[0]?.[0].isDispatchAuthorized?.()).toBe(true);
  });

  it("does not bypass system.run approval sanitization for trusted duplex hooks", async () => {
    mocks.sanitizeNodeInvokeParamsForForwarding.mockReturnValueOnce({
      ok: false,
      message: "system.run approval could not be verified",
    });
    const stream = {
      onProgress: vi.fn(),
      onDispatchReady: vi.fn(),
      isRuntimeCurrent: () => true,
    };
    const invoke = vi.fn();

    const { invocation, respond } = startNodeInvoke({
      invoke,
      command: "system.run",
      commands: ["system.run"],
      client: createNodeInvokeStreamClient(stream),
    });
    await invocation;

    expect(mocks.sanitizeNodeInvokeParamsForForwarding).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
    expect(stream.onDispatchReady).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "system.run approval could not be verified" }),
    );
  });

  it("rejects private controls before public policy and dispatch", async () => {
    const command = NODE_WORKER_SUPERVISOR_STATUS_COMMAND;
    const invoke = vi.fn();
    const stream = {
      onProgress: vi.fn(),
      onDispatchReady: vi.fn(),
      isRuntimeCurrent: () => true,
    };
    const { invocation, respond } = startNodeInvoke({
      invoke,
      command,
      commands: [command],
      config: { gateway: { nodes: { commands: { allow: [command] } } } },
      client: createNodeInvokeStreamClient(stream),
    });

    await invocation;

    expect(invoke).not.toHaveBeenCalled();
    expect(mocks.resolveNodeCommandAllowlist).not.toHaveBeenCalled();
    expect(mocks.applyPluginNodeInvokePolicy).not.toHaveBeenCalled();
    expect(stream.onDispatchReady).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("private") }),
    );
  });

  it("cancels paired-node work without breaking pairing lifecycle identity", async () => {
    const controller = new AbortController();
    const invoke = vi.fn(
      (params: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          params.signal?.addEventListener(
            "abort",
            () => resolve({ ok: false, error: { code: "ABORTED", message: "canceled" } }),
            { once: true },
          );
        }),
    );
    const { invocation, respond } = startNodeInvoke({ invoke, signal: controller.signal });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    const invocationSignal = invoke.mock.calls[0]?.[0].signal as AbortSignal;

    expect(invocationSignal).toBeInstanceOf(AbortSignal);
    expect(invocationSignal.aborted).toBe(false);
    expect(invocationSignal).not.toBe(controller.signal);
    controller.abort(new Error("paired inference canceled"));

    await invocation;

    expect(invocationSignal.aborted).toBe(true);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        details: expect.objectContaining({
          nodeError: expect.objectContaining({ code: "ABORTED" }),
        }),
      }),
    );
  });
});

it.each([true, false])(
  "captures outer completion source only from a bound agent (bound=%s)",
  async (bound) => {
    const invoke = vi.fn<NodeRegistry["invoke"]>(async () => ({
      ok: true,
      payload: { exitCode: 0 },
    }));
    const operationalRunInstance = createOperationalRunInstanceRef("captured-source-run");
    const client: NonNullable<GatewayRequestHandlerOptions["client"]> = {
      connect: {
        minProtocol: 3,
        maxProtocol: 3,
        client: { id: "gateway-client", version: "internal", platform: "node", mode: "backend" },
        role: "operator",
        scopes: ["operator.admin", "operator.write"],
      },
      ...(bound
        ? {
            internal: {
              agentRuntimeIdentity: {
                kind: "agentRuntime",
                agentId: "main",
                sessionKey: "agent:main:main",
                operationalRunInstance,
                delegatedAuthority: {
                  kind: "local",
                  operationalRunInstance,
                  lifecycleGeneration: "generation",
                  claimId: "claim",
                },
              },
            },
          }
        : {}),
    };
    const { invocation, respond } = startNodeInvoke({
      invoke,
      command: "system.run",
      commands: ["system.run"],
      client,
      validateAgentRuntimeApprovalAuthority: () => true,
      requestParams: {
        sessionKey: "agent:main:main",
        turnSourceChannel: "telegram",
        turnSourceTo: "-100123:topic:42",
        turnSourceAccountId: "work",
        turnSourceThreadId: "42",
      },
    });
    await invocation;
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      turnSource: bound
        ? { channel: "telegram", to: "-100123:topic:42", accountId: "work", threadId: "42" }
        : undefined,
    });
  },
);
