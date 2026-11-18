import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createGatewayPortalService } from "../portals/portal-service.js";
import * as httpListen from "../server/http-listen.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { createWorkerConnectionIdentity } from "./connection-identity.test-support.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import { createWorkerPortalToolExecutor } from "./worker-portal-tool-executor.js";

const SOURCE = {
  agentId: "main",
  sessionId: "source-session",
  sessionKey: "agent:main:dashboard:source",
  environmentId: "source-environment",
  ownerEpoch: 3,
};
const WORKER = { environmentId: SOURCE.environmentId, ownerEpoch: SOURCE.ownerEpoch };

const PORTAL = {
  id: "worker-source-4321",
  port: 4321,
  url: "http://127.0.0.1:54321/?openclaw_portal=test-token",
  publicUrl: "http://127.0.0.1:54321/",
  origin: "cloud-profile",
};
type PortalRequest = Parameters<ReturnType<typeof createWorkerPortalToolExecutor>>[0]["request"];

let root: string;
let placements: WorkerSessionPlacementStore;
let identity: WorkerConnectionIdentity;
let sourceClaim: Awaited<ReturnType<WorkerSessionPlacementStore["claimTurn"]>>;
let sourceEnvironmentEpoch: number;
let sourceNodeDeviceId: string | null;
let sourceSshEndpoint: { host: string } | null;
let execute: ReturnType<typeof createWorkerPortalToolExecutor>;
const portalOpen = vi.fn();
const portalList = vi.fn();
const portalWorkerList = vi.fn();
const portalClose = vi.fn();
const portalCarrierOpen = vi.fn();
const portalCarrierConnect = vi.fn();
const portalCarrierClose = vi.fn();
const portalChanged = vi.fn();
const carrier = { connect: portalCarrierConnect, close: portalCarrierClose };
let actualService: ReturnType<typeof createGatewayPortalService> | undefined;
const sourceAuthorities = new Map<
  string,
  Awaited<ReturnType<WorkerSessionPlacementStore["prepareTurnClaimAuthority"]>>
>();

async function claimTurn(claimId: string, runId: string) {
  const claim = await placements.claimTurn({
    agentId: SOURCE.agentId,
    sessionId: SOURCE.sessionId,
    sessionKey: SOURCE.sessionKey,
    claimId,
    runId,
    owner: { kind: "worker", ...WORKER },
  });
  await placements.authorizeWorkerTurnTools(claim, ["portal"]);
  return claim;
}

async function runPortal(
  request: Omit<PortalRequest, "toolCallId">,
  workerIdentity = identity,
  signal?: AbortSignal,
) {
  const claim = workerIdentity.turnClaim;
  if (!claim || claim.owner.kind !== "worker") {
    throw new Error("Missing worker turn claim");
  }
  const authority =
    sourceAuthorities.get(claim.claimId) ?? (await placements.prepareTurnClaimAuthority(claim));
  sourceAuthorities.set(claim.claimId, authority);
  return execute(
    {
      identity: workerIdentity,
      toolName: "portal",
      request: { toolCallId: "portal", ...request },
      signal,
    },
    { sessionId: claim.sessionId, turnClaim: { ...claim, owner: claim.owner } },
    () => {
      if (!authority.isCurrent()) {
        throw new Error("Worker source session placement changed");
      }
    },
  );
}

const openPortal = (
  workerIdentity = identity,
  signal?: AbortSignal,
  fields: Pick<PortalRequest, "title" | "path"> = {},
) => runPortal({ action: "open", port: 4321, ...fields }, workerIdentity, signal);

function useActualPortalService() {
  const httpServers: import("node:http").Server[] = [];
  const service = createGatewayPortalService({ httpBindHosts: ["127.0.0.1"], httpServers });
  portalOpen.mockImplementation(service.open);
  portalClose.mockImplementation(service.close);
  actualService = service;
  return { service, httpServers };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-portal-"));
  const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  placements = createWorkerSessionPlacementStore({ database });
  await advancePlacementFixtureToActive(placements, database, SOURCE, {
    ...WORKER,
    workspaceBaseManifestRef: `manifest-${SOURCE.sessionId}`,
    remoteWorkspaceDir: `/workspace/${SOURCE.sessionId}`,
  });
  sourceClaim = await claimTurn("source-claim", "source-run");
  sourceAuthorities.set(
    sourceClaim.claimId,
    await placements.prepareTurnClaimAuthority(sourceClaim),
  );
  identity = createWorkerConnectionIdentity(sourceClaim, {
    ...WORKER,
    sessionId: SOURCE.sessionId,
    protocolFeatures: ["worker-portal-v1"],
    credentialExpiresAtMs: Date.now() + 60_000,
  });
  portalOpen.mockReset().mockResolvedValue(PORTAL);
  portalList.mockReset().mockReturnValue([PORTAL]);
  portalWorkerList.mockReset().mockReturnValue([PORTAL]);
  portalClose.mockReset().mockResolvedValue(undefined);
  portalCarrierConnect.mockReset();
  portalCarrierClose.mockReset().mockResolvedValue(undefined);
  portalCarrierOpen.mockReset().mockResolvedValue(carrier);
  portalChanged.mockReset();
  sourceEnvironmentEpoch = SOURCE.ownerEpoch;
  sourceNodeDeviceId = "worker-node";
  sourceSshEndpoint = null;
  execute = createWorkerPortalToolExecutor({
    placements,
    portals: {
      getService: () =>
        ({
          open: portalOpen,
          list: portalList,
          listWorkerPortals: portalWorkerList,
          close: portalClose,
        }) as never,
      carrier: { open: portalCarrierOpen },
      onChanged: portalChanged,
    },
    environments: {
      get: (environmentId: string) =>
        environmentId === SOURCE.environmentId
          ? {
              state: "attached",
              environmentId: SOURCE.environmentId,
              ownerEpoch: sourceEnvironmentEpoch,
              attachedSessionIds: [SOURCE.sessionId],
              profileId: "cloud-profile",
              nodeDeviceId: sourceNodeDeviceId,
              sshEndpoint: sourceSshEndpoint,
            }
          : undefined,
    } as never,
  });
});

afterEach(async () => {
  await actualService?.closeAll();
  actualService = undefined;
  for (const authority of sourceAuthorities.values()) {
    authority.release();
  }
  sourceAuthorities.clear();
  vi.restoreAllMocks();
  await closeStateDatabaseForTest();
  await fs.rm(root, { recursive: true, force: true });
});

it("opens, lists, and closes node-backed worker portals through the authorized source turn", async () => {
  const opened = await openPortal(identity, undefined, { title: "Worker app", path: "/app" });

  expect(opened).toMatchObject({
    details: { id: "worker-source-4321", origin: "cloud-profile", port: 4321 },
    content: [
      {
        type: "text",
        text: expect.stringContaining("PUBLIC_URL=http://127.0.0.1:54321/ and PORT=4321"),
      },
      expect.any(Object),
    ],
  });
  expect(portalCarrierOpen).toHaveBeenCalledWith({ ...WORKER, remotePort: 4321 });
  expect(portalOpen).toHaveBeenCalledWith({
    targetPort: 4321,
    assertCurrent: expect.any(Function),
    target: {
      kind: "worker",
      ...WORKER,
      connect: portalCarrierConnect,
      remotePort: 4321,
    },
    onClose: portalCarrierClose,
    ownerSignal: undefined,
    resourceOwnerKey: undefined,
    origin: "cloud-profile",
    title: "Worker app",
    path: "/app",
  });

  const listed = await runPortal({ action: "list" });
  expect(listed.details).toHaveProperty("portals.length", 1);
  expect(portalWorkerList).toHaveBeenCalledWith(SOURCE.environmentId, SOURCE.ownerEpoch, undefined);

  const closed = await runPortal({ action: "close", id: PORTAL.id });
  expect(closed.details).toEqual({ closed: true });
  expect(portalClose).toHaveBeenCalledWith("worker-source-4321", expect.any(Function));
  expect(portalChanged).toHaveBeenCalledTimes(2);
});

it("never exposes local or other-worker portal bearer URLs to a delegated worker", async () => {
  portalList.mockReturnValue([
    ...portalWorkerList(),
    ...["local", "foreign"].map((scope) => ({
      id: `${scope}-portal`,
      url: `http://127.0.0.1:54322/?openclaw_portal=${scope}-secret`,
    })),
  ]);
  portalWorkerList.mockClear();

  const result = await runPortal({ action: "list" });

  expect(result.details).toHaveProperty("portals", [
    expect.objectContaining({ id: "worker-source-4321" }),
  ]);
  expect(JSON.stringify(result)).not.toContain("local-secret");
  expect(JSON.stringify(result)).not.toContain("foreign-secret");
  expect(portalList).not.toHaveBeenCalled();
  expect(portalWorkerList).toHaveBeenCalledWith(SOURCE.environmentId, SOURCE.ownerEpoch, undefined);
});

it("rejects attempts to close gateway-host or other-worker portals", async () => {
  for (const id of ["local-portal", "foreign-worker-portal"]) {
    await expect(runPortal({ action: "close", id })).rejects.toThrow(
      "Worker portal is not owned by the active environment",
    );
  }

  expect(portalClose).not.toHaveBeenCalled();
  expect(portalWorkerList).toHaveBeenCalledTimes(2);
});

it.each(["epoch", "cancel"] as const)(
  "releases a carrier after %s changes during preparation",
  async (change) => {
    const abort = new AbortController();
    portalCarrierOpen.mockImplementationOnce(async () => {
      if (change === "epoch") {
        sourceEnvironmentEpoch += 1;
      } else {
        abort.abort(new Error("portal cancelled"));
      }
      return carrier;
    });
    await expect(openPortal(identity, abort.signal)).rejects.toThrow(
      change === "epoch" ? "Worker source environment changed" : "portal cancelled",
    );
    expect(portalCarrierClose).toHaveBeenCalledOnce();
    expect(portalOpen).not.toHaveBeenCalled();
    expect(portalChanged).not.toHaveBeenCalled();
  },
);

it("retains the environment-owned portal when its source turn closes after publication", async () => {
  const { service, httpServers } = useActualPortalService();
  portalOpen.mockImplementationOnce(async (params) => {
    const portal = await service.open(params);
    await placements.releaseTurn(sourceClaim);
    return portal;
  });

  await expect(openPortal()).rejects.toThrow("Worker source session placement changed");

  expect(service.list()).toHaveLength(1);
  expect(httpServers[0]?.listening).toBe(true);
  expect(portalChanged).toHaveBeenCalledOnce();
  expect(portalCarrierClose).not.toHaveBeenCalled();
  await service.closeAll();
  expect(portalCarrierClose).toHaveBeenCalledOnce();
});

it("keeps the successor portal when the original open loses authority during listener startup", async () => {
  const actualListen = httpListen.listenGatewayHttpServer;
  const { promise: bindStarted, resolve: notifyBindStarted } = createDeferred();
  const { promise: bindReleased, resolve: releaseBind } = createDeferred();
  vi.spyOn(httpListen, "listenGatewayHttpServer").mockImplementation(async (params) => {
    notifyBindStarted();
    await bindReleased;
    await actualListen(params);
  });
  const { service, httpServers } = useActualPortalService();
  const successorOpening = createDeferred();
  portalOpen.mockImplementation((params) => {
    if (portalOpen.mock.calls.length === 2) {
      successorOpening.resolve();
    }
    return service.open(params);
  });
  const firstRejected = expect(openPortal()).rejects.toThrow(
    "Worker source session placement changed",
  );
  let successor: ReturnType<typeof runPortal> | undefined;
  try {
    await bindStarted;
    await placements.releaseTurn(sourceClaim);
    const turnClaim = await claimTurn("successor-claim", "successor-run");
    identity = { ...identity, runId: turnClaim.runId, turnClaim };
    successor = openPortal(identity, undefined, { title: "Successor app" });
    await successorOpening.promise;
    releaseBind();
    await firstRejected;
    const result = await successor;
    const [portal] = service.list();
    expect(service.list()).toEqual([expect.objectContaining({ title: "Successor app" })]);
    expect(result.details).toHaveProperty("id", portal?.id);
    expect(httpServers).toMatchObject([{ listening: true }]);
  } finally {
    releaseBind();
    await Promise.allSettled([firstRejected, successor]);
  }
});

it.each([
  ["epoch", "Worker source environment changed"],
  ["placement", "Worker source session placement changed"],
  ["SSH", "move the session back to the gateway with sessions.move"],
  ["tool", "Worker session tool authority changed"],
] as const)(
  "rejects invalid %s authority before preparing a carrier",
  async (boundary, message) => {
    let caller = identity;
    if (boundary === "epoch") {
      caller = { ...identity, ownerEpoch: SOURCE.ownerEpoch + 1 };
    }
    if (boundary === "placement") {
      await placements.releaseTurn(sourceClaim);
    }
    if (boundary === "SSH") {
      sourceNodeDeviceId = null;
      sourceSshEndpoint = { host: "worker.example" };
    }
    if (boundary === "tool") {
      await placements.authorizeWorkerTurnTools(sourceClaim, ["sessions_send"]);
    }
    await expect(openPortal(caller)).rejects.toThrow(message);
    expect(portalCarrierOpen).not.toHaveBeenCalled();
  },
);
