import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../infra/node-runner-inventory.js";
import {
  beginGatewayRestartSignalAdmission,
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { ExecApprovalManager } from "./exec-approval-manager.js";
import { createTestApprovalManager } from "./exec-approval-manager.test-support.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createNodeRegistryRuntime, updateNodeRunnerInventory } from "./node-registry-private.js";
import { NodeRegistry } from "./node-registry.js";
import { QuestionManager } from "./question-manager.js";
import { handleGatewayRequest } from "./server-methods.js";
import { handleNodeInvokeProgress } from "./server-methods/nodes.handlers.invoke-progress.js";
import { handleNodeInvokeResult } from "./server-methods/nodes.handlers.invoke-result.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./server-methods/types.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const managerCleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  try {
    await Promise.all(managerCleanups.splice(0).map(async (close) => await close()));
  } finally {
    resetGatewayWorkAdmission();
  }
});

function expectRejected(respond: unknown, code = "UNAVAILABLE") {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code }));
}

function closeAdmission(mode: "suspension" | "restart signal" | "restart drain" | "direct close") {
  if (mode === "restart signal") {
    expect(beginGatewayRestartSignalAdmission()).not.toBeNull();
  } else if (mode === "restart drain") {
    markGatewayRestartDraining();
  } else if (mode === "suspension") {
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.drain()).toBe(true);
    return suspension;
  }
}

const nodeDevice = {
  id: "node-1",
  publicKey: "key",
  signature: "sig",
  signedAt: 1,
  nonce: "nonce",
};

function createClient(role: "operator" | "node"): GatewayWsClient {
  const id = role === "node" ? "node-1" : "cli";
  const client = {
    connId: "conn-live",
    usesSharedGatewayAuth: false,
    socket: { readyState: 1, bufferedAmount: 0, send: vi.fn() },
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role,
      scopes: role === "operator" ? ["operator.admin"] : [],
      client: { id, version: "test", platform: "test", mode: role },
    },
  } as unknown as GatewayWsClient;
  if (role === "node") {
    client.connect.device = { ...nodeDevice };
  }
  return client;
}

function createContext(owners: {
  nodeRegistry?: NodeRegistry;
  execApprovalManager?: ExecApprovalManager;
  questionManager?: QuestionManager;
}): GatewayRequestContext {
  return {
    getRuntimeConfig: () => ({}),
    logGateway: { warn: vi.fn(), debug: vi.fn() },
    ...owners,
  } as unknown as GatewayRequestContext;
}

function bindDispatch(
  context: GatewayRequestContext,
  client: GatewayWsClient,
  admission?: "continuation",
) {
  return async (
    method: string,
    requestParams: Record<string, unknown>,
    handler: GatewayRequestHandler,
  ) => {
    const respond = vi.fn();
    await handleGatewayRequest({
      req: { type: "req", id: `request-${method}`, method, params: requestParams },
      respond,
      client,
      context,
      admission,
      isWebchatConnect: () => false,
      methodRegistry: createGatewayMethodRegistry([
        createPluginGatewayMethodDescriptor({
          pluginId: "suspension-continuation-proof",
          name: method,
          handler,
          scope: "operator.admin",
        }),
      ]),
    });
    return respond;
  };
}

async function createLifecycleInvoke() {
  const client = createClient("node");
  const send = vi.spyOn(client.socket, "send");
  client.connect.client.id = GATEWAY_CLIENT_IDS.NODE_HOST;
  client.connect.commands = [NODE_WORKER_ENVIRONMENT_STOP_COMMAND];
  let generation = "generation-live";
  let ownerActive = true;
  const { nodeRegistry: registry, nodeWorkerSupervisorTransport: transport } =
    createNodeRegistryRuntime(
      () =>
        new NodeRegistry({
          resolveCurrentPairingState: async () => ({ identity: "paired", generation }),
        }),
    );
  registry.register(client, { pairingIdentity: "paired", pairingGeneration: generation });
  updateNodeRunnerInventory({
    registry,
    nodeId: "node-1",
    connId: client.connId,
    declaration: {
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
      workerHost: { enabled: true, capacity: { total: 1, available: 1 }, environmentSession: 1 },
    },
  });
  const [node] = await transport.listCurrentNodes();
  if (!node) {
    throw new Error("expected current worker supervisor");
  }
  const ready = createDeferredCore<string>();
  const abort = new AbortController();
  const result = transport.invoke({
    node,
    command: NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
    params: { environmentId: "environment-owned", sessionId: "session-owned", ownerEpoch: 1 },
    timeoutMs: 60_000,
    signal: abort.signal,
    isDispatchAuthorized: () => ownerActive,
    onDispatchReady: ready.resolve,
  });
  const invokeId = await awaitGateBeforeSettlement(
    ready.promise,
    result,
    "lifecycle invocation finished before dispatch",
  );
  return {
    client,
    send,
    context: createContext({ nodeRegistry: registry }),
    invokeId,
    result,
    closeOwner: () => {
      ownerActive = false;
    },
    rotatePairing: () => {
      const previous = generation;
      generation = "generation-next";
      registry.updateSurface(
        "node-1",
        { commands: [NODE_WORKER_ENVIRONMENT_STOP_COMMAND] },
        {
          expectedConnId: client.connId,
          expectedPairingIdentity: "paired",
          expectedPairingGeneration: previous,
          nextPairingGeneration: generation,
        },
      );
    },
    [Symbol.asyncDispose]: async () => {
      abort.abort();
      registry.unregister(client.connId);
      await result;
    },
  };
}

const questionChoices = [
  { questionId: "choice", header: "Choice", question: "Continue?", options: [], isOther: true },
];

function resultRequest(invokeId: string) {
  return { id: invokeId, nodeId: "node-1", ok: true, payloadJSON: "null" };
}

describe("draining Gateway completion ownership", () => {
  it.for([
    { mode: "suspension", method: "exec.approval.resolve" },
    { mode: "restart signal", method: "approval.resolve" },
  ] as const)(
    "admits only an exact live approval continuation through $method during $mode",
    async ({ mode, method }, testContext) => {
      const manager = createTestApprovalManager(testContext);
      managerCleanups.push(() => manager.drain());
      const client = createClient("operator");
      const context = createContext({ execApprovalManager: manager });
      const call = bindDispatch(context, client);
      const ownerReady = createDeferredCore();
      const root = expectDefined(tryBeginGatewayRootWorkAdmission(), "admitted owner");
      const owner = root
        .run(async () => {
          const record = manager.create({ command: "echo ok" }, 60_000, "approval-owned");
          const decision = (await manager.register(record, 60_000)).decision;
          ownerReady.resolve();
          return await decision;
        })
        .finally(root.release);
      await ownerReady.promise;
      expect(getActiveGatewayRootWorkCount()).toBe(1);

      const suspension = closeAdmission(mode);
      const handler = vi.fn<GatewayRequestHandler>(async ({ respond }) => {
        respond(true, { applied: await manager.resolve("approval-owned", "allow-once") });
      });
      const shape = method === "approval.resolve" ? { kind: "exec", decision: "allow-once" } : {};

      const wrong = await call(method, { id: "approval-unrelated", ...shape }, handler);
      expectRejected(wrong);
      expect(handler).not.toHaveBeenCalled();

      const accepted = await call(method, { id: "approval-owned", ...shape }, handler);
      expect(accepted).toHaveBeenCalledWith(true, { applied: true });
      await expect(owner).resolves.toBe("allow-once");
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      if (suspension) {
        expect(suspension.release()).toBe(true);
      }
    },
  );

  it("admits exact question inspection and resolution during restart drain without admitting unrelated roots", async () => {
    const manager = new QuestionManager(createTestGatewayScheduler());
    managerCleanups.push(() => manager.close());
    const client = createClient("operator");
    const context = createContext({ questionManager: manager });
    const call = bindDispatch(context, client);
    const root = expectDefined(tryBeginGatewayRootWorkAdmission(), "admitted owner");
    await root.run(async () => {
      manager.request({ id: "question-owned", questions: questionChoices, timeoutMs: 60_000 });
    });
    root.release();
    // question.request returns before question.waitAnswer begins. The pending
    // question itself retains the exact admitted root across that RPC boundary.
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    const answer = manager.waitAnswer("question-owned");
    closeAdmission("restart drain");

    const newWork = vi.fn();
    const refused = await call("question.request", { id: "question-new" }, newWork);
    expectRejected(refused);
    expect(newWork).not.toHaveBeenCalled();

    const inspected = await call("question.get", { id: "question-owned" }, ({ respond }) =>
      respond(true, { question: manager.get("question-owned") }),
    );
    expect(inspected).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ question: expect.any(Object) }),
    );
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    const unrelated = await call(
      "question.resolve",
      { id: "question-unrelated" },
      vi.fn<GatewayRequestHandler>(),
    );
    expectRejected(unrelated);

    const answered = await call("question.resolve", { id: "question-owned" }, ({ respond }) => {
      respond(true, manager.resolve("question-owned", { answers: { choice: ["yes"] } }));
    });
    expect(answered).toHaveBeenCalledWith(true, {
      status: "answered",
      answers: { answers: { choice: ["yes"] } },
    });
    expect(manager.get("question-owned")).toMatchObject({ status: "answered" });
    await expect(answer).resolves.toEqual({
      status: "answered",
      answers: { answers: { choice: ["yes"] } },
    });
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    const replay = await call("question.resolve", { id: "question-owned" }, newWork);
    expectRejected(replay);
    expect(newWork).not.toHaveBeenCalled();
  });

  it("does not borrow a replacement question root for question.get during suspension after synchronous expiry", async () => {
    const clock = createGatewaySchedulerClock(Date.now());
    const manager = new QuestionManager(createTestGatewayScheduler(clock.clock));
    managerCleanups.push(() => manager.close());
    const originalRoot = expectDefined(tryBeginGatewayRootWorkAdmission(), "original producer");
    const replacementRoot = expectDefined(
      tryBeginGatewayRootWorkAdmission(),
      "replacement producer",
    );
    const request = { id: "question-reused", questions: questionChoices, timeoutMs: 60_000 };
    let replacement: Promise<void> | undefined;
    const original = await originalRoot.run(async () =>
      manager.request({
        ...request,
        onResolved: () => {
          manager.reset();
          // The second producer was admitted before drain, independently of the old question.
          replacement = replacementRoot.run(async () => {
            manager.request(request);
          });
        },
      }),
    );
    originalRoot.release();
    expect(getActiveGatewayRootWorkCount()).toBe(2);
    const suspension = closeAdmission("suspension");
    clock.setTime(original.expiresAtMs + 1);
    const handler = vi.fn<GatewayRequestHandler>();
    try {
      const response = await bindDispatch(
        createContext({ questionManager: manager }),
        createClient("operator"),
      )("question.get", { id: request.id }, handler);
      expectRejected(response);
      expect(handler).not.toHaveBeenCalled();
      await replacement;
      expect(manager.get(request.id)).toMatchObject({
        status: "pending",
        createdAtMs: original.expiresAtMs + 1,
      });
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    } finally {
      await replacement;
      originalRoot.release();
      replacementRoot.release();
      manager.close();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      if (suspension) {
        expect(suspension.release()).toBe(true);
      }
    }
  });

  it("admits only the registered node's exact live progress and result during suspension", async () => {
    const node = createClient("node");
    const registry = new NodeRegistry({
      resolveCurrentPairingState: async () => ({
        identity: "paired",
        generation: "generation-live",
      }),
    });
    registry.register(node, { pairingIdentity: "paired", pairingGeneration: "generation-live" });
    const context = createContext({ nodeRegistry: registry });
    const call = bindDispatch(context, node);
    const invokeReady = createDeferredCore<string>();
    const finishDelivery = createDeferredCore();
    const chunks: string[] = [];
    const root = expectDefined(tryBeginGatewayRootWorkAdmission(), "admitted owner");
    const owner = root
      .run(async () => {
        const result = await registry.invoke({
          nodeId: "node-1",
          command: "debug.ping",
          timeoutMs: 60_000,
          onProgress: (chunk) => chunks.push(chunk),
          onDispatchReady: invokeReady.resolve,
        });
        await finishDelivery.promise;
        return result;
      })
      .finally(root.release);
    const invokeId = await awaitGateBeforeSettlement(
      invokeReady.promise,
      owner,
      "node invocation finished before its dispatch became ready",
    );
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    const suspension = closeAdmission("suspension");

    try {
      const ignored = await call(
        "node.invoke.result",
        { id: "unrelated-invoke", nodeId: "node-1", ok: true },
        vi.fn<GatewayRequestHandler>(),
      );
      expectRejected(ignored);

      const malformed = await call(
        "node.invoke.progress",
        { invokeId, nodeId: "node-1", seq: -1, chunk: "invalid" },
        handleNodeInvokeProgress,
      );
      expectRejected(malformed, "INVALID_REQUEST");
      expect(chunks).toEqual([]);
      expect(getActiveGatewayRootWorkCount()).toBe(1);

      const progressed = await call(
        "node.invoke.progress",
        { invokeId, nodeId: "node-1", seq: 0, chunk: "working" },
        handleNodeInvokeProgress,
      );
      expect(progressed).toHaveBeenCalledWith(true, { ok: true, ignored: false }, undefined);
      expect(chunks).toEqual(["working"]);

      const completed = await call(
        "node.invoke.result",
        { id: invokeId, nodeId: "node-1", ok: true, payloadJSON: null, error: null },
        handleNodeInvokeResult,
      );
      expect(completed).toHaveBeenCalledWith(true, { ok: true }, undefined);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      finishDelivery.resolve();
      await expect(owner).resolves.toMatchObject({ ok: true, payloadJSON: null, error: null });
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      if (suspension) {
        expect(suspension.release()).toBe(true);
      }
    } finally {
      finishDelivery.resolve();
      registry.unregister(node.connId);
      await owner;
    }
  });
});

describe("restart lifecycle completion ownership", () => {
  it.each(["direct close", "restart drain"] as const)(
    "settles newly dispatched lifecycle cleanup during %s without admitting another root",
    async (mode) => {
      closeAdmission(mode);
      const admission = mode === "direct close" ? "continuation" : undefined;
      await using invoke = await createLifecycleInvoke();
      const call = bindDispatch(invoke.context, invoke.client, admission);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      const newWork = vi.fn();
      const refused = await call("node.runnerInventory.update", {}, newWork);
      expectRejected(refused);
      expect(newWork).not.toHaveBeenCalled();
      const progressed = await call(
        "node.invoke.progress",
        { invokeId: invoke.invokeId, nodeId: "node-1", seq: 0, chunk: "stopped" },
        (options) => {
          expect(getActiveGatewayRootWorkCount()).toBe(0);
          return handleNodeInvokeProgress(options);
        },
      );
      // Lifecycle invokes have no stream consumer, but authenticated progress
      // still records execution and prevents a contradictory not-ready replay.
      expect(progressed).toHaveBeenCalledWith(true, { ok: true, ignored: true }, undefined);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      if (mode !== "direct close") {
        expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
      }
      const completed = await call(
        "node.invoke.result",
        {
          ...resultRequest(invoke.invokeId),
          ok: false,
          error: { code: "NODE_NOT_READY", message: "not ready" },
        },
        handleNodeInvokeResult,
      );
      expect(completed).toHaveBeenCalledWith(true, { ok: true }, undefined);
      await expect(invoke.result).resolves.toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "node reported not-ready after invocation progress",
        },
      });
      const replayed = await call(
        "node.invoke.result",
        resultRequest(invoke.invokeId),
        handleNodeInvokeResult,
      );
      expectRejected(replayed);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      if (mode !== "direct close") {
        expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
      }
    },
  );

  it.each([
    ["node", "entry"],
    ["connection", "entry"],
    ["pairing", "entry"],
    ["owner", "entry"],
    ["owner", "settlement"],
    ["pairing", "settlement"],
  ] as const)("rechecks %s identity at %s during restart drain", async (changed, phase) => {
    closeAdmission("restart drain");
    await using invoke = await createLifecycleInvoke();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const request = resultRequest(invoke.invokeId);
    let client = invoke.client;
    const revoke = () => {
      if (changed === "node") {
        request.nodeId = "unrelated-node";
      } else if (changed === "connection") {
        client = { ...invoke.client, connId: "replaced-connection" };
      } else if (changed === "pairing") {
        invoke.rotatePairing();
      } else {
        invoke.closeOwner();
      }
    };
    try {
      if (phase === "entry") {
        revoke();
      }
      const response = bindDispatch(invoke.context, client)(
        "node.invoke.result",
        request,
        async (options) => {
          if (phase === "settlement") {
            expect(getActiveGatewayRootWorkCount()).toBe(0);
            entered.resolve();
            await release.promise;
            expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
          }
          await handleNodeInvokeResult(options);
        },
      );
      if (phase === "settlement") {
        await awaitGateBeforeSettlement(
          entered.promise,
          response,
          "lifecycle completion was rejected before reaching its handler",
        );
        revoke();
        release.resolve();
        expect(await response).toHaveBeenCalledWith(true, { ok: true, ignored: true }, undefined);
      } else {
        expectRejected(await response);
      }
      if (changed === "owner" || changed === "pairing") {
        expect(invoke.send.mock.calls.map(([frame]) => frame.toString())).toContainEqual(
          expect.stringContaining('"event":"node.invoke.cancel"'),
        );
        await expect(invoke.result).resolves.toMatchObject({
          ok: false,
          error: { code: changed === "owner" ? "APPROVAL_AUTHORITY_CLOSED" : "PAIRING_CHANGED" },
        });
      }
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      release.resolve();
    }
  });
});
