import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ErrorCodes,
  type EnvironmentsListResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readDevicePairingNodeSnapshot } from "../../infra/device-pairing-store-readonly.js";
import { NODE_RUNNER_UPDATE_REQUIRED_ISSUE } from "../../infra/node-runner-inventory.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../../shared/node-desktop-stream.js";
import * as rfbProbe from "../desktop/rfb-probe.js";
import { collectNodeCatalogRuntimeState } from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import { summarizeWorkerEnvironment } from "../worker-environments/environment-summary.js";
import { environmentsHandlers } from "./environments.js";
import {
  callEnvironmentMethod as call,
  createDevicePairingNodeSnapshot,
  FakeWorkerServiceError,
  mockContext,
  pairedNodeDevice,
  workerRecord,
  workerService,
} from "./environments.test-support.js";
import { registerWorkerInferenceEnvironmentTests } from "./environments.worker-inference.suite.js";

vi.mock("../../infra/device-pairing-store-readonly.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/device-pairing-store-readonly.js")>()),
  readDevicePairingNodeSnapshot: vi.fn(),
}));

vi.mock("../node-registry-private.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../node-registry-private.js")>()),
  collectNodeCatalogRuntimeState: vi.fn(() => ({
    sessionHostNodeIds: new Set(),
    issuesByNodeId: new Map(),
    workerSlotsByNodeId: new Map(),
    workerBundleByNodeId: new Map(),
  })),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const NOW = 10_000;
const workerId = { environmentId: "worker-1" };
const createParams = { profileId: "development", idempotencyKey: "request-1" };
function rejectService(code: string, detail: string) {
  return vi.fn(async () => {
    throw new FakeWorkerServiceError(code, detail);
  });
}
let runtimeState: ReturnType<typeof collectNodeCatalogRuntimeState>;

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  runtimeState = {
    sessionHostNodeIds: new Set(),
    issuesByNodeId: new Map(),
    workerSlotsByNodeId: new Map(),
    workerBundleByNodeId: new Map(),
  };
  vi.mocked(collectNodeCatalogRuntimeState).mockReturnValue(runtimeState);
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

describe("environment gateway methods", () => {
  registerWorkerInferenceEnvironmentTests((prefix) => tempDirs.make(prefix));

  it("projects only the role-approved Cloud choices for native creation", async () => {
    const context = mockContext(workerService());
    const config = context.getRuntimeConfig();
    context.getRuntimeConfig = () => ({
      ...config,
      gateway: {
        roles: {
          default: "observer",
          definitions: {
            observer: { sessions: { others: "view" }, agents: [], scopes: ["operator.read"] },
            engineer: {
              sessions: { others: "view" },
              agents: ["main"],
              scopes: ["operator.read", "operator.write"],
              workerProfiles: ["aws"],
            },
          },
        },
      },
    });
    const read = async (role: "observer" | "engineer", write = role === "engineer") => {
      const respond = vi.fn();
      await environmentsHandlers["environments.list"]?.({
        params: { projection: "profiles" },
        respond,
        context,
        client: {
          authenticatedUserProfile: { profileId: "person" },
          preparedSessionProfile: { profileId: "person", aliases: new Set(["person"]), role },
          connect: {
            role: "operator",
            scopes: write ? ["operator.read", "operator.write"] : ["operator.read"],
          },
        },
      } as never);
      return respond.mock.calls[0]?.[1] as EnvironmentsListResult;
    };
    expect((await read("observer")).dispatchableProfileIds).toEqual([]);
    expect((await read("engineer", false)).dispatchableProfileIds).toEqual([]);
    const engineer = await read("engineer");
    expect(engineer.profiles?.map((profile) => profile.id)).toEqual(["aws", "zeta"]);
    expect(engineer.dispatchableProfileIds).toEqual(["aws"]);
  });
  it("probes disabled host setup only when requested without advertising or granting desktop access", async () => {
    const probe = vi.spyOn(rfbProbe, "probeRfbServer").mockResolvedValue({
      kind: "rfb",
      securityTypes: [30],
    });
    const [defaultOk, defaultPayload] = await call("environments.list", {});
    expect(defaultOk).toBe(true);
    expect(probe).not.toHaveBeenCalled();
    expect(defaultPayload).not.toHaveProperty("environments.0.desktopSetup");

    const [profilesOk, profilesPayload] = await call("environments.list", {
      projection: "profiles",
      includeDesktopSetup: true,
    });
    expect(profilesOk).toBe(true);
    expect(profilesPayload).toEqual({ environments: [] });
    expect(probe).not.toHaveBeenCalled();

    const [setupOk, setupPayload] = await call("environments.list", {
      includeDesktopSetup: true,
    });
    expect(setupOk).toBe(true);
    expect(setupPayload).toHaveProperty("environments.0.desktopSetup", { state: "ready" });
    expect(setupPayload).not.toHaveProperty("environments.0.desktop");
    expect(setupPayload).not.toHaveProperty("environments.1.desktopSetup");

    const observe = vi.fn();
    const respond = vi.fn();
    await environmentsHandlers["desktop.observe"]?.({
      params: { source: { kind: "host" } },
      respond,
      context: { ...mockContext(), hostDesktopService: { observe } },
    } as never);
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(observe).not.toHaveBeenCalled();
  });

  it("projects live and offline node facts consistently through list and status", async () => {
    const probe = vi.spyOn(rfbProbe, "probeRfbServer");
    runtimeState.sessionHostNodeIds.add("node-live");
    runtimeState.workerSlotsByNodeId.set("node-live", { total: 2, available: 1 });
    runtimeState.workerBundleByNodeId.set("node-live", {
      status: "installed",
      version: "2026.8.9",
    });
    runtimeState.issuesByNodeId.set("node-live", [NODE_RUNNER_UPDATE_REQUIRED_ISSUE]);
    vi.mocked(readDevicePairingNodeSnapshot).mockResolvedValue(
      createDevicePairingNodeSnapshot([
        pairedNodeDevice("node-live", { commands: ["system.run"] }),
        pairedNodeDevice(
          "node-never",
          { displayName: "Never Node", commands: ["system.run"] },
          { lastSeenAtMs: 2_000, lastSeenReason: "device-token-auth" },
        ),
        pairedNodeDevice(
          "node-lost",
          {
            displayName: "Lost Node",
            caps: ["screen"],
            commands: ["camera.snap"],
            sessionHost: true,
            lastConnectedAtMs: 1_000,
            lastDisconnectedAtMs: 4_000,
          },
          { lastSeenAtMs: 3_000, lastSeenReason: "silent_push" },
        ),
      ]),
    );
    const context = {
      ...mockContext(),
      getRuntimeConfig: () => ({
        desktop: { host: { enabled: true } },
        gateway: { nodes: { commands: { allow: [NODE_DESKTOP_STREAM_COMMAND] } } },
      }),
      nodeRegistry: Object.assign(new NodeRegistry(), {
        listConnectedForPairingStates: () => [
          {
            nodeId: "node-live",
            connId: "conn-live",
            client: { invalidated: false },
            displayName: "Live Node",
            platform: "ios",
            caps: ["camera"],
            commands: ["system.run"],
            connectedAtMs: 123,
            desktopAvailability: { state: "locked" },
          },
          {
            nodeId: "node-desktop",
            connId: "conn-desktop",
            client: { invalidated: false },
            platform: "linux",
            deviceFamily: "Linux",
            caps: [],
            commands: [NODE_DESKTOP_STREAM_COMMAND],
            connectedAtMs: 123,
          },
          {
            nodeId: "node-other",
            connId: "conn-other",
            client: { invalidated: false },
            caps: [],
            commands: [],
          },
        ],
      }),
    };
    const respond = vi.fn();
    await environmentsHandlers["environments.list"]?.({
      params: { includeDesktopSetup: true },
      respond,
      context,
    } as never);
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const payload: EnvironmentsListResult = respond.mock.calls[0]![1];
    const { environments } = payload;
    const find = (id: string) => environments.find((entry) => entry.id === id);
    expect(find("gateway")).toMatchObject({ type: "local", desktop: true, sessionHost: true });
    expect(probe).not.toHaveBeenCalled();
    expect(find("gateway")).not.toHaveProperty("desktopSetup");
    expect(find("node:node-live")).toMatchObject({
      status: "available",
      platform: "ios",
      sessionHost: true,
      trust: "persistent",
      capabilities: ["camera", "system.run"],
      lastConnectedAtMs: 123,
      lastSeenAtMs: 123,
      lastSeenReason: "connect",
      desktopAvailability: { state: "locked" },
      workerSlots: { total: 2, available: 1 },
      workerBundle: { status: "installed", version: "2026.8.9" },
      issues: [NODE_RUNNER_UPDATE_REQUIRED_ISSUE],
    });
    expect(find("node:node-desktop")).toHaveProperty("desktop", true);
    expect(find("node:node-never")).toMatchObject({
      status: "unavailable",
      lastSeenAtMs: 2_000,
      lastSeenReason: "device-token-auth",
      sessionHost: false,
    });
    expect(find("node:node-never")).not.toHaveProperty("lastConnectedAtMs");
    expect(find("node:node-lost")).toMatchObject({
      status: "unavailable",
      sessionHost: true,
      lastConnectedAtMs: 1_000,
      lastDisconnectedAtMs: 4_000,
      lastSeenAtMs: 3_000,
      lastSeenReason: "silent_push",
      capabilities: ["camera.snap", "screen"],
    });
    for (const entry of environments.filter((candidate) => candidate.id !== "node:node-live")) {
      expect(entry).not.toHaveProperty("desktopAvailability");
      expect(entry).not.toHaveProperty("workerSlots");
      expect(entry).not.toHaveProperty("issues");
    }
    expect(find("node:node-other")).not.toHaveProperty("desktop");
    expect(find("node:node-lost")).not.toHaveProperty("desktop");
    for (const environmentId of ["node:node-live", "node:node-lost"]) {
      respond.mockClear();
      await environmentsHandlers["environments.status"]?.({
        params: { environmentId },
        respond,
        context,
      } as never);
      expect(respond).toHaveBeenCalledWith(true, find(environmentId), undefined);
    }
  });

  it("discovers profile catalogs independently of inventories and preserves provider identity", async () => {
    const machine = {
      id: "standard",
      label: "Standard",
      cpu: 32,
      memoryGb: 64,
      default: true,
      os: "os-a",
    };
    const systems = [
      { id: "os-a", label: "OS A", default: true },
      { id: "os-b", label: "OS B" },
    ];
    const service = workerService({
      readProviderDisplayId: vi.fn((id) => (id === "aws" ? "azure" : undefined)),
      listMachineOptions: vi.fn(async (id) => (id === "aws" ? [machine] : undefined)),
      listOperatingSystems: vi.fn(async (id) => (id === "aws" ? systems : [systems[0]!])),
      supportsExecutionMode: vi.fn((id, mode) => id === "aws" || mode === "remote-exec"),
    });
    vi.mocked(readDevicePairingNodeSnapshot).mockClear();
    const [ok, payload] = await call(
      "environments.list",
      { projection: "profiles", includePreparedDetails: true },
      { service, scopes: ["operator.admin"] },
    );
    expect(ok).toBe(true);
    expect(payload).toEqual({
      environments: [],
      profiles: [
        {
          id: "aws",
          providerId: "crabbox",
          providerDisplayId: "azure",
          executionMode: "worker-turn",
          executionModes: ["worker-turn", "remote-exec"],
          machines: [machine],
          operatingSystems: systems,
          readyWorkers: 1,
        },
        {
          id: "zeta",
          providerId: "static-ssh",
          executionMode: "remote-exec",
          executionModes: ["remote-exec"],
          readyWorkers: 1,
        },
      ],
    });
    expect(service.list).not.toHaveBeenCalled();
    expect(service.readPreparedPoolSummary).not.toHaveBeenCalled();
    expect(readDevicePairingNodeSnapshot).not.toHaveBeenCalled();
    expect(service.create).not.toHaveBeenCalled();
  });

  it.each([
    ["failed", "static-ssh", "node-live", false],
    ["orphaned", "static-ssh", undefined, true],
    ["destroyed", "static-ssh", "node-live", true],
    ["ready", "device", "node-live", true],
  ] as const)(
    "preserves pairing ownership for %s %s workers bound to %s",
    async (state, providerId, nodeDeviceId, visible) => {
      const service = workerService({
        list: vi.fn(() => [
          workerRecord({ state, providerId, nodeDeviceId, error: "provider failure" }),
        ]),
      });
      const [ok, payload] = await call("environments.list", {}, { service });
      expect(ok).toBe(true);
      const { environments } = payload as EnvironmentsListResult;
      expect(environments.some((entry) => entry.id === "node:node-live")).toBe(visible);
      const worker = environments.find((entry) => entry.id === "worker-1");
      expect(worker).toMatchObject({ type: "worker", worker: { state, providerId } });
      if (state === "failed" || state === "orphaned") {
        expect(worker).toMatchObject({ status: "error", worker: { error: "provider failure" } });
      } else {
        expect(worker?.worker).not.toHaveProperty("error");
        expect(worker?.status).toBe(state === "ready" ? "available" : "unavailable");
      }
    },
  );

  it("fails closed and redacts worker inventory read failures", async () => {
    const secret = "private SecretRef and database path";
    const fail = () => {
      throw new Error(secret);
    };
    const listFailure = workerService({ list: vi.fn(fail) });
    const listResult = await call("environments.list", {}, { service: listFailure });
    const nodeResult = await call(
      "environments.status",
      { environmentId: "node:node-live" },
      { service: listFailure },
    );
    const workerResult = await call(
      "environments.status",
      { environmentId: "missing" },
      { service: workerService({ get: vi.fn(fail) }) },
    );
    const error = {
      code: ErrorCodes.UNAVAILABLE,
      message: "Error: environment inventory unavailable",
    };
    expect(listResult).toEqual([false, undefined, error]);
    expect(nodeResult).toEqual([false, undefined, error]);
    expect(workerResult).toEqual([
      false,
      undefined,
      { code: ErrorCodes.UNAVAILABLE, message: "environment status unavailable" },
    ]);
    expect(JSON.stringify([listResult, nodeResult, workerResult])).not.toContain(secret);
  });

  it("projects trust from recorded worker isolation without guessing unknown leases", () => {
    expect(summarizeWorkerEnvironment(workerRecord({ sharedHost: true }), NOW).trust).toBe(
      "persistent",
    );
    expect(summarizeWorkerEnvironment(workerRecord({ sharedHost: false }), NOW).trust).toBe(
      "disposable",
    );
    expect(summarizeWorkerEnvironment(workerRecord({ sharedHost: null }), NOW)).not.toHaveProperty(
      "trust",
    );
  });

  it("rejects unknown environment ids", async () => {
    const [ok, , error] = await call("environments.status", {
      environmentId: "missing",
    });

    expect(ok).toBe(false);
    expect(error).toEqual({
      code: ErrorCodes.INVALID_REQUEST,
      message: "unknown environmentId",
    });
  });

  it("keeps worker creation unavailable until a provider profile is configured", async () => {
    const [ok, , error] = await call("environments.create", createParams);

    expect(ok).toBe(false);
    expect(error).toEqual({
      code: ErrorCodes.INVALID_REQUEST,
      message: "cloud worker environments are not configured",
    });
  });

  it("creates a worker from a configured profile", async () => {
    const create = vi.fn(async () =>
      workerRecord({ desktopAvailable: true, desktopApps: ["browser", "terminal"] }),
    );
    const service = workerService({ create });
    const [ok, payload] = await call("environments.create", createParams, { service });

    expect(ok).toBe(true);
    expect(create).toHaveBeenCalledWith("development", "request-1");
    expect(payload).toMatchObject({
      id: "worker-1",
      type: "worker",
      desktop: true,
      worker: {
        providerId: "static-ssh",
        state: "ready",
        desktop: true,
        desktopApps: ["browser", "terminal"],
      },
    });
  });

  it("hides provider failure details when worker creation fails", async () => {
    const service = workerService({
      create: rejectService("provider_failure", "private endpoint details"),
    });
    const [ok, , error] = await call("environments.create", createParams, { service });

    expect(ok).toBe(false);
    expect(error).toEqual({
      code: ErrorCodes.UNAVAILABLE,
      message: "worker environment creation failed",
    });
  });

  it("maps desktop lifecycle errors to invalid request and hides runtime failures", async () => {
    for (const [code, message] of [
      ["invalid_state", "environment has no desktop"],
      ["provider_failure", "worker desktop observe unavailable"],
    ] as const) {
      const detail = code === "invalid_state" ? message : "private SSH failure";
      const service = workerService({ observeDesktop: rejectService(code, detail) });
      const result = await call("worker.desktop.observe", workerId, { service });
      expect(result).toEqual([
        false,
        undefined,
        {
          code: code === "invalid_state" ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
          message,
        },
      ]);
    }
  });

  it("launches only a closed advertised desktop app and returns readiness", async () => {
    const launchDesktopApp = vi.fn(async ({ app }: { app: "browser" | "terminal" }) => ({
      app,
      status: "ready" as const,
    }));
    const service = workerService({ launchDesktopApp });
    const result = await call(
      "worker.desktop.launch",
      { environmentId: "worker-1", app: "browser" },
      { service },
    );

    expect(result).toEqual([true, { app: "browser", status: "ready" }, undefined]);
    expect(launchDesktopApp).toHaveBeenCalledExactlyOnceWith({
      environmentId: "worker-1",
      app: "browser",
    });
    const rejected = await call(
      "worker.desktop.launch",
      { environmentId: "worker-1", app: "editor" },
      { service },
    );
    expect(rejected[0]).toBe(false);
    expect(launchDesktopApp).toHaveBeenCalledOnce();
  });

  it("maps typed desktop launcher errors without exposing unknown runtime details", async () => {
    const detail = "actionable launcher error";
    const cases = [
      ["desktop_app_not_found", ErrorCodes.INVALID_REQUEST, detail],
      ["unsupported_platform", ErrorCodes.INVALID_REQUEST, detail],
      ["launcher_failure", ErrorCodes.UNAVAILABLE, detail],
      [
        "provider_failure",
        ErrorCodes.UNAVAILABLE,
        "worker desktop app launch unavailable; try again",
      ],
    ] as const;
    for (const [serviceCode, gatewayCode, message] of cases) {
      const service = workerService({
        launchDesktopApp: rejectService(
          serviceCode,
          serviceCode === "provider_failure" ? "private SSH detail" : detail,
        ),
      });
      const response = await call(
        "worker.desktop.launch",
        { environmentId: "worker-1", app: "browser" },
        { service },
      );
      expect(response[2]).toEqual({ code: gatewayCode, message });
    }
  });

  it("rejects raw destruction of a session-attached worker", async () => {
    const service = workerService({
      destroyUnattached: rejectService(
        "invalid_state",
        "Attached cloud workers must be stopped through sessions.reclaim",
      ),
    });

    const [ok, , error] = await call("environments.destroy", workerId, { service });

    expect(ok).toBe(false);
    expect(error).toEqual({
      code: ErrorCodes.INVALID_REQUEST,
      message: "Attached cloud workers must be stopped through sessions.reclaim",
    });
  });

  it("logs best-effort forced teardown errors without failing the call", async () => {
    const service = workerService();
    const forceDestroyEnvironment = vi.fn(
      async (_environmentId: string, onCleanupError?: (error: unknown) => void) => {
        onCleanupError?.(new Error("provider stop remains pending"));
        return workerRecord({ state: "destroying" });
      },
    );
    const context = mockContext(
      service,
      vi.fn(async () => {}),
      forceDestroyEnvironment,
    );
    const respond = vi.fn();

    await environmentsHandlers["environments.destroy"]?.({
      params: { environmentId: "worker-1", force: true },
      respond,
      context,
    } as never);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ worker: expect.objectContaining({ state: "destroying" }) }),
      undefined,
    );
    expect(context.logGateway.warn).toHaveBeenCalledWith(
      "worker environment forced teardown cleanup failed: Error: provider stop remains pending",
    );
    expect(forceDestroyEnvironment).toHaveBeenCalledExactlyOnceWith(
      "worker-1",
      expect.any(Function),
    );
    expect(service.destroy).not.toHaveBeenCalled();
    expect(service.destroyUnattached).not.toHaveBeenCalled();
  });

  it("preserves destroyed worker success when placement reconciliation fails", async () => {
    const service = workerService();
    const reconcileActive = vi.fn(async () => {
      throw new Error("temporary reconciliation failure");
    });

    const [ok, payload] = await call("environments.destroy", workerId, {
      service,
      reconcileActive,
    });

    expect(ok).toBe(true);
    expect(payload).toMatchObject({ worker: { state: "destroyed" } });
    expect(reconcileActive).toHaveBeenCalledExactlyOnceWith("worker-1");
    expect(service.destroyUnattached).toHaveBeenCalledBefore(reconcileActive);
  });
});
