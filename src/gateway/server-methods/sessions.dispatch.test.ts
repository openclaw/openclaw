import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import { createWorkerPlacementMoveService } from "../worker-environments/placement-move-service.js";
import { FORCED_WORKER_ABANDONMENT_ERROR } from "../worker-environments/placement-record.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import type { WorkerPlacementDispatchRequest } from "../worker-environments/service-contract.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
import {
  dispatchTestSessionId as sessionId,
  dispatchTestSessionKey as sessionKey,
  getDispatchTestMocks,
  getSessionDispatchHandler,
  invokeSessionDispatch as invoke,
  invokeSessionMove,
  invokeSessionReclaim,
  makeDispatchTestContext as makeContext,
  makeFailedPlacement as failedPlacementRecord,
  makeReclaimedPlacement as reclaimedPlacementRecord,
  makeSessionTarget as targetWithEntry,
} from "./sessions-dispatch.test-support.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const mocks = getDispatchTestMocks();
const originalPluginRegistry = getActivePluginRegistry();
const session = { sessionId, sessionKey, agentId: "main" };
const source = { generation: 4, environmentId: "environment-previous", ownerEpoch: 1 };
const worktree = { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: "/repo" };
const liveCloudError =
  "cloud worker environment must be stopped before redispatch; use Stop cloud worker";
const liveDeviceError =
  "device worker placement must be abandoned before redispatch; use Continue on Gateway";

function useWorktreeSession(
  entry: Partial<NonNullable<Parameters<typeof targetWithEntry>[0]>> = {},
  worktreePath?: string,
): void {
  mocks.resolveTarget.mockReturnValue(targetWithEntry({ sessionId, ...entry, worktree }));
  mocks.findLiveByOwner.mockReturnValue({
    id: "worktree-1",
    ownerKind: "session",
    ownerId: sessionKey,
    ...(worktreePath === undefined ? {} : { path: worktreePath }),
  });
}

function activePlacementRecord(): Extract<WorkerSessionPlacementRecord, { state: "active" }> {
  return {
    ...reclaimedPlacementRecord(),
    state: "active",
    terminalReason: null,
    terminalAtMs: null,
  };
}

function dispatchContext(
  dispatch: NonNullable<GatewayRequestContext["workerPlacementDispatchService"]>["dispatch"],
  overrides: Partial<GatewayRequestContext> = {},
): GatewayRequestContext {
  return makeContext({
    workerPlacementDispatchService: { dispatch },
    workerSessionPlacementService: { getMany: () => new Map() },
    ...overrides,
  });
}

function moveContext(
  move: NonNullable<GatewayRequestContext["workerPlacementDispatchService"]>["move"],
  placement?: WorkerSessionPlacementRecord,
  overrides: Partial<GatewayRequestContext> = {},
) {
  return makeContext({
    workerPlacementDispatchService: { dispatch: vi.fn(), move },
    workerSessionPlacementService: {
      getMany: () => new Map(placement ? [[sessionId, placement]] : []),
    },
    ...overrides,
  });
}

function projectProfileContext(
  dispatch: Parameters<typeof dispatchContext>[0],
  profile = "test",
  overrides: Partial<GatewayRequestContext> = {},
) {
  return dispatchContext(dispatch, {
    getRuntimeConfig: () => ({
      cloudWorkers: {
        profiles: { test: { provider: "fake" } },
        projectProfiles: { "github.com/acme/app": profile },
      },
    }),
    ...overrides,
  });
}

function watchPlacementChanges() {
  const changes = vi.fn();
  onTestFinished(
    sessionChanges.subscribe((change) => {
      // Exclude fixture writes and ownership publications; capture broadcaster receipts.
      if ("sessionKey" in change && change.agentId === undefined) {
        changes(change);
      }
    }),
  );
  return changes;
}

function expectSuccess(respond: unknown, payload: unknown) {
  expect(respond).toHaveBeenCalledWith(true, payload, undefined);
}

function expectMoved(respond: unknown, generation: number) {
  expectSuccess(respond, {
    ok: true,
    key: sessionKey,
    sessionId,
    placement: { state: "local", generation },
  });
}

function expectProjected(respond: unknown, placement: object) {
  expectSuccess(
    respond,
    expect.objectContaining({
      ok: true,
      key: sessionKey,
      sessionId,
      placement: expect.objectContaining(placement),
    }),
  );
}

function unavailableSubscribers(): never {
  throw new Error("session subscribers unavailable");
}

function expectDispatchError(
  respond: RespondFn,
  message: unknown,
  code: string = ErrorCodes.INVALID_REQUEST,
) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code, message }),
  );
}

async function expectRejectedDispatch(
  message: unknown,
  overrides: Partial<GatewayRequestContext> = {},
  params?: Parameters<typeof invoke>[1],
) {
  const dispatch = vi.fn();
  const respond = await invoke(dispatchContext(dispatch, overrides), params);
  expect(dispatch).not.toHaveBeenCalled();
  expectDispatchError(respond, message);
}

function reclaimActivePlacement(): WorkerSessionPlacementRecord {
  return { ...activePlacementRecord(), generation: 3, updatedAtMs: 1 };
}

function reclaimContext(
  placement: () => WorkerSessionPlacementRecord,
  reclaim: NonNullable<GatewayRequestContext["workerPlacementDispatchService"]>["reclaim"],
  overrides: Partial<GatewayRequestContext> = {},
) {
  return makeContext({
    ...overrides,
    workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
    workerSessionPlacementService: {
      getMany: () => new Map([[sessionId, placement()]]),
    },
  });
}

function expectReclaimed(respond: unknown, state = "reclaimed") {
  expectSuccess(
    respond,
    expect.objectContaining({ ok: true, placement: expect.objectContaining({ state }) }),
  );
}

describe("sessions.dispatch", () => {
  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry(), "sessions-dispatch-test", "default");
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      autoSelection: { providerIds: ["codex", "openai"] },
      cloudPlacement: {
        mode: "remote-exec",
        devicePlacement: {
          requiredNodeCommands: ["codex.exec-server.stdio.v1"],
          consumesWorkerSlot: false,
        },
      },
      supports: () => ({ supported: true, priority: 10 }),
      async runAttempt() {
        throw new Error("not used");
      },
    });
    vi.clearAllMocks();
    mocks.runCommandWithTimeout.mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    mocks.resolveTarget.mockReturnValue(targetWithEntry());
  });

  afterEach(() => {
    if (originalPluginRegistry) {
      setActivePluginRegistry(originalPluginRegistry, "sessions-dispatch-test-restore", "default");
    } else {
      resetPluginRuntimeStateForTest();
    }
  });

  it.each([
    { name: "unconfigured dispatcher", configured: false },
    { name: "missing session" },
    {
      name: "unconfigured profile",
      params: { profileId: "missing" },
      message: "cloud worker profile is not configured: missing",
    },
    {
      name: "blank profile",
      entry: { sessionId },
      params: { profileId: " " },
      message: "worker dispatch target is missing",
    },
    {
      name: "missing workspace",
      entry: { sessionId },
      message:
        "sessions.dispatch requires a session-owned worktree, repository workspace, or device folder",
    },
    {
      name: "archived session",
      entry: { sessionId, archivedAt: 2 },
      message: expect.stringContaining("archived"),
    },
  ])("rejects $name before dispatch", async ({ configured, entry, params, message }) => {
    mocks.resolveTarget.mockReturnValue(targetWithEntry(entry));
    const dispatch = vi.fn();
    const respond = await invoke(
      configured === false ? makeContext() : dispatchContext(dispatch),
      params,
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        ...(message === undefined ? {} : { message }),
      }),
    );
  });

  it.each([
    {
      name: "references an unknown profile",
      stdout: "https://github.com/acme/app.git\n",
      profile: "missing",
      message:
        "cloudWorkers.projectProfiles mapping github.com/acme/app references unconfigured profile missing",
    },
    { name: "has no matching mapping", stdout: "https://github.com/acme/other.git\n" },
    { name: "has no origin remote", stdout: "", code: 1 },
  ])("rejects project lookup: $name", async ({ stdout, code, profile, message }) => {
    useWorktreeSession({}, "/repo/worktree");
    mocks.runCommandWithTimeout.mockResolvedValue({ code: code ?? 0, stdout, stderr: "" });
    const dispatch = vi.fn();
    const respond = await invoke(projectProfileContext(dispatch, profile), {});
    expect(dispatch).not.toHaveBeenCalled();
    expectDispatchError(respond, message ?? "worker dispatch target is missing");
  });

  it("rejects unsupported remote-exec mode", async () => {
    mocks.resolveTarget.mockReturnValue(
      targetWithEntry({
        sessionId,
        worktree,
        agentRuntimeOverride: "codex",
        providerOverride: "openai",
        modelOverride: "model-test",
      }),
    );
    await expectRejectedDispatch(
      'runtime codex requires a cloud worker provider that supports remote-exec; choose a compatible provider, or select an agent/model route with agentRuntime.id "openclaw"',
      {
        workerEnvironmentService: {
          supportsExecutionMode: (_profileId: string, mode: "worker-turn" | "remote-exec") =>
            mode !== "remote-exec",
        } as never,
      },
    );
  });

  it.each([
    {
      name: "moves an abandoned session to the Gateway with exact-source CAS",
      placement: () => ({
        ...failedPlacementRecord(),
        recoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
      }),
      target: { kind: "gateway" },
      abandonSource: true,
      result: { state: "local", generation: 7 },
    },
    {
      name: "resolves a worker move through the canonical destination owner",
      placement: activePlacementRecord,
      target: { kind: "profile", profileId: "test", machineClass: "beast", os: "os-b" },
      result: { state: "active", generation: 12 },
    },
  ] as const)("$name", async ({ placement, target, result, ...options }) => {
    useWorktreeSession();
    const move = vi.fn().mockResolvedValue(result);
    const abandon = "abandonSource" in options ? { abandonSource: options.abandonSource } : {};
    const respond = await invokeSessionMove(moveContext(move, placement()), {
      expected: source,
      target,
      ...abandon,
    });
    expect(move).toHaveBeenCalledWith(
      { ...session, source, target, ...abandon },
      expect.any(Function),
      undefined,
    );
    expectSuccess(respond, { ok: true, key: sessionKey, sessionId, placement: result });
  });

  it.each([
    { state: "local", recoveryError: null, abandonSource: undefined },
    { state: "failed", recoveryError: "worker failed", abandonSource: true },
    { state: "failed", recoveryError: FORCED_WORKER_ABANDONMENT_ERROR, abandonSource: undefined },
  ] as const)("rejects $state move without abandonment retry", async (placementSource) => {
    mocks.resolveTarget.mockReturnValue(targetWithEntry({ sessionId }));
    const move = vi.fn();

    const respond = await invokeSessionMove(
      moveContext(move, { ...failedPlacementRecord(), ...placementSource } as never),
      {
        expected: source,
        target: { kind: "gateway" },
        ...(placementSource.abandonSource ? { abandonSource: true } : {}),
      },
    );

    expect(move).not.toHaveBeenCalled();
    expectDispatchError(respond, `session cannot move from placement ${placementSource.state}`);
  });

  it.each([
    ["fake", "failed", liveCloudError],
    ["device", "attached", liveDeviceError],
    ["unknown", "unavailable", liveCloudError],
  ])("rejects redispatch on live %s environment", async (providerId, state, message) => {
    mocks.resolveTarget.mockReturnValue(targetWithEntry({ sessionId }));
    await expectRejectedDispatch(message, {
      workerEnvironmentService: {
        readMachineShape: () => undefined,
        get: vi.fn(() => {
          if (state === "unavailable") {
            throw new Error("environment inventory unavailable");
          }
          return { state, leaseId: "lease-previous", ownerEpoch: 1, providerId };
        }),
        supportsExecutionMode: () => true,
      } as never,
      workerSessionPlacementService: {
        getMany: () => new Map([[sessionId, failedPlacementRecord()]]),
      },
    });
  });

  it("rejects runtimes without cloud placement", async () => {
    const runtimeId = "test-harness";
    const modelRef = "anthropic/claude-test";
    mocks.resolveTarget.mockReturnValue(
      targetWithEntry({
        sessionId,
        worktree,
        providerOverride: "anthropic",
        modelOverride: "claude-test",
      }),
    );
    await expectRejectedDispatch(expect.stringContaining(runtimeId), {
      getRuntimeConfig: () => ({
        cloudWorkers: {
          profiles: {
            test: { provider: "fake", region: "test", size: "small" },
          },
        },
        agents: {
          defaults: {
            models: {
              [modelRef]: { agentRuntime: { id: runtimeId } },
            },
          },
        },
      }),
    });
  });

  it("classifies workspace preflight as invalid request", async () => {
    useWorktreeSession();
    const dispatch = vi.fn().mockRejectedValue(
      Object.assign(new Error("Cloud workspace inventory exceeds its entry limit"), {
        code: "invalid_state",
      }),
    );

    const respond = await invoke(dispatchContext(dispatch));

    expectDispatchError(respond, "Cloud workspace inventory exceeds its entry limit");
  });

  it("dispatches a saved profile and projects placement", async () => {
    const profileId = "test";
    useWorktreeSession(
      {
        agentRuntimeOverride: "openclaw",
        permissionMode: "workspace",
        sessionRoot: "/repo/worktree",
      },
      "/repo/worktree",
    );
    const dispatchedPlacement: WorkerSessionPlacementRecord = {
      ...activePlacementRecord(),
      environmentId: "environment-1",
      generation: 5,
      activeOwnerEpoch: 2,
    };
    const provisioning: WorkerSessionPlacementRecord = {
      ...reclaimedPlacementRecord(),
      state: "provisioning",
      activeOwnerEpoch: null,
      workspaceBaseManifestRef: null,
      remoteWorkspaceDir: null,
      workerBundleHash: null,
      lastTranscriptAckCursor: null,
      lastLiveEventAckCursor: null,
      terminalReason: null,
      terminalAtMs: null,
    };
    const dispatch = vi.fn(
      async (
        _request: WorkerPlacementDispatchRequest,
        onTransition?: (placement: WorkerSessionPlacementRecord) => void,
      ) => {
        for (const state of [
          "requested",
          "provisioning",
          "syncing",
          "starting",
          "active",
        ] as const) {
          onTransition?.({ ...dispatchedPlacement, state } as WorkerSessionPlacementRecord);
        }
        return dispatchedPlacement;
      },
    );
    const context = projectProfileContext(dispatch, "test", {
      workerSessionPlacementService: { getMany: () => new Map([[sessionId, provisioning]]) },
    });
    const changes = watchPlacementChanges();
    const respond = await invoke(context, { profileId, machineClass: "large", os: "os-a" });
    expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        ...session,
        executionMode: "worker-turn",
        profileId,
        machineClass: "large",
        os: "os-a",
        devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
      }),
      expect.any(Function),
      undefined,
      undefined,
    );
    expect(changes.mock.calls).toEqual(Array.from({ length: 5 }, () => [{ sessionKey }]));
    expectProjected(respond, {
      state: "active",
      environmentId: "environment-1",
      activeOwnerEpoch: 2,
    });
  });
  it("requires admin before project-profile lookup", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        session: { store: state.statePath("sessions.json") },
        cloudWorkers: {
          profiles: { mapped: { provider: "fake" } },
          projectProfiles: { "github.com/acme/app": "mapped" },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      replaceSessionEntrySync(
        { agentId: "main", sessionKey, storePath: cfg.session.store },
        {
          sessionId,
          updatedAt: 1,
          providerOverride: "anthropic",
          modelOverride: "claude-test",
          worktree,
        },
      );
      mocks.resolveTarget.mockImplementation(resolveGatewaySessionStoreTargetInWorker);
      mocks.findLiveByOwner.mockReturnValue({
        id: "worktree-1",
        ownerKind: "session",
        ownerId: sessionKey,
        path: "/repo/worktree",
      });
      mocks.runCommandWithTimeout.mockResolvedValue({
        code: 0,
        stdout: "git@github.com:Acme/App.git\n",
        stderr: "",
      });
      const dispatch = vi.fn().mockResolvedValue(activePlacementRecord());
      const context = dispatchContext(dispatch, {
        getRuntimeConfig: () => cfg,
        logGateway: { warn: vi.fn() } as never,
      });
      const controller = new AbortController();
      const request = async (scope: "operator.write" | "operator.admin") => {
        const respond = vi.fn();
        await handleGatewayRequest({
          signal: controller.signal,
          req: {
            type: "req",
            id: `configured-default-${scope}`,
            method: "sessions.dispatch",
            params: { key: sessionKey },
          },
          respond,
          client: {
            connId: `conn-${scope}`,
            connect: {
              role: "operator",
              scopes: [scope],
              client: { id: "test", version: "1", platform: "test", mode: "test" },
              minProtocol: 1,
              maxProtocol: 1,
            },
          } as Parameters<typeof handleGatewayRequest>[0]["client"],
          isWebchatConnect: () => false,
          context,
          extraHandlers: { "sessions.dispatch": getSessionDispatchHandler() },
        });
        return respond;
      };

      const writeRespond = await request("operator.write");

      expect(writeRespond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.FORBIDDEN,
          details: {
            code: "MISSING_SCOPE",
            missingScope: "operator.admin",
            requiredScopes: ["operator.admin"],
          },
        }),
      );
      expect(mocks.resolveTarget).not.toHaveBeenCalled();
      expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();

      const adminRespond = await request("operator.admin");

      expect(mocks.runCommandWithTimeout).toHaveBeenCalledWith(
        ["git", "-C", "/repo/worktree", "config", "--get", "remote.origin.url"],
        { timeoutMs: 4_000, env: { GIT_NO_LAZY_FETCH: "1" } },
      );
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: "mapped" }),
        expect.any(Function),
        expect.any(Function),
        controller.signal,
      );
      expectProjected(adminRespond, { state: "active" });
    });
  });
  it.each([
    { name: "starts an active abandonment", joined: false },
    { name: "joins an exact draining abandonment retry", joined: true },
  ])("$name and returns the committed local placement", async ({ joined }) => {
    useWorktreeSession({ agentRuntimeOverride: "openclaw" });
    const active = activePlacementRecord();
    const draining = { ...active, state: "draining" as const, generation: 5 };
    const existing = joined ? draining : active;
    const local = {
      ...active,
      state: "local" as const,
      generation: 9,
      environmentId: null,
      activeOwnerEpoch: null,
      turnClaim: null,
    };
    const recordPlacementMoveError = vi.fn();
    const validateAbandonSource = vi.fn();
    const intent = {
      operationId: "move:v1:rpc-abandon",
      sessionId,
      source,
      target: { kind: "gateway" as const },
      abandonSource: true,
      lastError: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const moves = createWorkerPlacementMoveService({
      placements: {
        beginPlacementMove: async () => ({ intent, placement: draining, joined }),
        getWithMoveAsync: async () => ({ placement: existing, move: joined ? intent : undefined }),
        getPlacementMoveAsync: async () => (joined ? intent : undefined),
        recordPlacementMoveError,
      } as never,
      environments: { get: () => undefined },
      runMoveBarrier: async (params) => {
        const begun = await params.begin();
        if (params.sourceDisposition !== "abandon") {
          throw new Error("placement move interrupted");
        }
        return begun;
      },
      dispatch: vi.fn(),
      reclaimSource: vi.fn(),
      validateAbandonSource,
      abandonSource: vi.fn(async () => local as never),
      resolveDestination: vi.fn(),
    });

    const context = moveContext(moves.move, existing, {
      getSessionEventSubscriberConnIds: unavailableSubscribers,
    });
    const changes = watchPlacementChanges();
    const respond = await invokeSessionMove(context, {
      expected: source,
      target: { kind: "gateway" },
      abandonSource: true,
    });

    expectMoved(respond, 9);
    expect(validateAbandonSource).toHaveBeenCalledTimes(joined ? 0 : 1);
    expect(changes.mock.calls).toEqual([[{ sessionKey }], [{ sessionKey }]]);
    expect(recordPlacementMoveError).not.toHaveBeenCalled();
  });
  describe("sessions.reclaim", () => {
    beforeEach(() => useWorktreeSession());
    it.each([
      { name: "returns unchanged placement without publishing", changed: false },
      { name: "preserves committed reclaim when reporting fails", changed: true },
    ])("$name", async ({ changed }) => {
      const reclaimed = reclaimedPlacementRecord();
      const reclaim = vi.fn().mockResolvedValue(reclaimed);
      const context = reclaimContext(
        changed ? reclaimActivePlacement : () => reclaimed,
        reclaim,
        changed ? { getSessionEventSubscriberConnIds: unavailableSubscribers } : {},
      );
      const changes = watchPlacementChanges();
      const respond = await invokeSessionReclaim(context);
      expect(reclaim).toHaveBeenCalledWith(session, undefined);
      expectReclaimed(respond);
      expect(changes.mock.calls).toEqual(changed ? [[{ sessionKey }]] : []);
    });

    it("delegates failed-placement recovery to reclaim", async () => {
      const failed = {
        ...reclaimedPlacementRecord(),
        state: "failed",
        environmentId: null,
        activeOwnerEpoch: null,
        workspaceBaseManifestRef: null,
        remoteWorkspaceDir: null,
        workerBundleHash: null,
        recoveryError: "device worker is offline",
        terminalReason: "device worker is offline",
      } as WorkerSessionPlacementRecord;
      const local = {
        ...failed,
        state: "local",
        generation: failed.generation + 1,
        recoveryError: null,
        terminalReason: null,
        terminalAtMs: null,
      } as WorkerSessionPlacementRecord;
      const reclaim = vi.fn().mockResolvedValue(local);
      const recovery = { recoverToGateway: { expectedGeneration: failed.generation } };
      const respond = await invokeSessionReclaim(
        reclaimContext(() => failed, reclaim),
        undefined,
        recovery,
      );

      expect(reclaim).toHaveBeenCalledExactlyOnceWith({ ...session, ...recovery }, undefined);
      expectReclaimed(respond, "local");
    });

    it.each(["success", "persisted failure"] as const)("notifies on %s", async (outcome) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        let placement = reclaimActivePlacement();
        const reclaimError = new Error("worker teardown failed after committing placement");
        const reclaim = vi.fn(async () => {
          if (outcome === "persisted failure") {
            placement = {
              ...placement,
              state: "failed",
              generation: placement.generation + 1,
              updatedAtMs: placement.updatedAtMs + 1,
              recoveryError: reclaimError.message,
            } as WorkerSessionPlacementRecord;
            throw reclaimError;
          }
          placement = reclaimedPlacementRecord();
          return placement;
        });
        const context = reclaimContext(() => placement, reclaim, {
          broadcastToConnIds: vi.fn(),
          chatAbortControllers: new Map(),
          getSessionEventSubscriberConnIds: () => new Set(["another-client"]),
        });
        const cfg = context.getRuntimeConfig();
        setRuntimeConfigSnapshot(cfg, cfg);

        try {
          const changes = watchPlacementChanges();
          const respond = await invokeSessionReclaim(context);

          expect(respond).toHaveBeenCalledWith(
            outcome === "success",
            outcome === "success" ? expect.objectContaining({ ok: true }) : undefined,
            outcome === "success"
              ? undefined
              : expect.objectContaining({ message: reclaimError.message }),
          );
          await flushPendingSessionsChangedEvents(context);
          expect(context.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
            "sessions.changed",
            expect.objectContaining({ reason: "reclaim", sessionKey }),
            new Set(["another-client"]),
            expect.objectContaining({ agentId: "main", dropIfSlow: true }),
          );
          expect(changes).toHaveBeenCalledExactlyOnceWith({ sessionKey });
        } finally {
          await flushPendingSessionsChangedEvents(context);
        }
      });
    });
  });
});

describe("device-folder placement constraints", () => {
  beforeEach(() => {
    mocks.resolveTarget.mockReturnValue(
      targetWithEntry({
        sessionId,
        deviceFolder: { deviceId: "folder-node", path: "/existing/non-git" },
      }),
    );
  });
  it.each([{ autoDevice: true as const }, { deviceId: "other-node" }, { profileId: "test" }, {}])(
    "rejects unpinned dispatch %j",
    async (target) => {
      await expectRejectedDispatch(
        expect.stringContaining("dispatch explicitly to that device"),
        {},
        target,
      );
    },
  );
  it.each([false, true])("refuses Move/Continue on Gateway (abandon=%s)", async (abandon) => {
    const move = vi.fn();
    const respond = await invokeSessionMove(moveContext(move), {
      expected: { generation: 1, environmentId: "node-environment", ownerEpoch: 1 },
      target: { kind: "gateway" },
      ...(abandon ? { abandonSource: true as const } : {}),
    });
    expectDispatchError(respond, expect.stringContaining("cannot move or Continue on Gateway"));
    expect(move).not.toHaveBeenCalled();
  });
  it("refuses recovery onto the Gateway before reclaim", async () => {
    const reclaim = vi.fn();
    const respond = await invokeSessionReclaim(
      reclaimContext(reclaimActivePlacement, reclaim),
      undefined,
      { recoverToGateway: { expectedGeneration: 3 } },
    );
    expectDispatchError(respond, expect.stringContaining("recovery to Gateway is unavailable"));
    expect(reclaim).not.toHaveBeenCalled();
  });
});
