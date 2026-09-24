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
import { expect, it, vi } from "vitest";
import type { WorkerAdmissionHandshake } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
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
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withEnvAsync } from "../test-utils/env.js";
import { pairDeviceIdentity } from "./device-authz.test-helpers.js";
import * as workerStartup from "./server-worker-environment-startup.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  NODE_CLIENT,
  openWs,
  rpcReq,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";
import { hashWorkerCredential } from "./worker-environments/credential.js";
import * as workerService from "./worker-environments/service.js";

installGatewayTestHooks({ scope: "suite" });

it("carries authenticated session previews through the node and retires access before persistence", async () => {
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
        let bootstrapReceipt: WorkerAdmissionHandshake;
        try {
          const artifact = await serviceOptions.prepareInstallation("bundle");
          bootstrapReceipt = {
            bundleHash: artifact.bundleHash,
            openclawVersion: artifact.openclawVersion,
            protocolFeatures: [...artifact.protocolFeatures],
          };
          console.info("Portal transport proof: current Gateway worker build receipt");
        } catch (error) {
          assert(error instanceof Error);
          expect(error.message).toMatch(/^OpenClaw worker deploy artifact is missing;/);
          expect(error.cause).toMatchObject({ code: "ENOENT" });
          // Source-only Gateways preserve admitted leases when no replacement build exists.
          bootstrapReceipt = {
            bundleHash: "a".repeat(64),
            openclawVersion: "2026.9.1",
            protocolFeatures: [],
          };
          console.info("Portal transport proof: historical receipt; worker build absent (ENOENT)");
        }
        const sockets: Awaited<ReturnType<typeof openWs>>[] = [];
        const controllers = new Map<string, AbortController>();
        const running = new Set<Promise<void>>();
        const invocations: string[] = [];
        let releasePairing: (() => void) | undefined;
        let releasePersistence: (() => void) | undefined;
        const connect = async (label: string, email: string, node = false) => {
          const socket = await openWs(port, {
            origin,
            "x-forwarded-for": "203.0.113.50",
            "x-forwarded-proto": "https",
            "x-forwarded-user": email,
          });
          sockets.push(socket);
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
            const approved = await nodePairingWrites.approveNodePairing(pairing.request.requestId, {
              callerScopes: ["operator.pairing", "operator.write"],
            });
            assert(approved && "node" in approved, "Node capability approval must succeed");
          }
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
          await nodeConnectionRecorded.promise;
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
          const params = { sessionKey: identity.sessionKey, environmentId, port: destinationPort };
          expect((await rpcReq(denied.socket, "portal.session.open", params)).ok).toBe(false);
          expect(portals.list()).toEqual([]);
          expect(invocations).toEqual([]);
          expect(connections).toBe(0);

          for (const rejectPersistence of [false, true]) {
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
            const response = await fetch(url);
            expect(response.status).toBe(200);
            expect(await response.text()).toBe("preview-ok");
            url.pathname = "/stream";
            const streaming = await fetch(url);
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
            const pending = fetch(url).then(
              (result) => result.status,
              () => 0,
            );
            await withTestTimeout(
              pairingEntered.promise,
              5_000,
              "Preview did not reach node discovery",
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
            await withTestTimeout(
              persistenceEntered.promise,
              5_000,
              "Inspection did not reach persistence",
            );
            expect(qualification.aborted).toBe(true);
            expect(portals.list()).toEqual([]);
            pairingGate = undefined;
            pairingResume.resolve();
            expect(await pending).not.toBe(200);
            await withTestTimeout(
              activePeersClosed,
              5_000,
              "Revocation left a destination socket open",
            );
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
          await portals.closeAll();
          for (const controller of controllers.values()) {
            controller.abort();
          }
          await Promise.allSettled(running);
          for (const socket of sockets) {
            socket.terminate();
          }
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
}, 30_000);
