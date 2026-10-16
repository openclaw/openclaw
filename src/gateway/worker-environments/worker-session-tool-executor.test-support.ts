import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import { prepareCoreToolPolicy } from "../../agents/prepared-tool-surface.js";
import { createToolSurfacePresentationForTest } from "../../agents/tool-surface-plan.test-support.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import { createAvailablePortalTools } from "../../agents/tools/portal-tool.js";
import { createSessionsSendTool } from "../../agents/tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "../../agents/tools/sessions-spawn-tool.js";
import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { tryBeginGatewayRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import {
  bindWorkerTurnOwner,
  bindWorkerTurnCapabilities,
  getWorkerTurnToolSurface,
} from "./placement-turn-claim-events.js";
import { createWorkerGatewayToolRuntime } from "./worker-gateway-tool-runtime.js";
import {
  createWorkerGatewayTools,
  createWorkerSessionToolExecutor,
} from "./worker-session-tool-executor.js";
import { prepareWorkerAgentRuntimeIdentity } from "./worker-turn-payload.js";

const sharedMocks = vi.hoisted(() => ({
  sessionEntries: new Map<string, SessionEntry>(),
  sessionEntriesByStorePath: new Map<string, Map<string, SessionEntry>>(),
  sessionStorePaths: new Map<string, string>(),
  delivered: vi.fn(),
  gatewayRequest: vi.fn(),
  gatewayCreate: vi.fn(),
  gatewayRuntimeIdentity: vi.fn(),
  dispatchChild: vi.fn(),
  spawnCallerIdentity: vi.fn(),
  spawnArgs: vi.fn(),
  scopedSessionAccess: vi.fn(
    async (params: { targetSessionKey: string; run: () => Promise<unknown> }) => await params.run(),
  ),
}));

export function workerSessionToolTestMocks() {
  return sharedMocks;
}

vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  withSessionEntryReadOnlyInWorker: async (
    scope: { sessionKey: string; storePath?: string },
    assertCurrent: () => void,
    consume: (read: { ok: true; value: SessionEntry | undefined }) => Promise<unknown>,
  ) => {
    assertCurrent();
    const entries =
      sharedMocks.sessionEntriesByStorePath.get(scope.storePath ?? "") ??
      sharedMocks.sessionEntries;
    const result = await consume({
      ok: true,
      value: structuredClone(entries.get(scope.sessionKey)),
    });
    assertCurrent();
    return result;
  },
}));

vi.mock("../session-utils-store-worker.js", () => ({
  resolveGatewaySessionStoreTargetInWorker: async ({ key }: { key: string }) => ({
    agentId: parseAgentSessionKey(key)?.agentId,
    canonicalKey: key,
    storePath: "/configured/sessions.sqlite",
    readSource: {
      agentId: "main",
      path: sharedMocks.sessionStorePaths.get(key) ?? "/physical/session-owner.sqlite",
    },
    store: { [key]: structuredClone(sharedMocks.sessionEntries.get(key)) },
  }),
}));

vi.mock("../../agents/tools/sessions-send-tool.js", () => ({
  createSessionsSendTool: (options: unknown) => ({
    name: "sessions_send",
    label: "Session Send",
    description: "Send",
    parameters: {},
    execute: async (toolCallId: string, args: unknown) => {
      await sharedMocks.delivered({ args, options, toolCallId });
      return {
        content: [{ type: "text", text: "sent" }],
        details: { status: "ok" },
      };
    },
  }),
}));

vi.mock("../../agents/tools/sessions-spawn-tool.js", async () => {
  const { getGatewayToolCallerIdentity } =
    await import("../../agents/tools/gateway-caller-context.js");
  return {
    createSessionsSpawnTool: (options: {
      agentSessionKey: string;
      callGateway: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    }) => ({
      name: "sessions_spawn",
      label: "Sessions",
      description: "Spawn",
      parameters: {},
      execute: async (_toolCallId: string, args: { task: string; worktree?: boolean }) => {
        sharedMocks.spawnCallerIdentity(getGatewayToolCallerIdentity());
        sharedMocks.spawnArgs(args);
        const details = await options.callGateway("sessions.create", {
          parentSessionKey: options.agentSessionKey,
          task: args.task,
          ...(args.worktree ? { worktree: true } : {}),
        });
        return {
          content: [{ type: "text", text: "spawned" }],
          details,
        };
      },
    }),
  };
});

vi.mock("../../agents/tools/scoped-session-access.js", () => ({
  runWithScopedSessionAccess: (params: unknown) => sharedMocks.scopedSessionAccess(params as never),
}));

vi.mock("../../agents/tools/in-process-gateway.js", () => ({
  bindAgentToolGatewayRequest: () => (request: unknown) => sharedMocks.gatewayRequest(request),
  callAgentToolGatewayRequest: (request: unknown) => sharedMocks.gatewayRequest(request),
  callInProcessGatewayTool: (method: string, params: Record<string, unknown>) =>
    sharedMocks.gatewayRequest({ method, params }),
  callInProcessGatewayToolWithCreation: (
    method: string,
    params: Record<string, unknown>,
    creation: unknown,
    options: unknown,
  ) => sharedMocks.gatewayCreate({ creation, method, options, params }),
  withAgentToolGatewayRuntimeIdentity: (request: unknown, identity: unknown) => {
    sharedMocks.gatewayRuntimeIdentity(request, identity);
    return request;
  },
}));

function worker(name: string, ownerEpoch: number) {
  return {
    agentId: "main",
    sessionId: `${name}-session`,
    environmentId: `${name}-environment`,
    ownerEpoch,
  };
}
export const SOURCE = {
  ...worker("source", 3),
  sessionKey: "agent:main:dashboard:source",
};
export const TARGET = {
  ...worker("target", 4),
  sessionKey: "agent:main:dashboard:target",
};
export const PARENT = {
  sessionId: "parent-session",
  sessionKey: "agent:main:dashboard:parent",
};
export const CHILD = worker("spawned-child", 5);
export const GRANDCHILD = worker("spawned-grandchild", 6);
const CLOUD_PROFILE = {
  providerId: "fake",
  profileId: "cloud-profile",
  profileSnapshot: { install: "bundle" as const, settings: { region: "source" } },
};
export const PARENT_EXECUTION_IDENTITY_TOKEN = {
  tokenVersion: 1,
  contextId: "parent-context",
  executionId: "parent-execution",
  runId: "source-run",
  createdAt: 1,
} satisfies ExecutionIdentityAdmissionToken;

export const resolveGatewayContext = () => undefined;

type WorkerSessionToolTestMocks = typeof sharedMocks;

type WorkerSessionToolTestOptions = {
  admissionSource?: AdmittedRunContext["admissionSource"];
  collectExecutionIdentity?: boolean;
  operatorProfileId?: string;
  operatorScopes?: readonly string[];
  inheritedToolPolicySource?: "sender";
  delegatedToolPolicyActive?: boolean;
};

async function createWorkerSessionToolTestFixture(
  mocks: WorkerSessionToolTestMocks,
  options: WorkerSessionToolTestOptions,
) {
  const { sessionEntries, gatewayRequest, gatewayCreate, dispatchChild, scopedSessionAccess } =
    mocks;
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-tools-"),
  );
  const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  const cfg = {};
  setRuntimeConfigSnapshot(cfg);
  const placements = createWorkerSessionPlacementStore({ database });
  await activate(SOURCE);
  await activate(TARGET);
  const sourceClaim = await placements.claimTurn({
    sessionId: SOURCE.sessionId,
    agentId: SOURCE.agentId,
    sessionKey: SOURCE.sessionKey,
    claimId: "source-claim",
    runId: "source-run",
    owner: {
      kind: "worker",
      environmentId: SOURCE.environmentId,
      ownerEpoch: SOURCE.ownerEpoch,
    },
  });
  await placements.authorizeWorkerTurnTools(sourceClaim, ["sessions_send", "sessions_spawn"]);
  const delegatedAuthorities: AgentRunDelegatedAuthority[] = [];
  const sourceOperationalRun = createOperationalRunInstanceRef(sourceClaim.runId);
  let sourceRunActive = true;
  let operatorAuthorityActive = true;
  const assertSourceCurrent = () => assert(sourceRunActive, "source worker run ended");
  const sessionTarget = {
    agentId: SOURCE.agentId,
    sessionId: SOURCE.sessionId,
    sessionKey: SOURCE.sessionKey,
    storePath: path.join(root, "sessions.json"),
  };
  const scheduledAdmission = options.admissionSource
    ? prepareAgentRunAdmission({
        cfg,
        admissionSource: options.admissionSource,
        operationalRunInstance: sourceOperationalRun,
        assertSourceCurrent,
        facts: {
          runId: sourceClaim.runId,
          agentId: SOURCE.agentId,
          ingress: { kind: "system", boundary: "test.worker-presence-schedule", state: "present" },
        },
      })
    : undefined;
  if (!scheduledAdmission) {
    delegatedAuthorities.push(claimAgentRunDelegatedAuthority(sourceOperationalRun));
  }
  const rootAdmission = tryBeginGatewayRootWorkAdmission();
  assert(rootAdmission, "Worker fixture could not admit its parent turn");
  await rootAdmission.run(async () => {
    if (scheduledAdmission) {
      await prepareWorkerAgentRuntimeIdentity({
        agentId: SOURCE.agentId,
        sessionKey: SOURCE.sessionKey,
        sessionTarget,
        promptCacheContext: { boundaryCount: 0 },
        assertSourceCurrent,
        runtimeInstanceId: SOURCE.environmentId,
        placements,
        turnClaim: sourceClaim,
        turn: {
          agentId: SOURCE.agentId,
          sessionId: SOURCE.sessionId,
          sessionKey: SOURCE.sessionKey,
          sessionFile: path.join(root, "transcript.jsonl"),
          workspaceDir: root,
          prompt: "Who is online?",
          timeoutMs: 5_000,
          runId: sourceClaim.runId,
          preparedRunAdmission: scheduledAdmission,
        },
      });
      return;
    }
    await bindWorkerTurnOwner(
      placements,
      sourceClaim,
      options.collectExecutionIdentity !== false ? PARENT_EXECUTION_IDENTITY_TOKEN : undefined,
      sourceOperationalRun,
      sessionTarget,
      assertSourceCurrent,
      undefined,
      options.operatorProfileId
        ? createAdmittedRunOperatorAuthority({
            profileId: options.operatorProfileId,
            scopes: options.operatorScopes ?? ["operator.write"],
            assertCurrent: () =>
              assert(operatorAuthorityActive, "source operator authority revoked"),
          })
        : undefined,
    );
  });
  const identity: WorkerConnectionIdentity = {
    environmentId: SOURCE.environmentId,
    credentialHash: "credential-hash",
    bundleHash: "a".repeat(64),
    sessionId: SOURCE.sessionId,
    runId: sourceClaim.runId,
    turnClaim: sourceClaim,
    ownerEpoch: SOURCE.ownerEpoch,
    rpcSetVersion: 1,
    protocolFeatures: ["worker-gateway-tools-v1"],
    credentialExpiresAtMs: Date.now() + 60_000,
  };
  // Reset implementations and queued once overrides, not just call histories.
  for (const value of Object.values(mocks)) {
    if (typeof value === "function") {
      value.mockReset();
    } else {
      value.clear();
    }
  }
  scopedSessionAccess.mockImplementation(async (params) => await params.run());
  function configureSpawnTarget(
    owner: typeof CHILD,
    parent: { sessionKey: string; sessionId: string },
    runId: string,
  ) {
    const state: { childSessionKey: string | undefined; order: string[] } = {
      childSessionKey: undefined,
      order: [],
    };
    gatewayCreate.mockImplementation(
      async (request: { method: string; params: Record<string, unknown> }) => {
        state.order.push("create");
        state.childSessionKey = String(request.params.key);
        setEntry(state.childSessionKey, owner.sessionId, parent);
        return { ok: true, key: state.childSessionKey, sessionId: owner.sessionId };
      },
    );
    dispatchChild.mockImplementation(async (request: { sessionKey: string }) => {
      state.order.push("dispatch");
      expect(placements.get(owner.sessionId)).toBeUndefined();
      await activate({
        ...owner,
        sessionKey: request.sessionKey,
      });
      return placements.get(owner.sessionId);
    });
    gatewayRequest.mockImplementation(
      async (request: { method: string; params: Record<string, unknown> }) => {
        if (request.method === "agent") {
          state.order.push("send");
          expect(placements.get(owner.sessionId)?.state).toBe("active");
          return { runId, status: "accepted" };
        }
        throw new Error(`Unexpected gateway request: ${request.method}`);
      },
    );
    return state;
  }
  const spawnState = configureSpawnTarget(CHILD, SOURCE, "spawned-child-run");
  const executorParams: Parameters<typeof createWorkerSessionToolExecutor>[0] = {
    inheritedToolPolicySource: options.inheritedToolPolicySource,
    delegatedToolPolicyActive: options.delegatedToolPolicyActive,
    resolveGatewayContext,
    placements,
    dispatchChild,
    portals: {
      getService: () => undefined,
      carrier: { open: vi.fn() },
      onChanged: vi.fn(),
    },
    environments: {
      get: (environmentId: string) => {
        const owner = [SOURCE, CHILD, GRANDCHILD].find((s) => s.environmentId === environmentId);
        return owner
          ? {
              state: "attached",
              ownerEpoch: owner.ownerEpoch,
              attachedSessionIds: [owner.sessionId],
              ...structuredClone(CLOUD_PROFILE),
            }
          : undefined;
      },
    } as never,
  };
  const toolOptions = { agentSessionKey: SOURCE.sessionKey, workerPlacement: true };
  const ownerExecute = createWorkerSessionToolExecutor(executorParams, {
    sessions_spawn: createSessionsSpawnTool(toolOptions),
    sessions_send: createSessionsSendTool(toolOptions),
    portal: createAvailablePortalTools({
      sessionPortalTarget: {
        agentId: SOURCE.agentId,
        sessionKey: SOURCE.sessionKey,
        environmentId: SOURCE.environmentId,
        assertCurrent: () => {},
      },
    })[0]!,
  });
  const toolRuntimes: ReturnType<typeof createWorkerGatewayToolRuntime>[] = [];
  function createToolRuntime(
    runtimeOptions: Pick<
      Parameters<typeof createWorkerGatewayTools>[0],
      "prepareTools" | "skillWorkshop"
    > & {
      identity?: WorkerConnectionIdentity;
      inheritedPublicationToolRef?: { current?: AnyAgentTool };
    } = {},
  ) {
    const workerIdentity = runtimeOptions.identity ?? identity;
    const claim = workerIdentity.turnClaim;
    assert(claim, "Expected a claimed worker turn");
    const runtime = createWorkerGatewayToolRuntime({
      signal: new AbortController().signal,
      assertCurrent: () =>
        assert(
          getWorkerTurnToolSurface(workerIdentity) === runtime,
          "Worker tool surface owner changed",
        ),
      prepare: async () => ({
        policy: prepareCoreToolPolicy({}),
        presentation: createToolSurfacePresentationForTest(),
        tools: (
          await createWorkerGatewayTools({
            ...executorParams,
            ...runtimeOptions,
            identity: workerIdentity,
          })
        ).filter((tool) => placements.isWorkerTurnToolAuthorized(claim, tool.name)),
        inheritedPublicationTool: runtimeOptions.inheritedPublicationToolRef?.current,
      }),
    });
    bindWorkerTurnCapabilities(placements, claim, { toolSurface: runtime });
    toolRuntimes.push(runtime);
    return runtime;
  }
  createToolRuntime();
  const execute = async (request: Parameters<typeof ownerExecute>[0]) => ({
    resultJson: JSON.stringify(await ownerExecute(request)),
  });
  async function activate(session: {
    agentId: string;
    environmentId: string;
    ownerEpoch: number;
    sessionId: string;
    sessionKey: string;
  }): Promise<void> {
    await advancePlacementFixtureToActive(placements, database, session, {
      environmentId: session.environmentId,
      ownerEpoch: session.ownerEpoch,
      workspaceBaseManifestRef: `manifest-${session.sessionId}`,
      remoteWorkspaceDir: `/workspace/${session.sessionId}`,
    });
  }

  function setEntry(
    sessionKey: string,
    sessionId: string,
    parent?: { sessionKey: string; sessionId: string },
  ): void {
    sessionEntries.set(sessionKey, {
      sessionId,
      updatedAt: Date.now(),
      ...(parent ? { parentSessionKey: parent.sessionKey, parentSessionId: parent.sessionId } : {}),
    });
  }

  async function send(
    toolCallId: string,
    request: { sessionKey?: string; message?: string; timeoutSeconds?: number } = {},
  ) {
    return await execute({
      identity,
      toolName: "sessions_send",
      request: {
        toolCallId,
        sessionKey: TARGET.sessionKey,
        message: "status",
        timeoutSeconds: 0,
        ...request,
      },
    });
  }

  function spawn(toolCallId: string, task = "start the child") {
    return execute({ identity, toolName: "sessions_spawn", request: { toolCallId, task } });
  }

  return {
    root,
    placements,
    identity,
    execute,
    createToolRuntime,
    createTools: (
      skillWorkshop?: Parameters<typeof createWorkerGatewayTools>[0]["skillWorkshop"],
    ) => createWorkerGatewayTools({ ...executorParams, identity, skillWorkshop }),
    sourceClaim,
    delegatedAuthorities,
    closeSourceRun: () => {
      sourceRunActive = false;
      scheduledAdmission?.close();
    },
    revokeOperatorAuthority: () => {
      operatorAuthorityActive = false;
    },
    spawnState,
    configureSpawnTarget,
    activate,
    setEntry,
    send,
    spawn,
    async dispose() {
      await Promise.all(toolRuntimes.map((runtime) => runtime.close()));
      if (placements.validateTurnClaim(sourceClaim)) {
        await placements.closeWorkerTurnToolState(sourceClaim);
        await placements.releaseTurn(sourceClaim);
      }
      for (const authority of delegatedAuthorities) {
        releaseAgentRunDelegatedAuthority(authority);
      }
      scheduledAdmission?.close();
      rootAdmission.release();
      await closeOpenClawStateDatabaseByPathAsync(database.path);
      closeOpenClawStateDatabaseForTest();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export function installWorkerSessionToolTestFixture(
  mocks: WorkerSessionToolTestMocks,
  options: WorkerSessionToolTestOptions = {},
) {
  let fixture: Awaited<ReturnType<typeof createWorkerSessionToolTestFixture>>;
  beforeEach(async () => {
    fixture = await createWorkerSessionToolTestFixture(mocks, options);
  });
  afterEach(async () => {
    await fixture.dispose();
    clearRuntimeConfigSnapshot();
  });
  return () => fixture;
}
