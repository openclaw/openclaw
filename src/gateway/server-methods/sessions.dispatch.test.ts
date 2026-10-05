import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createWorkerPlacementMoveService } from "../worker-environments/placement-move-service.js";
import { FORCED_WORKER_ABANDONMENT_ERROR } from "../worker-environments/placement-record.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import {
  dispatchTestSessionId as sessionId,
  dispatchTestSessionKey as sessionKey,
  getDispatchTestMocks,
  getSessionDispatchHandler,
  invokeSessionDispatch as invoke,
  invokeSessionMove,
  makeDispatchTestContext as makeContext,
  makeFailedPlacement as failedPlacementRecord,
  makeReclaimedPlacement as reclaimedPlacementRecord,
  makeSessionTarget as targetWithEntry,
} from "./sessions-dispatch.test-support.js";
import { registerSessionReclaimCases } from "./sessions-reclaim.test-harness.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const mocks = getDispatchTestMocks();
const originalPluginRegistry = getActivePluginRegistry();

function useWorktreeSession(
  entry: Partial<NonNullable<Parameters<typeof targetWithEntry>[0]>> = {},
  worktreePath?: string,
): void {
  mocks.resolveTarget.mockReturnValue(
    targetWithEntry({
      sessionId,
      ...entry,
      worktree: { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: "/repo" },
    }),
  );
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
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
  };
}

function dispatchContext(
  dispatch: NonNullable<GatewayRequestContext["workerPlacementDispatchService"]>["dispatch"],
): GatewayRequestContext {
  return makeContext({
    workerPlacementDispatchService: { dispatch },
    workerSessionPlacementService: { getMany: () => new Map() },
  });
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
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ ok: true, placement: expect.objectContaining({ state }) }),
    undefined,
  );
}

describe("sessions.dispatch", () => {
  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry(), "sessions-dispatch-test", "default");
    const codexHarness: AgentHarness = {
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
    };
    registerAgentHarness(codexHarness);
    vi.clearAllMocks();
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "",
    });
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
      message: "sessions.dispatch requires a session-owned worktree or repository workspace",
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

  it("rejects a per-project mapping to an unknown profile as invalid", async () => {
    useWorktreeSession({}, "/repo/worktree");
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: "https://github.com/acme/app.git\n",
      stderr: "",
    });
    const dispatch = vi.fn();

    const respond = await invoke(
      makeContext({
        getRuntimeConfig: () => ({
          cloudWorkers: {
            profiles: { test: { provider: "fake" } },
            projectProfiles: { "github.com/acme/app": "missing" },
          },
        }),
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
      {},
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message:
          "cloudWorkers.projectProfiles mapping github.com/acme/app references unconfigured profile missing",
      }),
    );
  });

  it.each([
    ["has no matching mapping", { code: 0, stdout: "https://github.com/acme/other.git\n" }],
    ["has no origin remote", { code: 1, stdout: "" }],
  ])("keeps explicit-profile behavior when the worktree %s", async (_label, gitResult) => {
    useWorktreeSession({}, "/repo/worktree");
    mocks.runCommandWithTimeout.mockResolvedValue({ ...gitResult, stderr: "" });
    const dispatch = vi.fn();

    const respond = await invoke(
      makeContext({
        getRuntimeConfig: () => ({
          cloudWorkers: {
            profiles: { test: { provider: "fake" } },
            projectProfiles: { "github.com/acme/app": "test" },
          },
        }),
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
      {},
    );

    expect(dispatch).not.toHaveBeenCalled();
    expectDispatchError(respond, "worker dispatch target is missing");
  });

  it.each([["codex", "openai", "remote-exec"]] as const)(
    "rejects %s before allocation when its profile does not support the selected mode",
    async (runtime, provider, executionMode) => {
      mocks.resolveTarget.mockReturnValue(
        targetWithEntry({
          sessionId,
          agentRuntimeOverride: runtime,
          providerOverride: provider,
          modelOverride: "model-test",
          worktree: { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: "/repo" },
        }),
      );
      const dispatch = vi.fn();
      const respond = await invoke(
        makeContext({
          workerEnvironmentService: {
            supportsExecutionMode: (_profileId: string, mode: "worker-turn" | "remote-exec") =>
              mode !== executionMode,
          } as never,
          workerPlacementDispatchService: { dispatch },
          workerSessionPlacementService: { getMany: () => new Map() },
        }),
      );

      expect(dispatch).not.toHaveBeenCalled();
      expectDispatchError(
        respond,
        `runtime ${runtime} requires a cloud worker provider that supports ${executionMode}; choose a compatible provider, or select an agent/model route with agentRuntime.id "openclaw"`,
      );
    },
  );

  it("dispatches codex sessions through SSH without requiring node command allowlisting", async () => {
    useWorktreeSession({
      agentRuntimeOverride: "codex",
      providerOverride: "openai",
      modelOverride: "gpt-test",
    });
    const dispatch = vi.fn<
      NonNullable<GatewayRequestContext["workerPlacementDispatchService"]>["dispatch"]
    >(async (_request, _onTransition, authorize) => {
      authorize?.();
      throw new Error("remote dispatch reached");
    });
    const respond = await invoke(
      makeContext({
        workerEnvironmentService: {
          supportsExecutionMode: (_profileId: string, mode: "worker-turn" | "remote-exec") =>
            mode === "remote-exec",
        } as never,
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: "remote-exec",
        devicePlacement: {
          requiredNodeCommands: ["codex.exec-server.stdio.v1"],
          consumesWorkerSlot: false,
        },
      }),
      expect.any(Function),
      expect.any(Function),
      undefined,
    );
    expectDispatchError(respond, "remote dispatch reached", ErrorCodes.UNAVAILABLE);
  });

  it("moves an abandoned session back to the Gateway with exact-source CAS", async () => {
    useWorktreeSession();
    const move = vi.fn().mockResolvedValue({ state: "local", generation: 7 });
    const source = { generation: 4, environmentId: "environment-previous", ownerEpoch: 1 };
    const placement = {
      ...failedPlacementRecord(),
      recoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
    };

    const respond = await invokeSessionMove(
      makeContext({
        workerPlacementDispatchService: { dispatch: vi.fn(), move } as never,
        workerSessionPlacementService: {
          getMany: () => new Map([[sessionId, placement]]),
        },
      }),
      {
        expected: source,
        target: { kind: "gateway" },
        abandonSource: true,
      },
    );

    expect(move).toHaveBeenCalledWith(
      {
        sessionId,
        sessionKey,
        agentId: "main",
        source,
        target: { kind: "gateway" },
        abandonSource: true,
      },
      expect.any(Function),
      undefined,
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        ok: true,
        key: sessionKey,
        sessionId,
        placement: { state: "local", generation: 7 },
      },
      undefined,
    );
  });

  it("resolves a worker move through the canonical destination owner", async () => {
    useWorktreeSession();
    const move = vi.fn().mockResolvedValue({ state: "active", generation: 12 });

    await invokeSessionMove(
      makeContext({
        workerPlacementDispatchService: { dispatch: vi.fn(), move } as never,
        workerSessionPlacementService: {
          getMany: () => new Map([[sessionId, activePlacementRecord()]]),
        },
      }),
      {
        expected: { generation: 4, environmentId: "environment-previous", ownerEpoch: 1 },
        target: { kind: "profile", profileId: "test", machineClass: "beast", os: "os-b" },
      },
    );

    expect(move).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "profile", profileId: "test", machineClass: "beast", os: "os-b" },
      }),
      expect.any(Function),
      undefined,
    );
  });

  it.each([
    { state: "local", recoveryError: null, abandonSource: undefined },
    { state: "failed", recoveryError: "worker failed", abandonSource: true },
    { state: "failed", recoveryError: FORCED_WORKER_ABANDONMENT_ERROR, abandonSource: undefined },
  ] as const)(
    "rejects a $state move without an explicit forced-abandonment retry",
    async (source) => {
      mocks.resolveTarget.mockReturnValue(targetWithEntry({ sessionId }));
      const move = vi.fn();

      const respond = await invokeSessionMove(
        makeContext({
          workerPlacementDispatchService: { dispatch: vi.fn(), move } as never,
          workerSessionPlacementService: {
            getMany: () =>
              new Map([[sessionId, { ...failedPlacementRecord(), ...source } as never]]),
          },
        }),
        {
          expected: { generation: 4, environmentId: "environment-previous", ownerEpoch: 1 },
          target: { kind: "gateway" },
          ...(source.abandonSource ? { abandonSource: true } : {}),
        },
      );

      expect(move).not.toHaveBeenCalled();
      expectDispatchError(respond, `session cannot move from placement ${source.state}`);
    },
  );

  it.each([2, 3])(
    "redispatches a reclaimed session with correlated identity (environment epoch: %s)",
    async (ownerEpoch) => {
      useWorktreeSession();
      const dispatchedPlacement: WorkerSessionPlacementRecord = {
        ...activePlacementRecord(),
        environmentId: "environment-2",
        generation: 5,
        activeOwnerEpoch: 2,
      };
      const dispatch = vi.fn<
        NonNullable<GatewayRequestContext["workerPlacementDispatchService"]>["dispatch"]
      >(async (_request, _onTransition, authorize) => {
        authorize?.();
        return dispatchedPlacement;
      });
      const context = makeContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: {
          getMany: () => new Map([[sessionId, reclaimedPlacementRecord()]]),
        },
      });
      vi.spyOn(context.workerEnvironmentService!, "get").mockReturnValue({
        environmentId: "environment-2",
        providerId: "fake",
        profileId: "test",
        leaseId: "lease-2",
        sharedHost: false,
        state: "attached",
        ownerEpoch,
        createdAtMs: 1,
        idleSinceAtMs: null,
        destroyRequestedAtMs: null,
        attachedSessionIds: [sessionId],
        desktopAvailable: false,
        desktopApps: [],
        tunnelStatus: "stopped",
      });
      const respond = await invoke(context);

      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          sessionKey,
          agentId: "main",
          profileId: "test",
        }),
        expect.any(Function),
        expect.any(Function),
        undefined,
      );
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          placement: expect.objectContaining({
            state: "active",
            environmentId: "environment-2",
            generation: 5,
            ...(ownerEpoch === 2 ? { providerId: "fake", profileId: "test" } : {}),
          }),
        }),
        undefined,
      );
      if (ownerEpoch !== 2) {
        const payload = vi.mocked(respond).mock.calls[0]?.[1];
        expect(payload).not.toHaveProperty("placement.providerId");
        expect(payload).not.toHaveProperty("placement.profileId");
      }
    },
  );

  it.each(["gone", "retainable"] as const)(
    "allows a failed placement to redispatch when its source is %s",
    async (source) => {
      useWorktreeSession();
      const dispatch = vi.fn().mockResolvedValue({
        ...reclaimedPlacementRecord(),
        state: "active",
        environmentId: "environment-next",
        generation: 6,
        activeOwnerEpoch: 2,
        recoveryError: null,
      });
      const getEnvironment = vi.fn(() =>
        source === "gone"
          ? undefined
          : { state: "orphaned", leaseId: "lease-previous", ownerEpoch: 1, providerId: "crabbox" },
      );

      const respond = await invoke(
        makeContext({
          workerEnvironmentService: {
            get: getEnvironment,
            supportsExecutionMode: () => true,
          } as never,
          workerPlacementDispatchService: {
            dispatch,
            canRecoverFailedPlacement: () => source === "retainable",
          },
          workerSessionPlacementService: {
            getMany: () => new Map([[sessionId, failedPlacementRecord()]]),
          },
        }),
      );

      if (source === "gone") {
        expect(getEnvironment).toHaveBeenCalledWith("environment-previous");
      }
      expect(dispatch).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ placement: expect.objectContaining({ state: "active" }) }),
        undefined,
      );
    },
  );

  it.each([
    [
      "fake",
      "failed",
      "cloud worker environment must be stopped before redispatch; use Stop cloud worker",
    ],
    [
      "device",
      "attached",
      "device worker placement must be abandoned before redispatch; use Continue on Gateway",
    ],
    [
      "unknown",
      "unavailable",
      "cloud worker environment must be stopped before redispatch; use Stop cloud worker",
    ],
  ])(
    "rejects failed-placement redispatch while its %s environment remains live",
    async (providerId, state, message) => {
      mocks.resolveTarget.mockReturnValue(targetWithEntry({ sessionId }));
      const dispatch = vi.fn();

      const respond = await invoke(
        makeContext({
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
          workerPlacementDispatchService: { dispatch },
          workerSessionPlacementService: {
            getMany: () => new Map([[sessionId, failedPlacementRecord()]]),
          },
        }),
      );

      expect(dispatch).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.INVALID_REQUEST,
          message,
        }),
      );
    },
  );

  it("rejects sessions assigned to a runtime without cloud placement support", async () => {
    const runtimeId = "test-harness";
    const modelRef = "anthropic/claude-test";
    mocks.resolveTarget.mockReturnValue(
      targetWithEntry({
        sessionId,
        providerOverride: "anthropic",
        modelOverride: "claude-test",
        worktree: { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: "/repo" },
      }),
    );
    const dispatch = vi.fn();
    const respond = await invoke(
      makeContext({
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
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
    );

    expect(dispatch).not.toHaveBeenCalled();
    expectDispatchError(respond, expect.stringContaining(runtimeId));
  });

  it("classifies workspace preflight rejection as an invalid request", async () => {
    useWorktreeSession();
    const dispatch = vi.fn().mockRejectedValue(
      Object.assign(new Error("Cloud workspace inventory exceeds its entry limit"), {
        code: "invalid_state",
      }),
    );

    const respond = await invoke(dispatchContext(dispatch));

    expectDispatchError(respond, "Cloud workspace inventory exceeds its entry limit");
  });

  it("delegates a provisioning managed-worktree session and projects placement", async () => {
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
    const dispatch = vi.fn<
      NonNullable<GatewayRequestContext["workerPlacementDispatchService"]>["dispatch"]
    >(async (_request, onTransition, authorize) => {
      authorize?.();
      for (const state of ["requested", "provisioning", "syncing", "starting", "active"] as const) {
        authorize?.();
        onTransition?.({ ...dispatchedPlacement, state } as WorkerSessionPlacementRecord);
      }
      return dispatchedPlacement;
    });
    const context = makeContext({
      getRuntimeConfig: () => ({
        cloudWorkers: {
          profiles: { test: { provider: "fake" }, mapped: { provider: "fake" } },
          projectProfiles: { "github.com/acme/app": "mapped" },
        },
      }),
      getSessionEventSubscriberConnIds: () => new Set(),
      workerPlacementDispatchService: { dispatch },
      workerSessionPlacementService: { getMany: () => new Map([[sessionId, provisioning]]) },
    });
    const changes = vi.fn();
    onTestFinished(sessionChanges.subscribe(changes));
    const respond = await invoke(context, { profileId: "test", machineClass: "large", os: "os-a" });
    expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        sessionKey,
        agentId: "main",
        executionMode: "worker-turn",
        profileId: "test",
        machineClass: "large",
        os: "os-a",
        devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
      }),
      expect.any(Function),
      expect.any(Function),
      undefined,
    );
    expect(changes.mock.calls).toEqual(Array.from({ length: 5 }, () => [{ sessionKey }]));
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        key: sessionKey,
        sessionId,
        placement: expect.objectContaining({
          state: "active",
          environmentId: "environment-1",
          activeOwnerEpoch: 2,
        }),
      }),
      undefined,
    );
  });
  it("keeps explicit Cloud dispatch inside the write role's live profile grant", async () => {
    useWorktreeSession(
      { createdActor: { type: "human", source: "profile", id: "engineer-profile" } },
      "/repo/worktree",
    );
    let allowedProfiles = ["test"];
    const dispatch = vi
      .fn<NonNullable<GatewayRequestContext["workerPlacementDispatchService"]>["dispatch"]>()
      .mockResolvedValue(activePlacementRecord());
    const context = makeContext({
      getRuntimeConfig: () => ({
        cloudWorkers: { profiles: { test: { provider: "fake" }, other: { provider: "fake" } } },
        gateway: {
          roles: {
            default: "observer",
            definitions: {
              observer: { sessions: { others: "view" }, agents: [], scopes: ["operator.read"] },
              engineer: {
                sessions: { others: "write" },
                agents: ["main"],
                scopes: ["operator.read", "operator.write"],
                workerProfiles: allowedProfiles,
              },
            },
          },
        },
      }),
      workerPlacementDispatchService: { dispatch },
      workerSessionPlacementService: { getMany: () => new Map() },
    });
    const request = async (scope: "operator.read" | "operator.write", profileId: string) => {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: `dispatch-${scope}-${profileId}`,
          method: "sessions.dispatch",
          params: { key: sessionKey, profileId },
        },
        respond,
        client: {
          connId: `conn-${scope}-${profileId}`,
          authenticatedUserProfile: {
            profileId: "engineer-profile",
            displayName: null,
            hasAvatar: false,
            updatedAt: 1,
          },
          preparedSessionProfile: {
            profileId: "engineer-profile",
            aliases: new Set(["engineer-profile"]),
            role: "engineer",
          },
          connect: {
            role: "operator",
            scopes: [scope],
            client: { id: "test", version: "1", platform: "test", mode: "test" },
            minProtocol: 1,
            maxProtocol: 1,
          },
        },
        isWebchatConnect: () => false,
        context,
        extraHandlers: { "sessions.dispatch": getSessionDispatchHandler() },
      });
      return respond;
    };
    for (const [scope, profile] of [
      ["operator.read", "test"],
      ["operator.write", "other"],
    ] as const) {
      const denied = await request(scope, profile);
      expect(denied).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
      );
      expect(dispatch).not.toHaveBeenCalled();
    }
    const allowed = await request("operator.write", "test");
    expect(allowed).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "test", runSetupScript: false }),
      expect.any(Function),
      expect.any(Function),
      undefined,
    );

    useWorktreeSession(
      { createdActor: { type: "human", source: "profile", id: "other-profile" } },
      "/repo/worktree",
    );
    const foreign = await request("operator.write", "test");
    expect(foreign).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
    );
    expect(dispatch).toHaveBeenCalledOnce();
    useWorktreeSession(
      { createdActor: { type: "human", source: "profile", id: "engineer-profile" } },
      "/repo/worktree",
    );

    const effect = vi.fn();
    dispatch.mockImplementationOnce(async (_target, _onTransition, authorize) => {
      allowedProfiles = [];
      authorize?.();
      effect();
      return activePlacementRecord();
    });
    const revoked = await request("operator.write", "test");
    expect(revoked).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
    );
    expect(effect).not.toHaveBeenCalled();
  });

  it("requires admin before resolving a configured project profile", async () => {
    useWorktreeSession({}, "/repo/worktree");
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: "git@github.com:Acme/App.git\n",
      stderr: "",
    });
    const dispatch = vi.fn().mockResolvedValue(activePlacementRecord());
    const context = makeContext({
      getRuntimeConfig: () => ({
        cloudWorkers: {
          profiles: { mapped: { provider: "fake" } },
          projectProfiles: { "github.com/acme/app": "mapped" },
        },
      }),
      logGateway: { warn: vi.fn() } as never,
      workerPlacementDispatchService: { dispatch },
      workerSessionPlacementService: { getMany: () => new Map() },
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
      { timeoutMs: 4_000 },
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "mapped" }),
      expect.any(Function),
      expect.any(Function),
      controller.signal,
    );
    expect(adminRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        key: sessionKey,
        sessionId,
        placement: expect.objectContaining({ state: "active" }),
      }),
      undefined,
    );
  });
  it.each([
    { name: "starts an active abandonment", joined: false },
    { name: "joins an exact draining abandonment retry", joined: true },
  ])("$name and returns the committed local placement", async ({ joined }) => {
    useWorktreeSession({ agentRuntimeOverride: "openclaw" });
    const source = { generation: 4, environmentId: "environment-previous", ownerEpoch: 1 };
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
        beginPlacementMove: () => ({ intent, placement: draining, joined }),
        get: () => existing,
        getPlacementMove: () => (joined ? intent : undefined),
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

    const context = makeContext({
      getSessionEventSubscriberConnIds: () => {
        throw new Error("session subscribers unavailable");
      },
      workerPlacementDispatchService: { dispatch: vi.fn(), move: moves.move } as never,
      workerSessionPlacementService: {
        getMany: () => new Map([[sessionId, existing]]),
      },
    });
    const changes = vi.fn();
    onTestFinished(
      sessionChanges.subscribe((change) => {
        // Placement ownership also publishes qualified changes; these are the broadcaster receipts.
        if ("sessionKey" in change && change.agentId === undefined) {
          changes(change);
        }
      }),
    );
    const respond = await invokeSessionMove(context, {
      expected: source,
      target: { kind: "gateway" },
      abandonSource: true,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        ok: true,
        key: sessionKey,
        sessionId,
        placement: { state: "local", generation: 9 },
      },
      undefined,
    );
    expect(validateAbandonSource).toHaveBeenCalledTimes(joined ? 0 : 1);
    expect(changes.mock.calls).toEqual([[{ sessionKey }], [{ sessionKey }]]);
    expect(recordPlacementMoveError).not.toHaveBeenCalled();
  });
  registerSessionReclaimCases({
    useWorktreeSession,
    reclaimActivePlacement,
    reclaimContext,
    expectReclaimed,
  });
});
