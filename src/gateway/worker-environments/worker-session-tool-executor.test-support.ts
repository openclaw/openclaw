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
import { createWorkerConnectionIdentity } from "./connection-identity.test-support.js";
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

vi.mock("../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-entry-read-runtime.js")>()),
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

vi.mock("../../agents/tools/scoped-session-access.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/tools/scoped-session-access.js")>()),
  runWithScopedSessionAccess: (params: unknown) => sharedMocks.scopedSessionAccess(params as never),
}));

vi.mock("../../agents/tools/in-process-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/tools/in-process-gateway.js")>()),
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
  sourceSession?: typeof SOURCE;
  admissionSource?: AdmittedRunContext["admissionSource"];
  collectExecutionIdentity?: boolean;
  operatorProfileId?: string;
  operatorScopes?: readonly string[];
  inheritedToolPolicySource?: "sender";
  delegatedToolPolicyActive?: boolean;
};

export async function createWorkerSessionToolTestFixture(
  mocks: WorkerSessionToolTestMocks,
  options: WorkerSessionToolTestOptions,
) {
  const source = options.sourceSession ?? SOURCE;
  const { sessionEntries, gatewayRequest, gatewayCreate, dispatchChild, scopedSessionAccess } =
    mocks;
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-tools-"),
  );
  const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  const cfg = {};
  setRuntimeConfigSnapshot(cfg);
  const placements = createWorkerSessionPlacementStore({ database });
  await activate(source);
  await activate(TARGET);
  const sourceClaim = await placements.claimTurn({
    sessionId: source.sessionId,
    agentId: source.agentId,
    sessionKey: source.sessionKey,
    claimId: "source-claim",
    runId: "source-run",
    owner: {
      kind: "worker",
      environmentId: source.environmentId,
      ownerEpoch: source.ownerEpoch,
    },
  });
  await placements.authorizeWorkerTurnTools(sourceClaim, ["sessions_send", "sessions_spawn"]);
  const delegatedAuthorities: AgentRunDelegatedAuthority[] = [];
  const sourceOperationalRun = createOperationalRunInstanceRef(sourceClaim.runId);
  let sourceRunActive = true;
  let operatorAuthorityActive = true;
  const assertSourceCurrent = () => assert(sourceRunActive, "source worker run ended");
  const sessionTarget = {
    agentId: source.agentId,
    sessionId: source.sessionId,
    sessionKey: source.sessionKey,
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
          agentId: source.agentId,
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
        agentId: source.agentId,
        sessionKey: source.sessionKey,
        sessionTarget,
        promptCacheContext: { boundaryCount: 0 },
        assertSourceCurrent,
        runtimeInstanceId: source.environmentId,
        placements,
        turnClaim: sourceClaim,
        turn: {
          agentId: source.agentId,
          sessionId: source.sessionId,
          sessionKey: source.sessionKey,
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
  const identity: WorkerConnectionIdentity = createWorkerConnectionIdentity(sourceClaim, {
    protocolFeatures: ["worker-gateway-tools-v1"],
    credentialExpiresAtMs: Date.now() + 60_000,
  });
  // Reset implementations and queued once overrides, not just call histories.
  for (const value of Object.values(mocks)) {
    if (typeof value === "function") {
      value.mockReset();
    } else {
      value.clear();
    }
  }
  scopedSessionAccess.mockImplementation(async (params) => await params.run());
  const spawnState: { childSessionKey: string | undefined; order: string[] } = {
    childSessionKey: undefined,
    order: [],
  };
  gatewayCreate.mockImplementation(
    async (request: { method: string; params: Record<string, unknown> }) => {
      spawnState.order.push("create");
      spawnState.childSessionKey = String(request.params.key);
      setEntry(spawnState.childSessionKey, CHILD.sessionId, source);
      return { ok: true, key: spawnState.childSessionKey, sessionId: CHILD.sessionId };
    },
  );
  dispatchChild.mockImplementation(async (request: { sessionKey: string }) => {
    spawnState.order.push("dispatch");
    expect(placements.get(CHILD.sessionId)).toBeUndefined();
    await activate({ ...CHILD, sessionKey: request.sessionKey });
    return placements.get(CHILD.sessionId);
  });
  gatewayRequest.mockImplementation(async (request: { method: string }) => {
    if (request.method !== "agent") {
      throw new Error(`Unexpected gateway request: ${request.method}`);
    }
    spawnState.order.push("send");
    expect(placements.get(CHILD.sessionId)?.state).toBe("active");
    return { runId: "spawned-child-run", status: "accepted" };
  });
  const executorParams: Parameters<typeof createWorkerSessionToolExecutor>[0] = {
    inheritedToolPolicySource: options.inheritedToolPolicySource,
    delegatedToolPolicyActive: options.delegatedToolPolicyActive,
    resolveGatewayContext,
    placements,
    dispatchChild,
    waitForInitialPlacement: async () => {
      throw new Error("Unexpected initial placement wait");
    },
    portals: {
      getService: () => undefined,
      carrier: { open: vi.fn() },
      onChanged: vi.fn(),
    },
    environments: {
      get: (environmentId: string) => {
        const owner = [source, CHILD, GRANDCHILD].find((s) => s.environmentId === environmentId);
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
  const toolOptions = { agentSessionKey: source.sessionKey, workerPlacement: true };
  const ownerExecute = createWorkerSessionToolExecutor(executorParams, {
    sessions_spawn: createSessionsSpawnTool(toolOptions),
    sessions_send: createSessionsSendTool(toolOptions),
    portal: createAvailablePortalTools({
      sessionPortalTarget: {
        agentId: source.agentId,
        sessionKey: source.sessionKey,
        environmentId: source.environmentId,
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
      additionalInheritedToolNamesRef?: string[];
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
        additionalInheritedToolNames: runtimeOptions.additionalInheritedToolNamesRef,
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
  async function activate(session: typeof SOURCE): Promise<void> {
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
    database,
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
