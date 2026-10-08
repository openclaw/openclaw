import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "../../packages/gateway-client/src/websocket.js";
import type { WorkerAdmissionHandshake } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import {
  acquireGatewayTestWebSocket,
  closeGatewayTestWebSocket,
} from "../../test/helpers/gateway-websocket.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { writeConfigFile } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import * as nodePairing from "../infra/device-pairing-node-state.js";
import * as nodePairingWrites from "../infra/device-pairing-node.js";
import {
  NODE_WORKER_PORTAL_STREAM_COMMAND,
  NODE_WORKER_WORKSPACE_RETAIN_COMMAND,
} from "../infra/node-commands.js";
import {
  NODE_WORKER_PORTAL_STREAM_VERSION,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../infra/node-runner-inventory.js";
import {
  coerceNodeInvokeCancelPayload,
  coerceNodeInvokePayload,
} from "../node-host/invoke-payload.js";
import { invokeNodeWorkerPortalStream } from "../node-host/portal-stream-command.js";
import { projectPluginContributions } from "../plugins/registry-contributions.js";
import { adoptPluginRegistryRecords } from "../plugins/registry-lifecycle.js";
import * as stateWorkerStore from "../state/openclaw-state-worker-store.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withEnvAsync } from "../test-utils/env.js";
import { pairDeviceIdentity } from "./device-authz.test-helpers.js";
import * as workerStartup from "./server-worker-environment-startup.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  NODE_CLIENT,
  rpcReq,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";
import { trackConnectChallengeNonce } from "./test-helpers.js";
import * as workerBundles from "./worker-environments/bundle.js";
import { hashWorkerCredential } from "./worker-environments/credential.js";
import * as workerService from "./worker-environments/service.js";

installGatewayTestHooks({ scope: "suite" });

describe("session portal fixture", () => {
  const fixture = createFixtureLifetime();
  // This inner hook joins the body before parent hooks reset shared Gateway state.
  afterEach(() => fixture.cleanup());
  it(
    "carries authenticated session previews through the node and retires access before persistence",
    ({ signal }) => fixture.run(() => runSessionPortalProof(signal)),
    30_000,
  );
});

async function runSessionPortalProof(signal: AbortSignal) {
  const origin = "https://control.example.test";
  const auth = {
    mode: "trusted-proxy" as const,
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
    },
  };
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [origin] };
  await writeConfigFile({
    agents: { entries: { main: {} } },
    cloudWorkers: { profiles: { preview: { provider: "preview-proof", settings: {} } } },
    gateway: {
      auth,
      trustedProxies: ["127.0.0.1"],
      controlUi: { allowedOrigins: [origin] },
      roles: {
        default: "writer",
        definitions: {
          writer: {
            agents: "*",
            sessions: { others: "none" },
            scopes: ["operator.sessions.write"],
          },
        },
      },
    },
  });
  const writer = ensureProfileForEmail("preview-writer@example.test");
  const outsider = ensureProfileForEmail("preview-outsider@example.test");
  setUserProfileRole(writer.id, "writer");
  setUserProfileRole(outsider.id, "writer");
  const identity = {
    agentId: "main",
    sessionKey: "agent:main:preview-wire",
    sessionId: "preview-wire",
  };
  replaceSessionEntrySync(identity, {
    sessionId: identity.sessionId,
    updatedAt: 1,
    createdActor: { type: "human", source: "profile", id: writer.id },
    visibility: "read-only",
  });

  let sharedHost: boolean | undefined = false;

  const requests: string[] = [];
  let connections = 0;
  const peers = new Set<Socket>();
  const destination = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("Content-Type", "text/plain");
    if (request.url === "/stream") {
      response.write("preview-stream");
    } else {
      response.end("preview-ok");
    }
  });
  destination.on("connection", (socket) => {
    connections++;
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
  });
  await new Promise<void>((resolve) => {
    destination.listen(0, "127.0.0.1", resolve);
  });
  const destinationPort = (destination.address() as AddressInfo).port;
  const runtimeFactory = vi.spyOn(workerStartup, "createGatewayWorkerEnvironmentRuntime");
  const serviceFactory = vi.spyOn(workerService, "createWorkerEnvironmentService");
  // Packing an ambient dist/worker build costs tens of seconds and no part of this proof.
  vi.spyOn(workerBundles, "createWorkerBundleProducer").mockReturnValue({
    prepare: async () => ({
      install: "bundle",
      bundleHash: "a".repeat(64),
      openclawVersion: "2026.9.1",
      protocolFeatures: [],
      tarballBytes: 1,
      tarballSha256: "b".repeat(64),
      tarballPath: "/synthetic/worker.tgz",
    }),
    prune: async () => {},
  });
  const recordConnection = nodePairingWrites.recordPairedNodeConnection;
  const nodeConnectionRecorded = createDeferred<Awaited<ReturnType<typeof recordConnection>>>();
  vi.spyOn(nodePairingWrites, "recordPairedNodeConnection").mockImplementation((...args) => {
    const recording = recordConnection(...args);
    nodeConnectionRecorded.resolve(recording);
    return recording;
  });
  const resolvePairing = nodePairing.resolveCurrentPairedDeviceNodeBinding;
  let pairingGate: (() => Promise<void>) | undefined;
  vi.spyOn(nodePairing, "resolveCurrentPairedDeviceNodeBinding").mockImplementation(
    async (...args) => {
      await pairingGate?.();
      return await resolvePairing(...args);
    },
  );

  try {
    // Worker startup is intentionally omitted by the minimal auth harness.
    await withEnvAsync({ OPENCLAW_TEST_MINIMAL_GATEWAY: "0" }, () =>
      withGatewayServer(async ({ port, server }) => {
        await server.startupSettled;
        signal.throwIfAborted();
        const startup = runtimeFactory.mock.calls.at(-1)?.[0];
        assert(startup, "Gateway must create its real worker runtime");
        const { config, registry } = createPluginRegistryFixture();
        registerVirtualTestPlugin({
          config,
          registry,
          id: "preview-proof",
          name: "Preview proof provider",
          contracts: { workerProviders: ["preview-proof"] },
          register(api) {
            api.registerWorkerProvider({
              id: "preview-proof",
              supportedExecutionModes: ["remote-exec"],
              resolveAllocation: async () => ({ leaseId: "preview-lease", sharedHost: false }),
              provision: async () => {
                throw new Error("The proof seeds an already provisioned dedicated lease");
              },
              inspect: async () => ({ status: "active", sharedHost }),
              destroy: async () => {},
            });
          },
        });
        const record = registry.registry.plugins[0]!;
        const liveRegistry = startup.getPluginRegistry();
        // Adopt the validated provider instance into the real Gateway's cleanup owner.
        projectPluginContributions(registry.registry, record, liveRegistry);
        liveRegistry.plugins.push(record);
        adoptPluginRegistryRecords(liveRegistry);
        const context = startup.resolveGatewayContext();
        assert(context);
        const runtime = await runtimeFactory.mock.results.at(-1)!.value;
        const environments = runtime.workerEnvironmentService;
        const portals = context.portalService;
        assert(environments && portals);
        const store = startup.startup.store;
        const serviceOptions = serviceFactory.mock.calls.at(-1)?.[0];
        assert(serviceOptions, "Gateway must own the worker bundle producer");
        const artifact = await serviceOptions.prepareInstallation("bundle");
        const bootstrapReceipt: WorkerAdmissionHandshake = {
          bundleHash: artifact.bundleHash,
          openclawVersion: artifact.openclawVersion,
          protocolFeatures: [...artifact.protocolFeatures],
        };
        const sockets: WebSocket[] = [];
        const controllers = new Map<string, AbortController>();
        const running = new Set<Promise<void>>();
        const invocations: string[] = [];
        let releasePairing: (() => void) | undefined;
        let releasePersistence: (() => void) | undefined;
        const connect = async (label: string, email: string, node = false) => {
          signal.throwIfAborted();
          const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
            headers: {
              origin,
              "x-forwarded-for": "203.0.113.50",
              "x-forwarded-proto": "https",
              "x-forwarded-user": email,
            },
          });
          sockets.push(socket);
          trackConnectChallengeNonce(socket);
          let abortClose: Promise<void> | undefined;
          const abort = () => {
            abortClose = closeGatewayTestWebSocket(socket);
            void abortClose.catch(() => {});
          };
          signal.addEventListener("abort", abort, { once: true });
          try {
            await acquireGatewayTestWebSocket(socket, 30_000);
            signal.throwIfAborted();
            let deviceIdentityPath = path.join(process.env.OPENCLAW_STATE_DIR!, `${label}.sqlite`);
            if (node) {
              const paired = await pairDeviceIdentity({
                name: label,
                role: "node",
                scopes: [],
                clientId: NODE_CLIENT.id,
                clientMode: NODE_CLIENT.mode,
                platform: NODE_CLIENT.platform,
              });
              deviceIdentityPath = paired.identityPath;
              // Device identity approval and machine capability consent are separate grants.
              const pairing = await nodePairingWrites.requestNodePairing({
                nodeId: paired.identity.deviceId,
                platform: NODE_CLIENT.platform,
                caps: [],
                commands: [],
              });
              const approved = await nodePairingWrites.approveNodePairing(
                pairing.request.requestId,
                {
                  callerScopes: ["operator.pairing", "operator.write"],
                },
              );
              assert(approved && "node" in approved, "Node capability approval must succeed");
            }
            signal.throwIfAborted();
            const result = await connectReq(socket, {
              skipDefaultAuth: true,
              prePairDevice: true,
              scopes: node ? [] : ["operator.sessions.write"],
              role: node ? "node" : "operator",
              client: node ? NODE_CLIENT : CONTROL_UI_CLIENT,
              deviceIdentityPath,
              browserOrigin: node ? undefined : origin,
            });
            expect(result.ok, JSON.stringify(result.error)).toBe(true);
            return {
              socket,
              deviceId: loadOrCreateDeviceIdentity({ path: deviceIdentityPath }).deviceId,
            };
          } finally {
            signal.removeEventListener("abort", abort);
            await abortClose;
          }
        };
        try {
          const allowed = await connect("writer", "preview-writer@example.test");
          const denied = await connect("outsider", "preview-outsider@example.test");
          const node = await connect("node", "preview-node@example.test", true);
          node.socket.on("message", (data) => {
            const event = JSON.parse(rawDataToString(data)) as {
              event?: string;
              payload?: unknown;
            };
            if (event.event === "node.invoke.cancel") {
              const cancellation = coerceNodeInvokeCancelPayload(event.payload);
              if (cancellation) {
                controllers.get(cancellation.invokeId)?.abort();
              }
              return;
            }
            if (event.event !== "node.invoke.request") {
              return;
            }
            const frame = coerceNodeInvokePayload(event.payload);
            if (frame?.command === NODE_WORKER_WORKSPACE_RETAIN_COMMAND) {
              const maintenance = (async () => {
                await rpcReq(node.socket, "node.invoke.result", {
                  id: frame.id,
                  nodeId: frame.nodeId,
                  ok: true,
                  payloadJSON: JSON.stringify({ applied: true, deleted: 0, hasMore: false }),
                });
              })();
              running.add(maintenance);
              void maintenance.finally(() => running.delete(maintenance)).catch(() => {});
              return;
            }
            assert(frame && frame.command === NODE_WORKER_PORTAL_STREAM_COMMAND);
            invocations.push(frame.id);
            const controller = new AbortController();
            controllers.set(frame.id, controller);
            const invocation = (async () => {
              try {
                await invokeNodeWorkerPortalStream({
                  paramsJSON: frame.paramsJSON,
                  gatewayUrl: `ws://127.0.0.1:${port}`,
                  signal: controller.signal,
                });
                await rpcReq(node.socket, "node.invoke.result", {
                  id: frame.id,
                  nodeId: frame.nodeId,
                  ok: true,
                  payloadJSON: JSON.stringify({ status: "closed" }),
                });
              } finally {
                controllers.delete(frame.id);
              }
            })();
            running.add(invocation);
            void invocation.finally(() => running.delete(invocation)).catch(() => {});
          });
          // Hello precedes pairing bookkeeping; this manual RPC does not use the node host's retry owner.
          await withinTest(nodeConnectionRecorded.promise, signal);
          const inventory = await rpcReq(node.socket, "node.runnerInventory.update", {
            protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
            workerHost: {
              enabled: true,
              capacity: { total: 1, available: 1 },
              environmentSession: 1,
              portalStream: NODE_WORKER_PORTAL_STREAM_VERSION,
            },
          });
          expect(inventory.ok, JSON.stringify(inventory.error)).toBe(true);

          const environmentId = "preview-machine";
          await store.createSessionAttachmentIntent(
            {
              ...identity,
              environmentId,
              providerId: "preview-proof",
              profileId: "preview",
              profileSnapshot: { settings: {} },
              provisionOperationId: "preview-provision",
            },
            () => {},
          );
          await store.transition({ environmentId, from: "requested", to: "provisioning" });
          await store.transition({
            environmentId,
            from: "provisioning",
            to: "ready",
            patch: {
              leaseId: "preview-lease",
              nodeDeviceId: node.deviceId,
              sshEndpoint: null,
              sharedHost: false,
              bootstrapReceipt,
              credential: {
                credentialHash: hashWorkerCredential("preview-wire-credential"),
                sessionId: null,
                rpcSetVersion: 1,
                expiresAtMs: Date.now() + 60_000,
              },
            },
          });
          await environments.reconcileOnce(environmentId);
          signal.throwIfAborted();
          const params = { sessionKey: identity.sessionKey, environmentId, port: destinationPort };
          expect((await rpcReq(denied.socket, "portal.session.open", params)).ok).toBe(false);
          expect(portals.list()).toEqual([]);
          expect(invocations).toEqual([]);
          expect(connections).toBe(0);

          for (const rejectPersistence of [false, true]) {
            signal.throwIfAborted();
            sharedHost = false;
            await environments.reconcileOnce(environmentId);
            const qualification = environments.getDedicatedNodeLeaseSignal(environmentId);
            const reconciled = store.get(environmentId);
            assert(
              qualification,
              JSON.stringify({
                state: reconciled?.state,
                lastError: reconciled?.lastError,
                sharedHost: reconciled?.sharedHost,
                ownerEpoch: reconciled?.ownerEpoch,
              }),
            );
            const opened = await rpcReq<{ url: string }>(
              allowed.socket,
              "portal.session.open",
              params,
            );
            expect(opened.ok, JSON.stringify(opened.error)).toBe(true);
            assert(opened.payload?.url);
            const url = new URL(opened.payload.url);
            const response = await fetch(url, { signal });
            expect(response.status).toBe(200);
            expect(await response.text()).toBe("preview-ok");
            url.pathname = "/stream";
            const committed = createDeferred();
            const publish = createDeferred();
            const targetConnected = createDeferred();
            const onTargetConnection = () => targetConnected.resolve();
            const runOperation = stateWorkerStore.runOpenClawStateWorkerOperation;
            const activity = vi
              .spyOn(stateWorkerStore, "runOpenClawStateWorkerOperation")
              .mockImplementation((workerContext, operation, options) =>
                runOperation(
                  workerContext,
                  (scope) =>
                    operation({
                      execute: async (command, executeOptions) => {
                        const result = await scope.execute(command, executeOptions);
                        if (command.type === "workerEnvironments.reconcileSharedHost") {
                          committed.resolve();
                          await publish.promise;
                        }
                        return result;
                      },
                    }),
                  options,
                ),
              );
            const maintenance = store.reconcileSharedHost({
              environmentId,
              state: reconciled!.state,
              leaseId: "preview-lease",
              sharedHost: false,
            });
            let streaming: Response;
            try {
              await withinTest(
                awaitGateBeforeSettlement(
                  committed.promise,
                  maintenance,
                  "Metadata maintenance settled before its commit was observed",
                ),
                signal,
              );
              destination.once("connection", onTargetConnection);
              const requested = fetch(url, { signal });
              await withinTest(Promise.race([targetConnected.promise, requested]), signal);
              publish.resolve();
              await maintenance;
              streaming = await requested;
            } finally {
              publish.resolve();
              await maintenance;
              destination.off("connection", onTargetConnection);
              activity.mockRestore();
            }
            const reader = streaming.body!.getReader();
            expect(new TextDecoder().decode((await reader.read()).value)).toBe("preview-stream");
            const activePeersClosed = Promise.all(
              [...peers].map((socket) => once(socket, "close")),
            );
            const priorConnections = connections;
            const priorInvocations = invocations.length;

            const pairingEntered = createDeferred();
            const pairingResume = createDeferred();
            releasePairing = () => pairingResume.resolve();
            pairingGate = async () => {
              pairingEntered.resolve();
              await pairingResume.promise;
            };
            url.pathname = "/blocked";
            const pending = fetch(url, { signal }).then(
              (result) => result.status,
              () => 0,
            );
            await withinTest(
              awaitGateBeforeSettlement(
                pairingEntered.promise,
                pending,
                "Preview settled before node discovery",
              ),
              signal,
            );
            const persistenceEntered = createDeferred();
            const persistenceResume = createDeferred();
            releasePersistence = () => persistenceResume.resolve();
            const reconcileSharedHost = store.reconcileSharedHost.bind(store);
            const persistence = vi
              .spyOn(store, "reconcileSharedHost")
              .mockImplementation(async (...args) => {
                persistenceEntered.resolve();
                await persistenceResume.promise;
                if (rejectPersistence) {
                  throw new Error("deliberately rejected provider metadata persistence");
                }
                return await reconcileSharedHost(...args);
              });
            sharedHost = undefined;
            const reconcile = environments.reconcileOnce(environmentId);
            await withinTest(
              awaitGateBeforeSettlement(
                persistenceEntered.promise,
                reconcile,
                "Inspection settled before persistence",
              ),
              signal,
            );
            expect(qualification.aborted).toBe(true);
            expect(portals.list()).toEqual([]);
            pairingGate = undefined;
            pairingResume.resolve();
            expect(await pending).not.toBe(200);
            await withinTest(activePeersClosed, signal);
            await reader.cancel().catch(() => {});
            expect(connections).toBe(priorConnections);
            expect(invocations).toHaveLength(priorInvocations);
            expect(requests).not.toContain("/blocked");
            persistenceResume.resolve();
            await reconcile;
            persistence.mockRestore();
            expect(environments.getDedicatedNodeLeaseSignal(environmentId)).toBeUndefined();
          }
        } finally {
          pairingGate = undefined;
          releasePairing?.();
          releasePersistence?.();
          const closing = portals.closeAll();
          for (const controller of controllers.values()) {
            controller.abort();
          }
          await runQaGatewayFixture(
            () => closing,
            () => Promise.allSettled(running),
            () => Promise.all(sockets.map(closeGatewayTestWebSocket)),
          );
        }
      }),
    );
  } finally {
    vi.restoreAllMocks();
    destination.closeAllConnections();
    await new Promise<void>((resolve) => {
      destination.close(() => resolve());
    });
  }
}
