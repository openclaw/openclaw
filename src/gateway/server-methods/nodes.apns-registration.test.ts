import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  deriveDeviceIdFromPublicKey,
  publicKeyRawBase64UrlFromPem,
} from "../../infra/device-identity.js";
import { resolveNodePairingState } from "../../infra/device-pairing-identity.js";
import {
  captureNodePairingGeneration,
  isPairedDeviceNodeBindingCurrent,
  resolveCurrentPairedDeviceNodeBinding,
} from "../../infra/device-pairing-node-state.js";
import { persistDevicePairingStoreState } from "../../infra/device-pairing-store.js";
import { getPairedDevice, type PairedDevice } from "../../infra/device-pairing.js";
import { loadApnsRegistration, registerApnsRegistration } from "../../infra/push-apns-store.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { NodeRegistry } from "../node-registry.js";
import { makeClient, registerNodeSession } from "../node-registry.test-helpers.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { nodeEventHandlers } from "./nodes.event.js";

const tempDirs = createTrackedTempDirs();
const registries = new Set<NodeRegistry>();
let baseDir: string;
beforeEach(async () => {
  baseDir = await tempDirs.make("apns-node-authority-");
  vi.stubEnv("OPENCLAW_STATE_DIR", baseDir);
});
afterEach(async () => {
  for (const registry of registries) {
    for (const node of registry.listConnected()) {
      registry.unregister(node.connId);
    }
  }
  registries.clear();
  await closeStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await tempDirs.cleanup();
});

it.each(["transaction", "commit"] as const)(
  "checks the real node route before APNs worker %s admission",
  async (stage) => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const rawPublicKey = publicKeyRawBase64UrlFromPem(
      publicKey.export({ format: "pem", type: "spki" }),
    );
    const nodeId = deriveDeviceIdFromPublicKey(rawPublicKey);
    if (!nodeId) {
      throw new Error("Fixture has no device identity");
    }
    const device: PairedDevice = {
      deviceId: nodeId,
      publicKey: rawPublicKey,
      role: "node",
      roles: ["node"],
      tokens: {
        node: { token: "synthetic-node-grant", role: "node", scopes: [], createdAtMs: 100 },
      },
      nodeSurface: { createdAtMs: 200, approvedAtMs: 300 },
      createdAtMs: 50,
      approvedAtMs: 300,
    };
    persistDevicePairingStoreState(
      { pendingById: {}, pairedByDeviceId: { [nodeId]: device } },
      baseDir,
      "paired",
    );
    const pairing = resolveNodePairingState(await getPairedDevice(nodeId, baseDir));
    if (!pairing?.generation) {
      throw new Error("Fixture has no authenticated node pairing state");
    }
    const generation = pairing.generation;
    await expect(captureNodePairingGeneration(nodeId)).resolves.toEqual(generation);
    await registerApnsRegistration({
      nodeId,
      token: "ab".repeat(32),
      topic: "ai.openclaw.tests",
      environment: "sandbox",
    });
    const peer = await registerApnsRegistration({
      nodeId: "peer",
      token: "cd".repeat(32),
      topic: "ai.openclaw.tests",
      environment: "sandbox",
    });
    for (const state of ["current", "replacement", "invalidated"] as const) {
      const previous = await loadApnsRegistration(nodeId);
      if (!previous) {
        throw new Error("Fixture registration is missing");
      }
      const registry = new NodeRegistry({
        resolveCurrentPairingState: resolveCurrentPairedDeviceNodeBinding,
        isPairingStateCurrent: isPairedDeviceNodeBindingCurrent,
      });
      registries.add(registry);
      const makeBoundClient = () => {
        const connection = makeClient("node-connection", nodeId);
        if (!connection.connect?.device) {
          throw new Error("Fixture client has no device");
        }
        connection.connect.device.publicKey = rawPublicKey;
        return connection;
      };
      const client = makeBoundClient();
      registerNodeSession(registry, client, {
        pairingIdentity: pairing.identity.key,
        pairingGeneration: generation.key,
      });
      const context = createGatewayRequestContext(makeContextParams({ nodeRegistry: registry }));
      const respond = vi.fn();
      const params = {
        event: "push.apns.register",
        payload: {
          token: (state === "current" ? "de" : "ef").repeat(32),
          topic: "ai.openclaw.tests",
          environment: "sandbox",
        },
      };
      let reached = false;
      const admission = probe.admission(workerAdmission, (request, grant, admit) => {
        if (request.stage === stage) {
          reached = true;
          if (state === "replacement") {
            // A reused connection ID does not give the replacement the original session's authority.
            registerNodeSession(registry, makeBoundClient(), {
              pairingIdentity: pairing.identity.key,
              pairingGeneration: generation.key,
            });
          } else if (state === "invalidated") {
            registry.invalidateConnectionForPairingChange("node-connection");
          }
        }
        admit(request, grant);
      });
      try {
        await nodeEventHandlers["node.event"]!({
          req: { type: "req", id: "registration", method: "node.event", params },
          params,
          client,
          respond,
          isWebchatConnect: () => false,
          context,
        });
        expect(reached, JSON.stringify(respond.mock.calls)).toBe(true);
        expect(respond.mock.calls[0]?.[0]).toBe(state === "current");
        if (state === "current") {
          expect(respond.mock.calls[0]?.[1]).toEqual({
            ok: true,
            event: "push.apns.register",
            handled: true,
            reason: "registered",
          });
          await expect(loadApnsRegistration(nodeId)).resolves.toMatchObject({
            token: "de".repeat(32),
          });
        } else {
          await expect(loadApnsRegistration(nodeId)).resolves.toEqual(previous);
        }
        await expect(loadApnsRegistration("peer")).resolves.toEqual(peer);
      } finally {
        admission.mockRestore();
        for (const node of registry.listConnected()) {
          registry.unregister(node.connId);
        }
      }
    }
  },
);
