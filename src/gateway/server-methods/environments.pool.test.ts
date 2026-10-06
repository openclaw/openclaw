import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentSummary } from "../../../packages/gateway-protocol/src/schema/environments.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { readDevicePairingNodeSnapshot } from "../../infra/device-pairing-store-readonly.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { collectNodeCatalogRuntimeState } from "../node-registry-private.js";
import { handleGatewayRequest } from "../server-methods.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import { environmentsHandlers } from "./environments.js";
import {
  callEnvironmentMethod,
  createDevicePairingNodeSnapshot,
  mockContext,
  pairedNodeDevice,
  workerRecord,
  workerService,
} from "./environments.test-support.js";

vi.mock("../../infra/device-pairing-store-readonly.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/device-pairing-store-readonly.js")>()),
  readDevicePairingNodeSnapshot: vi.fn(),
}));

vi.mock("../node-registry-private.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../node-registry-private.js")>()),
  collectNodeCatalogRuntimeState: vi.fn(),
}));

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(10_000);
  vi.mocked(collectNodeCatalogRuntimeState).mockReturnValue({
    sessionHostNodeIds: new Set(),
    issuesByNodeId: new Map(),
    workerSlotsByNodeId: new Map(),
    workerBundleByNodeId: new Map(),
  });
  vi.mocked(readDevicePairingNodeSnapshot).mockResolvedValue(
    createDevicePairingNodeSnapshot([
      pairedNodeDevice("node-live", { commands: ["system.run"] }),
      pairedNodeDevice("node-offline", {
        displayName: "Offline Node",
        caps: ["screen"],
        commands: ["camera.snap"],
      }),
    ]),
  );
});

afterEach(() => vi.restoreAllMocks());

const preparationRequests = [
  { scope: "operator.write", requested: true, includeDetails: false },
  { scope: "operator.admin", requested: undefined, includeDetails: false },
  { scope: "operator.admin", requested: true, includeDetails: true },
];

describe("prepared worker pool projection", () => {
  for (const method of ["environments.list", "environments.status"] as const) {
    it.each(preparationRequests)(
      `${method} projects worker metadata for $scope with details requested=$requested`,
      async ({ scope, requested, includeDetails }) => {
        const listing = method === "environments.list";
        const project = {
          label: "example/prepared",
          baseCommit: "a".repeat(40),
          root: "/private/workspace",
        };
        const record = workerRecord({
          state: listing ? "idle" : "attached",
          ...(listing
            ? {
                attachedSessionIds: ["session-z", "session-a", "session-z", " "],
                idleSinceAtMs: 6_000,
                destroyRequestedAtMs: 9_000,
              }
            : {}),
          preparation: {
            purpose: listing ? "reserve" : "build",
            key: listing ? "prepared-project-key" : "build-key",
            demandAtMs: 1_000,
            expiresAtMs: 60_000,
            consumedAtMs: listing ? 5_000 : null,
            ...(listing ? { project } : {}),
          },
        });
        const service = workerService({
          list: vi.fn(() => (listing ? [record] : [])),
          get: vi.fn(() => record),
          readPreparedPoolSummary: vi.fn(() => ({
            maxTotal: 4,
            reservedEnvironmentIds: ["worker-1"],
          })),
          readReadyWorkerTarget: vi.fn((profileId) => (profileId === "aws" ? 2 : 0)),
        });
        const [ok, payload] = await callEnvironmentMethod(
          method,
          {
            ...(listing ? {} : { environmentId: "worker-1" }),
            ...(requested === undefined ? {} : { includePreparedDetails: requested }),
          },
          { service, scopes: [scope] },
        );

        expect(ok).toBe(true);
        const summary: EnvironmentSummary = listing ? payload.environments.at(-1) : payload;
        expect(summary).toMatchObject({
          id: "worker-1",
          type: "worker",
          status: "available",
          trust: "disposable",
          worker: {
            providerId: "static-ssh",
            leaseId: "lease-1",
            state: listing ? "idle" : "attached",
            ageMs: 9_000,
            ...(listing ? { idleMs: 4_000, attachedSessionIds: ["session-a", "session-z"] } : {}),
            tunnelStatus: "stopped",
          },
        });
        expect(summary).not.toHaveProperty("sshEndpoint");
        expect(summary.worker).not.toHaveProperty("sshEndpoint");
        expect(summary.worker).not.toHaveProperty("keyRef");
        expect(summary.preparation).toEqual({
          purpose: listing ? "reserve" : "build",
          key: listing ? "prepared-project-key" : "build-key",
          ...(includeDetails
            ? {
                details: {
                  demandAtMs: 1_000,
                  expiresAtMs: 60_000,
                  consumedAtMs: listing ? 5_000 : null,
                  ...(listing
                    ? { project: { label: project.label, baseCommit: project.baseCommit } }
                    : {}),
                },
              }
            : {}),
        });
        if (listing && includeDetails) {
          expect(summary.worker).toHaveProperty("destroyRequestedAtMs", 9_000);
        } else {
          expect(summary.worker).not.toHaveProperty("destroyRequestedAtMs");
        }
        if (listing) {
          expect(payload.environments).toMatchObject([
            { id: "gateway", type: "local" },
            { id: "node:node-live", type: "node" },
            { id: "node:node-offline", type: "node" },
            { id: "worker-1", type: "worker" },
          ]);
          expect(payload.profiles).toEqual([
            { id: "aws", providerId: "crabbox", ...(includeDetails ? { readyWorkers: 2 } : {}) },
            {
              id: "zeta",
              providerId: "static-ssh",
              ...(includeDetails ? { readyWorkers: 0 } : {}),
            },
          ]);
          if (includeDetails) {
            expect(payload.preparedPool).toEqual({
              maxTotal: 4,
              reservedEnvironmentIds: ["worker-1"],
            });
          } else {
            expect(payload).not.toHaveProperty("preparedPool");
            expect(service.readReadyWorkerTarget).not.toHaveBeenCalled();
          }
          expect(service.readPreparedPoolSummary).toHaveBeenCalledTimes(includeDetails ? 1 : 0);
          expect(service.list).toHaveBeenCalledOnce();
        } else {
          expect(service.get).toHaveBeenCalledWith("worker-1");
        }
      },
    );
  }

  it.each(["environments.list", "environments.status"] as const)(
    "withholds %s after administrator scopes change during discovery",
    async (method) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const worker = workerRecord({
        preparation: {
          purpose: "reserve",
          key: "prepared-project-key",
          demandAtMs: 1_000,
          expiresAtMs: 60_000,
          consumedAtMs: null,
          project: { label: "private-project", baseCommit: "a".repeat(40) },
        },
      });
      const service = workerService({ list: vi.fn(() => [worker]), get: vi.fn(() => worker) });
      const waitForDiscovery = async () => {
        entered.resolve();
        await release.promise;
      };
      if (method === "environments.list") {
        vi.mocked(service.listMachineOptions).mockImplementation(async () => {
          await waitForDiscovery();
          return undefined;
        });
      } else {
        vi.mocked(readDevicePairingNodeSnapshot).mockImplementation(async () => {
          await waitForDiscovery();
          return createDevicePairingNodeSnapshot([]);
        });
      }
      const client = createOperatorClient({
        profileId: GATEWAY_OWNER_PROFILE_ID,
        scopes: ["operator.admin"],
      });
      const respond = vi.fn();
      const pending = handleGatewayRequest({
        req: {
          type: "req",
          id: `prepared-details-${method}`,
          method,
          params: {
            includePreparedDetails: true,
            ...(method === "environments.status" ? { environmentId: worker.environmentId } : {}),
          },
        },
        client,
        context: Object.assign(createContext(), mockContext(service)),
        respond,
        isWebchatConnect: () => false,
        extraHandlers: environmentsHandlers,
      });
      try {
        await Promise.race([entered.promise, pending]);
        expect(respond).not.toHaveBeenCalled();
        client.connect.scopes = ["operator.read"];
      } finally {
        release.resolve();
      }
      await pending;
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({
          code: "FORBIDDEN",
          message: "Gateway requester authority changed",
        }),
      );
    },
  );
});
