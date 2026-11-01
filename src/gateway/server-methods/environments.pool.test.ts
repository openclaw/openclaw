import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EnvironmentSummary } from "../../../packages/gateway-protocol/src/schema/environments.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { readDevicePairingNodeSnapshot } from "../../infra/device-pairing-store-readonly.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { collectNodeCatalogRuntimeState } from "../node-registry-private.js";
import { gatewayRequest } from "../request-frame.test-support.js";
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
  nodeCatalogState,
  pairedInventory,
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
  vi.mocked(collectNodeCatalogRuntimeState).mockReturnValue(nodeCatalogState());
  vi.mocked(readDevicePairingNodeSnapshot).mockResolvedValue(pairedInventory());
});

afterEach(() => vi.restoreAllMocks());

const pool = { maxTotal: 4, reservedEnvironmentIds: ["worker-1"] };
const project = { label: "example/prepared", baseCommit: "a".repeat(40) };
const privateProject = { ...project, root: "/private/workspace" };
const times = { demandAtMs: 1_000, expiresAtMs: 60_000 };

for (const method of ["environments.list", "environments.status"] as const) {
  it.each(["operator.write", "operator.admin"])(
    `${method} projects worker metadata for %s with details requested`,
    async (scope) => {
      const includeDetails = scope === "operator.admin";
      const listing = method === "environments.list";
      const preparation = {
        purpose: listing ? "reserve" : "build",
        key: listing ? "prepared-project-key" : "build-key",
      } as const;
      const details = {
        ...times,
        consumedAtMs: listing ? 5_000 : null,
        ...(listing ? { project } : {}),
      };
      const record = workerRecord({
        state: listing ? "idle" : "attached",
        attachedSessionIds: listing ? ["session-z", "session-a", "session-z", " "] : [],
        idleSinceAtMs: listing ? 6_000 : null,
        destroyRequestedAtMs: listing ? 9_000 : null,
        preparation: {
          ...preparation,
          ...details,
          ...(listing ? { project: privateProject } : {}),
        },
      });
      const service = workerService({
        list: vi.fn(() => (listing ? [record] : [])),
        get: vi.fn(() => record),
        readPreparedPoolSummary: vi.fn(() => pool),
        readReadyWorkerTarget: vi.fn((profileId) => (profileId === "aws" ? 2 : 0)),
      });
      const [ok, payload] = await callEnvironmentMethod(
        method,
        {
          ...(listing ? {} : { environmentId: "worker-1" }),
          includePreparedDetails: true,
        },
        { service, scopes: [scope] },
      );

      expect(ok).toBe(true);
      const summary: EnvironmentSummary = listing ? payload.environments.at(-1) : payload;
      expect(summary.trust).toBe("disposable");
      expect(summary.worker).toMatchObject({
        ageMs: 9_000,
        ...(listing ? { idleMs: 4_000, attachedSessionIds: ["session-a", "session-z"] } : {}),
      });
      for (const path of ["sshEndpoint", "worker.sshEndpoint", "worker.keyRef"]) {
        expect(summary).not.toHaveProperty(path);
      }
      expect(summary.preparation).toEqual({
        ...preparation,
        ...(includeDetails ? { details } : {}),
      });
      if (listing && includeDetails) {
        expect(summary.worker).toHaveProperty("destroyRequestedAtMs", 9_000);
      } else {
        expect(summary.worker).not.toHaveProperty("destroyRequestedAtMs");
      }
      if (listing) {
        expect(payload.profiles).toEqual([
          { id: "aws", providerId: "crabbox", ...(includeDetails ? { readyWorkers: 2 } : {}) },
          {
            id: "zeta",
            providerId: "static-ssh",
            ...(includeDetails ? { readyWorkers: 0 } : {}),
          },
        ]);
        if (includeDetails) {
          expect(payload.preparedPool).toEqual(pool);
        } else {
          expect(payload).not.toHaveProperty("preparedPool");
          expect(service.readReadyWorkerTarget).not.toHaveBeenCalled();
        }
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
        ...times,
        consumedAtMs: null,
        project: { label: "private-project", baseCommit: "a".repeat(40) },
      },
    });
    const service = workerService({ list: vi.fn(() => [worker]), get: vi.fn(() => worker) });
    const waitForDiscovery = async () => {
      entered.resolve();
      await release.promise;
      return undefined;
    };
    if (method === "environments.list") {
      vi.mocked(service.listMachineOptions).mockImplementation(waitForDiscovery);
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
      req: gatewayRequest(`prepared-details-${method}`, method, {
        includePreparedDetails: true,
        ...(method === "environments.status" ? { environmentId: worker.environmentId } : {}),
      }),
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
