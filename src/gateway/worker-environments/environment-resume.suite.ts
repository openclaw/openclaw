import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { createWorkerNodeEnrollmentManager } from "./node-enrollment.js";
import * as support from "./service.test-support.js";
import { createWorkerBootstrapArtifactTransferService } from "./worker-bootstrap-artifact-transfer-service.js";
import { measureLaunchTurn, readLaunchToolNames } from "./worker-turn-launcher.test-support.js";

export function registerEnvironmentResumeTests() {
  describe("admitted exact-lease node resumption", () => {
    support.setupWorkerEnvironmentServiceSuite();

    it.each(["connected", "dormant", "unknown", "unpaired", "revoked", "cancelled"] as const)(
      "preserves the session and fences %s before a usable tunnel",
      async (state) => {
        const environmentId = "worker-resume";
        const store = support.testState.store;
        const intent = await store.createIntent({
          environmentId,
          providerId: "fake",
          profileId: "development",
          profileSnapshot: { settings: { region: "test" }, executionMode: "remote-exec" },
          provisionOperationId: `provision:${environmentId}`,
        });
        await store.transition({ environmentId, from: intent.state, to: "provisioning" });
        await store.ensureNodeEnrollment(environmentId);
        await store.transition({
          environmentId,
          from: "provisioning",
          to: "ready",
          patch: {
            ...support.readyPatch(environmentId, {
              ...support.BOOTSTRAP_RECEIPT,
              installKind: "bundle",
            }),
            leaseId: "original-lease",
            nodeDeviceId: "original-device",
            sharedHost: false,
          },
        });
        const attached = await store.transition({
          environmentId,
          from: "ready",
          to: "attached",
          patch: support.attachedPatch(environmentId, "original-session"),
        });
        let connected = state === "connected";
        let authorized = true;
        const controller = new AbortController();
        const preparing = createDeferred();
        const prepared = createDeferred();
        const artifactPath = path.join(support.testState.root, "node.tgz");
        await fs.writeFile(artifactPath, "x");
        const enrollmentManager = createWorkerNodeEnrollmentManager({
          store,
          getConfig: () => ({
            gateway: {
              publicOrigin: "https://gateway.example.test",
              auth: { mode: "token", token: "synthetic-token" },
            },
          }),
          transfer: createWorkerBootstrapArtifactTransferService(),
          resolveAvailability: async () =>
            state === "unpaired"
              ? { available: false, unavailableReason: "unpaired" }
              : connected
                ? { available: true }
                : { available: false, unavailableReason: "disconnected" },
          prepareArtifact: async () => {
            if (state === "revoked" || state === "cancelled") {
              preparing.resolve();
              await prepared.promise;
            }
            return {
              tarballPath: artifactPath,
              tarballSha256: support.NODE_BOOTSTRAP.sha256,
              tarballBytes: 1,
              openclawVersion: "2026.8.1",
              buildId: "qualified",
              enabledPluginIds: [],
            };
          },
        });
        const wake = vi.fn();
        const resume = vi.fn<NonNullable<WorkerProvider["resume"]>>(async (lease, authority) => {
          authority.assertCurrent();
          expect(lease.leaseId).toBe("original-lease");
          if (!authority.beginNodeEnrollment) {
            throw new Error("Missing enrollment owner");
          }
          const enrollment = await authority.beginNodeEnrollment();
          expect(enrollment).toMatchObject({ mode: "resume", deviceId: "original-device" });
          wake();
          connected = true;
          expect(await enrollment.waitForDeviceId()).toBe("original-device");
          authority.assertCurrent();
          return "resumed";
        });
        const provision = vi.fn();
        const ensureNodeWorkerBundle = vi.fn(async () => support.BOOTSTRAP_RECEIPT);
        const nodeTunnelManager = {
          isNodeConnected: async () => connected,
          status: () => "stopped" as const,
          observeProcesses: vi.fn(),
          start: vi.fn(async () => ({
            environmentId,
            ownerEpoch: attached.ownerEpoch,
            measureLaunchTurn,
            readLaunchToolNames,
            launchTurn: vi.fn(),
            runWorkspaceCommand: vi.fn(),
            quiesceWorkspace: vi.fn(),
            syncWorkspace: vi.fn(),
            reconcileWorkspace: vi.fn(),
            stop: async () => {},
          })),
          stop: vi.fn(async () => {}),
          stopAll: vi.fn(async () => {}),
        };
        const service = support.createService(
          support.createProvider({
            requiresNodeEnrollment: true,
            provision,
            resume,
            inspect: async () => ({
              status: state === "unknown" ? "unknown" : connected ? "active" : "dormant",
            }),
          }),
          {
            nodeTunnelManager,
            ensureNodeWorkerBundle,
            prepareNodeEnrollment: (record, signal) => enrollmentManager.begin(record, signal),
            closeNodeEnrollment: (enrollment) => enrollmentManager.close(enrollment),
          },
        );
        const request = {
          environmentId,
          ownerEpoch: attached.ownerEpoch,
          signal: controller.signal,
          authorize: () => {
            if (!authorized) {
              throw new Error("caller revoked");
            }
          },
        };
        try {
          const starting = service.startTunnel(request);
          if (state === "revoked" || state === "cancelled") {
            const rejected = expect(starting).rejects.toThrow();
            await preparing.promise;
            if (state === "revoked") {
              authorized = false;
            } else {
              controller.abort();
            }
            prepared.resolve();
            await rejected;
          } else if (state === "connected" || state === "dormant") {
            await starting;
            await service.startTunnel(request);
            expect(nodeTunnelManager.start).toHaveBeenCalledTimes(2);
            expect(resume).toHaveBeenCalledTimes(state === "dormant" ? 1 : 0);
            expect(ensureNodeWorkerBundle).toHaveBeenCalledTimes(state === "dormant" ? 1 : 0);
          } else {
            await expect(starting).rejects.toThrow();
          }
          if (state !== "connected" && state !== "dormant") {
            expect(wake).not.toHaveBeenCalled();
            expect(ensureNodeWorkerBundle).not.toHaveBeenCalled();
            expect(nodeTunnelManager.start).not.toHaveBeenCalled();
          }
          expect(provision).not.toHaveBeenCalled();
          expect(store.get(environmentId)).toMatchObject({
            state: "attached",
            leaseId: "original-lease",
            ownerEpoch: attached.ownerEpoch,
            attachedSessionIds: ["original-session"],
          });
        } finally {
          prepared.resolve();
          enrollmentManager.stop();
        }
      },
    );
  });
}
