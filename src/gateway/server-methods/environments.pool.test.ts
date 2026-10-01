import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { listDevicePairing } from "../../infra/device-pairing.js";
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
  mockContext,
  pairedNodeDevice,
  workerRecord,
  workerService,
} from "./environments.test-support.js";

vi.mock("../../infra/device-pairing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/device-pairing.js")>()),
  listDevicePairing: vi.fn(),
}));

vi.mock("../node-registry-private.js", () => ({
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
  vi.mocked(listDevicePairing).mockResolvedValue({
    pending: [],
    paired: [
      pairedNodeDevice("node-live", { commands: ["system.run"] }),
      pairedNodeDevice("node-offline", {
        displayName: "Offline Node",
        caps: ["screen"],
        commands: ["camera.snap"],
      }),
    ],
  });
});

afterEach(() => vi.restoreAllMocks());

const preparationRequests = [
  { scope: "operator.read", requested: true, includeDetails: false },
  { scope: "operator.write", requested: true, includeDetails: false },
  { scope: "operator.admin", requested: undefined, includeDetails: false },
  { scope: "operator.admin", requested: false, includeDetails: false },
  { scope: "operator.admin", requested: true, includeDetails: true },
];

describe("prepared worker pool projection", () => {
  it.each(preparationRequests)(
    "projects worker metadata for $scope with details requested=$requested",
    async ({ scope, requested, includeDetails }) => {
      const project = {
        label: "example/prepared",
        baseCommit: "a".repeat(40),
        root: "/private/workspace",
      };
      const preparation = {
        purpose: "reserve" as const,
        key: "prepared-project-key",
        demandAtMs: 1_000,
        expiresAtMs: 60_000,
        consumedAtMs: 5_000,
        project,
      };
      const service = workerService({
        readPreparedPoolSummary: vi.fn(() => ({
          maxTotal: 4,
          reservedEnvironmentIds: ["worker-1"],
        })),
        readReadyWorkerTarget: vi.fn((profileId) => (profileId === "aws" ? 2 : 0)),
        list: vi.fn(() => [
          workerRecord({
            state: "idle",
            attachedSessionIds: ["session-z", "session-a", "session-z", " "],
            idleSinceAtMs: 6_000,
            destroyRequestedAtMs: 9_000,
            preparation,
          }),
        ]),
      });
      const [ok, payload] = await callEnvironmentMethod(
        "environments.list",
        requested === undefined ? {} : { includePreparedDetails: requested },
        {
          service,
          scopes: [scope],
        },
      );

      expect(ok).toBe(true);
      expect(payload).toMatchObject({
        profiles: [
          { id: "aws", providerId: "crabbox" },
          { id: "zeta", providerId: "static-ssh" },
        ],
        environments: [
          { id: "gateway", type: "local" },
          { id: "node:node-live", type: "node" },
          { id: "node:node-offline", type: "node" },
          {
            id: "worker-1",
            type: "worker",
            status: "available",
            trust: "disposable",
            worker: {
              providerId: "static-ssh",
              leaseId: "lease-1",
              state: "idle",
              ageMs: 9_000,
              idleMs: 4_000,
              attachedSessionIds: ["session-a", "session-z"],
              tunnelStatus: "stopped",
            },
          },
        ],
      });
      const worker = (payload as { environments: Array<Record<string, unknown>> }).environments.at(
        -1,
      );
      expect(worker).not.toHaveProperty("sshEndpoint");
      expect(worker?.worker).not.toHaveProperty("sshEndpoint");
      expect(worker?.worker).not.toHaveProperty("keyRef");
      expect(worker?.preparation).toEqual({
        purpose: "reserve",
        key: preparation.key,
        ...(includeDetails
          ? {
              details: {
                demandAtMs: 1_000,
                expiresAtMs: 60_000,
                consumedAtMs: 5_000,
                project: { label: project.label, baseCommit: project.baseCommit },
              },
            }
          : {}),
      });
      if (includeDetails) {
        expect(worker?.worker).toHaveProperty("destroyRequestedAtMs", 9_000);
        expect(payload.preparedPool).toEqual({ maxTotal: 4, reservedEnvironmentIds: ["worker-1"] });
        expect(payload.profiles).toEqual([
          { id: "aws", providerId: "crabbox", readyWorkers: 2 },
          { id: "zeta", providerId: "static-ssh", readyWorkers: 0 },
        ]);
        expect(service.readPreparedPoolSummary).toHaveBeenCalledOnce();
      } else {
        expect(worker?.worker).not.toHaveProperty("destroyRequestedAtMs");
        expect(payload).not.toHaveProperty("preparedPool");
        expect(payload.profiles).toEqual([
          { id: "aws", providerId: "crabbox" },
          { id: "zeta", providerId: "static-ssh" },
        ]);
        expect(service.readPreparedPoolSummary).not.toHaveBeenCalled();
        expect(service.readReadyWorkerTarget).not.toHaveBeenCalled();
      }
      expect(service.list).toHaveBeenCalledOnce();
      for (const profile of (payload as { profiles: Array<Record<string, unknown>> }).profiles) {
        expect(profile).not.toHaveProperty("executionMode");
        expect(profile).not.toHaveProperty("executionModes");
      }
    },
  );

  it.each(preparationRequests)(
    "returns worker status for $scope with details requested=$requested",
    async ({ scope, requested, includeDetails }) => {
      const get = vi.fn(() =>
        workerRecord({
          state: "attached",
          preparation: {
            purpose: "build",
            key: "build-key",
            demandAtMs: 1_000,
            expiresAtMs: 60_000,
            consumedAtMs: null,
          },
        }),
      );
      const service = workerService({ get });
      const [ok, payload] = await callEnvironmentMethod(
        "environments.status",
        {
          environmentId: "worker-1",
          ...(requested === undefined ? {} : { includePreparedDetails: requested }),
        },
        { service, scopes: [scope] },
      );

      expect(ok).toBe(true);
      expect(payload).toMatchObject({
        id: "worker-1",
        status: "available",
        trust: "disposable",
        worker: { state: "attached", ageMs: 9_000 },
      });
      expect(get).toHaveBeenCalledWith("worker-1");
      expect(payload.preparation).toEqual({
        purpose: "build",
        key: "build-key",
        ...(includeDetails
          ? {
              details: { demandAtMs: 1_000, expiresAtMs: 60_000, consumedAtMs: null },
            }
          : {}),
      });
      expect(payload.worker).not.toHaveProperty("destroyRequestedAtMs");
    },
  );

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
        vi.mocked(listDevicePairing).mockImplementation(async () => {
          await waitForDiscovery();
          return { pending: [], paired: [] };
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
