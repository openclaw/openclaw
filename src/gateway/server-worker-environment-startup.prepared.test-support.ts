import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { Value } from "typebox/value";
import { assert, expect, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import { NodeInvokeResultParamsSchema } from "../../packages/gateway-protocol/src/schema/nodes.js";
import { NODE_WORKER_WORKSPACE_PREPARE_COMMAND } from "../infra/node-commands.js";
import {
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  NODE_WORKER_PREPARED_WORKSPACE_VERSION,
} from "../infra/node-runner-inventory.js";
import type { NodeHostClient } from "../node-host/client.js";
import {
  coerceNodeInvokePayload,
  coerceNodeInvokeCancelPayload,
} from "../node-host/invoke-payload.js";
import { handleInvoke, type NodeInvokeRequestPayload } from "../node-host/invoke.js";
import { NodeWorkerPreparedWorkspaceStore } from "../node-host/node-worker-prepared-workspace-store.js";
import { NodeWorkerWorkspaceRuntime } from "../node-host/node-worker-workspace.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import { parseNodeWorkerPreparedWorkspaceResult } from "../worker/node-workspace-prepared-protocol.js";
import { NODE_WORKSPACE_DRAIN_COMMAND } from "../worker/node-workspace-protocol.js";
import { createNodeRegistryRuntime, updateNodeRunnerInventory } from "./node-registry-private.js";
import { NodeRegistry } from "./node-registry.js";
import { makeClient } from "./node-registry.test-helpers.js";
import { loadGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.js";
import {
  createWorkerStartupRuntime,
  workerStartupCredential,
} from "./server-worker-environment-startup.runtime.test-support.js";
import { withGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.state.test-support.js";
import { gatewayTestTextTransport } from "./server/connection-transport.test-support.js";
import { createWorkerProjectPreparation } from "./worker-environments/project-preparation.js";
import { createProjectPreparationFixture } from "./worker-environments/project-preparation.test-support.js";
import * as serviceModule from "./worker-environments/service.js";
import { workerProjectSeedKey } from "./worker-environments/workspace-git-base.js";

async function createPreparedNodeAcknowledgement(root: string, cleanup: AsyncDisposableStack) {
  const projectFixture = await createProjectPreparationFixture(root, undefined, false, {
    "source.txt": "pristine source\n",
  });
  const { home, project } = projectFixture;
  const startup = await loadGatewayWorkerEnvironmentStartupState();
  const environmentId = "prepared-wire-environment";
  type Transition = Parameters<typeof startup.store.transition>[0];
  const transition = (
    from: Transition["from"],
    to: Transition["to"],
    patch?: Transition["patch"],
  ) => startup.store.transition({ environmentId, from, to, patch });
  const factory = vi.spyOn(serviceModule, "createWorkerEnvironmentService");
  const registry = createEmptyPluginRegistry();
  const network = new AsyncDisposableStack();
  cleanup.defer(() => network.disposeAsync());
  const pending = new Set<Promise<void>>();
  const connId = "prepared-wire-connection";
  const controllers = new Map<string, AbortController>();
  const cancelled = createDeferredCore<string>();
  const runtime = await createWorkerStartupRuntime(startup, () => registry);
  cleanup.defer(() => runtime.workerEnvironmentService?.stop());
  const options = factory.mock.calls.at(-1)?.[0];
  assert(
    options?.registerPreparedWorkspace && options.bindPreparedWorkspace && options.projectNamespace,
    "Prepared workspace callbacks were not composed",
  );
  const namespace = options.projectNamespace;
  const preparationKey = "a".repeat(64);
  const cacheKey = "c".repeat(64);
  const seed = path.join(
    home,
    ".openclaw-worker",
    "git-seeds",
    namespace,
    workerProjectSeedKey(project),
  );
  await fs.mkdir(path.dirname(seed), { recursive: true });
  await fs.rename(project.root, seed);
  project.root = seed;
  const operation = createWorkerProjectPreparation({
    project,
    namespace,
    preparation: { key: preparationKey, cacheKey, purpose: "session", demandAtMs: 0 },
    requireCurrent: () => {},
  });
  const { preparedWorkspace } = await operation.project
    .prepare({
      runScript: projectFixture.runScript,
      runScriptWithBudget: projectFixture.runScriptWithBudget.bind(projectFixture),
      upload: async () => {
        throw new Error("Fixture seed must already be available");
      },
    })
    .finally(() => operation.close());
  const prepared = parseNodeWorkerPreparedWorkspaceResult({
    ...preparedWorkspace,
    gatewayNamespace: namespace,
    environmentId,
    preparationKey,
    cacheKey,
  });
  assert(prepared && preparedWorkspace, "Project setup did not produce a valid workspace");
  const env = { ...process.env, HOME: home, OPENCLAW_STATE_DIR: path.join(root, "node-state") };
  const workspace = new NodeWorkerWorkspaceRuntime({ env, ephemeral: true });
  cleanup.defer(async () => {
    // Drain the actual local node before retiring even revoked synthetic attachments.
    for (const record of startup.store.list()) {
      if (record.state !== "attached") {
        continue;
      }
      for (const sessionId of record.attachedSessionIds) {
        const drained = await workspace.exec({
          gatewayNamespace: namespace,
          environmentId: record.environmentId,
          sessionId,
          generation: record.ownerEpoch,
          argv: [NODE_WORKSPACE_DRAIN_COMMAND],
        });
        expect(drained).toMatchObject({ code: 0, termination: "exit", stdout: "drained\n" });
      }
      await startup.store.transition({
        environmentId: record.environmentId,
        from: "attached",
        to: "idle",
        patch: { attachedSessionIds: [] },
      });
    }
  });
  cleanup.defer(async () => {
    for (const controller of controllers.values()) {
      controller.abort();
    }
    await Promise.all(pending);
  });
  const preparedStore = new NodeWorkerPreparedWorkspaceStore({ env });
  const nodeId = "prepared-wire-node";
  let pairingCurrent = true;
  let beforePairing: (() => Promise<void>) | undefined;
  const { nodeRegistry, nodeWorkerSupervisorTransport } = createNodeRegistryRuntime(
    () =>
      new NodeRegistry({
        resolveCurrentPairingState: async () => {
          await beforePairing?.();
          return pairingCurrent
            ? { identity: "fixture-pairing", generation: "fixture-generation" }
            : undefined;
        },
      }),
  );
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  network.defer(async () => {
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string", "Expected loopback listener");
  const connected = new Promise<WebSocket>((resolve) => {
    server.once("connection", resolve);
  });
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  network.defer(() => client.terminate());
  await once(client, "open");
  const socket = await connected;
  nodeRegistry.register(
    makeClient(connId, nodeId, [], {
      socket: gatewayTestTextTransport(socket),
      clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
      version: "test",
      platform: "test",
    }),
    { pairingIdentity: "fixture-pairing", pairingGeneration: "fixture-generation" },
  );
  network.defer(() => {
    nodeRegistry.unregister(connId);
  });
  const setPreparedWorkspace = (available: boolean) =>
    updateNodeRunnerInventory({
      registry: nodeRegistry,
      nodeId,
      connId,
      declaration: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: {
          enabled: true,
          capacity: { total: 1, available: 1 },
          environmentSession: 1,
          ...(available ? { preparedWorkspace: NODE_WORKER_PREPARED_WORKSPACE_VERSION } : {}),
        },
      },
    });
  setPreparedWorkspace(true);
  const received: Array<Parameters<NodeRegistry["handleInvokeResult"]>[0]> = [];
  const invoked: NodeInvokeRequestPayload[] = [];
  // Node replies use the real handler serializer and registry result owner;
  // only the outbound invoke request traverses the loopback WebSocket.
  function request<T>(...args: Parameters<NodeHostClient["request"]>): Promise<T>;
  async function request(_method: string, params?: unknown): Promise<unknown> {
    assert(
      Value.Check(NodeInvokeResultParamsSchema, params),
      "Node sent an invalid result envelope",
    );
    received.push({ ...params, connId });
    nodeRegistry.handleInvokeResult({ ...params, connId });
    return null;
  }
  client.on("message", (data) => {
    const frame = JSON.parse(rawDataToString(data)) as {
      event: string;
      payload: unknown;
    };
    if (frame.event === "node.invoke.cancel") {
      const cancellation = coerceNodeInvokeCancelPayload(frame.payload);
      if (cancellation) {
        controllers.get(cancellation.invokeId)?.abort();
        cancelled.resolve(cancellation.invokeId);
      }
      return;
    }
    if (frame.event !== "node.invoke.request") {
      return;
    }
    const input = coerceNodeInvokePayload(frame.payload);
    assert(input, "Node received an invalid invoke frame");
    expect(input.command).toBe(NODE_WORKER_WORKSPACE_PREPARE_COMMAND);
    invoked.push(input);
    const controller = new AbortController();
    controllers.set(input.id, controller);
    const invocation = handleInvoke(input, { request }, { current: async () => [] }, undefined, {
      workerWorkspace: workspace,
      signal: controller.signal,
    });
    pending.add(invocation);
    void invocation.finally(() => {
      pending.delete(invocation);
      controllers.delete(input.id);
    });
  });
  runtime.bindDeviceNodeControl?.(nodeWorkerSupervisorTransport);
  await startup.store.createIntent({
    environmentId,
    providerId: "fake",
    profileId: "prepared",
    profileSnapshot: {
      settings: {},
      project: {
        ...project,
        preparation: {
          key: preparationKey,
          cacheKey,
          contractVersion: 1,
          target: { machineClass: "test", platform: "linux", arch: "x64" },
          artifacts: {
            nodeBootstrapSha256: "b".repeat(64),
            enabledPluginIds: [],
            workerBundleHash: "a".repeat(64),
            workerArchiveSha256: "d".repeat(64),
            openclawVersion: "2026.8.1",
            protocolFeatures: [],
          },
        },
      },
    },
    provisionOperationId: "prepared-wire",
  });
  await startup.store.ensureNodeEnrollment(environmentId);
  const record = await transition("requested", "provisioning", { nodeDeviceId: nodeId });

  const register = (signal?: AbortSignal) =>
    options.registerPreparedWorkspace!({
      record,
      deviceId: nodeId,
      workspace: preparedWorkspace,
      assertCurrent: () => {},
      signal,
    });
  const attach = async () => {
    await transition("provisioning", "ready", {
      leaseId: "prepared-wire-lease",
      nodeDeviceId: nodeId,
      sharedHost: false,
      bootstrapReceipt: {
        bundleHash: "a".repeat(64),
        openclawVersion: "2026.8.1",
        protocolFeatures: [],
        installKind: "bundle",
      },
      credential: workerStartupCredential("prepared-ack-credential"),
    });
    const attached = await transition("ready", "attached", {
      attachedSessionIds: [binding.sessionId],
      credential: workerStartupCredential("prepared-bound-credential", binding.sessionId),
    });
    binding.ownerEpoch = attached.ownerEpoch;
    let placement = await startup.placementStore.startDispatch({
      sessionId: binding.sessionId,
      sessionKey: binding.sessionKey,
      agentId: "main",
    });
    for (const to of ["provisioning", "syncing"] as const) {
      placement = await startup.placementStore.transition({
        sessionId: binding.sessionId,
        from: placement.state,
        to,
        expectedGeneration: placement.generation,
        patch: {
          environmentId,
          ...(to === "syncing" ? { workerBundleHash: "a".repeat(64) } : {}),
        },
      });
    }
  };
  const binding = {
    environmentId,
    preparationKey,
    cacheKey,
    ownerEpoch: 1,
    sessionId: "prepared-session",
    sessionKey: "agent:main:prepared",
    assertCurrent: () => {},
  };

  return {
    prepared,
    record,
    workspace,
    preparedStore,
    received,
    invoked,
    cancelled,
    setPreparedWorkspace,
    register,
    attach,
    startup,
    revokePairing: () => {
      pairingCurrent = false;
    },
    holdPairing: (gate: () => Promise<void>) => {
      beforePairing = gate;
    },
    bind: (signal?: AbortSignal) => options.bindPreparedWorkspace!({ ...binding, signal }),
    binding,
    settleInvokes: () => Promise.all(pending),
  };
}

export async function withPreparedNodeAcknowledgement(
  root: string,
  run: (fixture: Awaited<ReturnType<typeof createPreparedNodeAcknowledgement>>) => Promise<void>,
) {
  await withGatewayWorkerEnvironmentStartupState(path.join(root, "gateway-state"), async () => {
    await using cleanup = new AsyncDisposableStack();
    await run(await createPreparedNodeAcknowledgement(root, cleanup));
  });
}
